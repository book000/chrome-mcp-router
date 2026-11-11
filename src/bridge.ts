import { execSync, type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { isValidBrowserUrl, resolveProject } from './config'
import { HealthMonitor } from './health-monitor'

interface JsonRpcBase {
  jsonrpc: '2.0'
}

/** JSON-RPC request */
interface JsonRpcRequest extends JsonRpcBase {
  id: number | string
  method: string
  params?: unknown
}

/** JSON-RPC response */
interface JsonRpcResponse extends JsonRpcBase {
  id: number | string
  result?: unknown
  error?: unknown
}

/** JSON-RPC notification (no id) */
interface JsonRpcNotification extends JsonRpcBase {
  method: string
  params?: unknown
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

/**
 * Validates that a JSON.parse result is a JSON-RPC message
 *
 * Requires the jsonrpc field to be '2.0' and a request, response, or notification shape.
 * @param data Unvalidated data from JSON.parse
 * @returns The message if valid, otherwise null
 */
function parseJsonRpcMessage(data: unknown): JsonRpcMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null
  }
  const obj = data as Record<string, unknown>
  if (obj.jsonrpc !== '2.0') {
    return null
  }
  // Request: has method and id
  // Response: has id and no method
  // Notification: has method and no id
  const hasId =
    'id' in obj &&
    (typeof obj.id === 'number' || typeof obj.id === 'string')
  const hasMethod = 'method' in obj && typeof obj.method === 'string'
  return hasId || hasMethod ? (data as JsonRpcMessage) : null
}

/**
 * Checks whether a JSON-RPC message is a request (has both id and method)
 *
 * Responses also have an id, so `'id' in msg` alone cannot tell requests from responses;
 * the presence of method is what distinguishes them.
 * @param msg The JSON-RPC message to check
 * @returns true if the message is a request
 */
function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'id' in msg && 'method' in msg
}

/**
 * Checks whether a JSON-RPC message is a response (has an id and no method)
 * @param msg The JSON-RPC message to check
 * @returns true if the message is a response
 */
function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg)
}

/**
 * Parses a JSON string and validates it as a JSON-RPC message without throwing
 * @param line The JSON string to parse
 * @returns The JsonRpcMessage, or null if parsing or validation fails
 */
function tryParseJsonRpcLine(line: string): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parseJsonRpcMessage(parsed)
  } catch {
    return null
  }
}

/** Options for initializing a Bridge */
export interface BridgeOptions {
  /** Chrome remote debugging URL */
  browserUrl: string
  /**
   * Project name given by `--project`
   *
   * When set, config.json is re-read periodically to re-resolve browserUrl.
   * Leave undefined when `--browserUrl` is given directly; no re-resolution happens then.
   */
  projectName?: string
  /** Flags passed through to chrome-devtools-mcp as is */
  passthroughArgs: string[]
  /** Called when stdin is closed */
  onExit?: () => void
}

const MAX_PENDING_QUEUE_SIZE = 500

/**
 * stdio proxy bridge for chrome-devtools-mcp
 *
 * Sits between the MCP client and chrome-devtools-mcp (the child process):
 * MCP client <-> Bridge <-> chrome-devtools-mcp.
 * When Chrome crashes and comes back, it restarts the child and replays the MCP handshake.
 */
export class Bridge {
  private browserUrl: string
  private readonly projectName?: string
  private readonly passthroughArgs: string[]
  private readonly healthMonitor: HealthMonitor
  private readonly onExit?: () => void

  private child: ChildProcess | null = null
  private childAlive = false

  private reconnecting = false

  /** Timer that periodically checks the child and browserUrl and recovers */
  private recoveryTimer: ReturnType<typeof setInterval> | null = null

  /** Buffered initialize request from the client (replayed on reconnect) */
  private initRequest: string | null = null
  /** id of the initialize request (used to suppress the duplicate response to the client) */
  private initRequestId: number | string | null = null
  /** Buffered notifications/initialized message from the client (replayed on reconnect) */
  private initializedNotif: string | null = null

  /** Messages received from the client during a reconnection */
  private pendingQueue: string[] = []

  /** Whether the bridge is waiting for the initialize response from the child */
  private waitingForInitResponse = false
  /** Called when the initialize response is received */
  private initResponseCallback: (() => void) | null = null

  /**
   * Cached result of resolving the chrome-devtools-mcp launch command
   *
   * Runs chrome-devtools-mcp directly if it is in PATH, otherwise falls back to npx.
   * Resolved on the first spawnChild() and reused afterwards.
   */
  private resolvedCmd: { cmd: string; baseArgs: string[] } | null = null

  constructor(options: BridgeOptions) {
    this.browserUrl = options.browserUrl
    this.projectName = options.projectName
    this.passthroughArgs = options.passthroughArgs
    this.onExit = options.onExit
    this.healthMonitor = new HealthMonitor(this.browserUrl)
  }

  /**
   * Starts the bridge
   *
   * Starts the Chrome health monitor, spawns the child process, and starts proxying stdin.
   */
  start(): void {
    this.healthMonitor.addEventListener('reconnected', () => {
      process.stderr.write(
        '[bridge] Chrome restart detected. Restarting child process\n'
      )
      this.handleChromeReconnected().catch((error: unknown) => {
        process.stderr.write(
          `[bridge] Error during reconnection: ${String(error)}\n`
        )
      })
    })

    // When Chrome first becomes reachable, start the child if it is not running
    // (covers Chrome being down at startup and coming up later)
    this.healthMonitor.addEventListener('connected', () => {
      if (this.childAlive || this.reconnecting) {
        return
      }
      process.stderr.write(
        '[bridge] Chrome became available. Starting child process\n'
      )
      this.handleChromeReconnected().catch((error: unknown) => {
        process.stderr.write(
          `[bridge] Error during initial connection: ${String(error)}\n`
        )
      })
    })

    this.healthMonitor.addEventListener('disconnected', () => {
      process.stderr.write('[bridge] Chrome disconnected\n')
    })

    this.healthMonitor.start()

    // Periodically detect and recover from Chrome being up while the child is dead
    // (e.g. stuck after a premature reconnect)
    this.recoveryTimer = setInterval(() => {
      if (this.projectName) {
        this.checkForBrowserUrlChange(this.projectName)
      }

      if (
        !this.healthMonitor.isConnected ||
        this.childAlive ||
        this.reconnecting
      ) {
        return
      }

      process.stderr.write(
        '[bridge] Recovery: Chrome is up but child is dead. Reconnecting.\n'
      )
      this.handleChromeReconnected().catch((error: unknown) => {
        process.stderr.write(
          `[bridge] Error during recovery reconnection: ${String(error)}\n`
        )
      })
    }, 5000)

    this.spawnChild()
    this.setupStdinProxy()
  }

  /**
   * Stops the bridge
   *
   * Stops the health monitor and terminates the child process.
   */
  stop(): void {
    this.healthMonitor.stop()
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
      this.recoveryTimer = null
    }
    if (!this.child) {
      return
    }

    this.child.kill('SIGTERM')
    this.child = null
    this.childAlive = false
  }

  /**
   * Re-reads config.json and checks whether the project's browserUrl has changed
   *
   * HealthMonitor keeps polling only the browserUrl it was given, so a change in config.json
   * cannot be detected from Chrome's connection state.
   * This method is therefore called periodically (via recoveryTimer),
   * independently of the connection state, to re-resolve config.json directly.
   * If the project is missing or the new URL is invalid, the current browserUrl is kept.
   * @param projectName Project name given by `--project`
   */
  private checkForBrowserUrlChange(projectName: string): void {
    const resolved = resolveProject(projectName)

    if (!resolved) {
      process.stderr.write(
        `[bridge] Project "${projectName}" no longer found in config. Keeping current browserUrl: ${this.browserUrl}\n`
      )
      return
    }

    if (resolved === this.browserUrl) {
      return
    }

    if (!isValidBrowserUrl(resolved)) {
      process.stderr.write(
        `[bridge] Resolved browserUrl for project "${projectName}" is invalid: ${resolved}. Keeping current browserUrl: ${this.browserUrl}\n`
      )
      return
    }

    process.stderr.write(
      `[bridge] browserUrl changed for project "${projectName}": ${this.browserUrl} -> ${resolved}. Restarting child process\n`
    )
    this.browserUrl = resolved
    this.healthMonitor.updateBrowserUrl(this.browserUrl)
    this.handleChromeReconnected().catch((error: unknown) => {
      process.stderr.write(
        `[bridge] Error during browserUrl change reconnection: ${String(error)}\n`
      )
    })
  }

  /**
   * Resolves and caches the chrome-devtools-mcp launch command
   *
   * Runs chrome-devtools-mcp directly if it is found in PATH, otherwise falls back to npx.
   * execSync runs only on the first call; later calls return the cached result.
   * @returns The command and its base arguments
   */
  private resolveSpawnCommand(): { cmd: string; baseArgs: string[] } {
    if (this.resolvedCmd) return this.resolvedCmd

    const whichCmd = process.platform === 'win32' ? 'where' : 'which'
    try {
      execSync(`${whichCmd} chrome-devtools-mcp`, { stdio: 'pipe' })
      process.stderr.write('[bridge] Found chrome-devtools-mcp in PATH\n')
      this.resolvedCmd = { cmd: 'chrome-devtools-mcp', baseArgs: [] }
    } catch {
      process.stderr.write(
        '[bridge] chrome-devtools-mcp not in PATH, using npx\n'
      )
      this.resolvedCmd = { cmd: 'npx', baseArgs: ['-y', 'chrome-devtools-mcp'] }
    }

    return this.resolvedCmd
  }

  private spawnChild(): void {
    const { cmd, baseArgs } = this.resolveSpawnCommand()
    const args = [
      ...baseArgs,
      `--browserUrl=${this.browserUrl}`,
      ...this.passthroughArgs,
    ]

    process.stderr.write(`[bridge] Spawning child: ${cmd} ${args.join(' ')}\n`)

    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    this.childAlive = true

    // Do not crash on stdin write errors (e.g. ERR_STREAM_DESTROYED)
    if (this.child.stdin) {
      this.child.stdin.on('error', (err: Error) => {
        process.stderr.write(
          `[bridge] Child stdin error (ignored): ${err.message}\n`
        )
      })
    }

    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout })
      rl.on('line', (line) => {
        this.handleChildOutput(line)
      })
      // Close readline when the child exits to avoid leaking it
      this.child.once('exit', () => {
        rl.close()
      })
    }

    this.child.on('exit', (code) => {
      process.stderr.write(`[bridge] Child process exited (code: ${code})\n`)
      this.childAlive = false
      this.child = null

      // If the child exits while waiting during a reconnect (e.g. a premature reconnect
      // where Chrome went down again), release the wait now instead of waiting for the initialize timeout
      if (this.waitingForInitResponse) {
        this.waitingForInitResponse = false
        this.initResponseCallback?.()
        this.initResponseCallback = null
      }

      // If Chrome is still reachable, restart immediately
      if (!this.healthMonitor.isConnected || this.reconnecting) {
        return
      }

      process.stderr.write(
        '[bridge] Chrome is still running. Restarting child process\n'
      )
      this.handleChromeReconnected().catch((error: unknown) => {
        process.stderr.write(
          `[bridge] Error during reconnection: ${String(error)}\n`
        )
      })
    })
  }

  /**
   * Handles an output line from the child process
   *
   * Suppresses the initialize response during a reconnect (the client already received one).
   * Everything else is forwarded to the client.
   * @param line A JSON-RPC message line received from the child
   */
  private handleChildOutput(line: string): void {
    if (this.waitingForInitResponse && this.initRequestId !== null) {
      const msg = tryParseJsonRpcLine(line)
      if (msg && isJsonRpcResponse(msg) && msg.id === this.initRequestId) {
        // Suppress it: the client already received one
        this.waitingForInitResponse = false
        process.stderr.write(
          '[bridge] Received initialize response (suppressed, not forwarded to Claude)\n'
        )
        this.initResponseCallback?.()
        this.initResponseCallback = null
        return
      }
    }

    process.stdout.write(line + '\n')
  }

  private setupStdinProxy(): void {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      this.handleIncomingMessage(line)
    })
    process.stdin.on('end', () => {
      process.stderr.write('[bridge] stdin closed. Exiting\n')
      rl.close()
      this.stop()
      this.onExit?.()
    })
  }

  /**
   * Replies to a request with a "Chrome is not connected" error response
   *
   * Non-requests and initialize requests are skipped (initialize is buffered for handshake replay).
   * @param msg The parsed JSON-RPC message
   */
  private sendDisconnectedError(msg: JsonRpcMessage): void {
    if (!isJsonRpcRequest(msg) || msg.method === 'initialize') {
      return
    }
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: -32_000,
        message: 'Chrome is not connected. Waiting for Chrome to restart.',
      },
    }
    process.stdout.write(JSON.stringify(response) + '\n')
  }

  /**
   * Handles a message received from the client
   *
   * Buffers initialize / notifications/initialized for replay on reconnect,
   * queues messages during a reconnection, and otherwise forwards them to the child.
   * @param line A JSON-RPC message line received from the client
   */
  private handleIncomingMessage(line: string): void {
    // Buffer the MCP handshake messages for replay on reconnect
    const msg = tryParseJsonRpcLine(line)
    if (msg) {
      if (isJsonRpcRequest(msg) && msg.method === 'initialize') {
        this.initRequest = line
        this.initRequestId = msg.id
        process.stderr.write('[bridge] Buffered initialize request\n')
      }
      if ('method' in msg && msg.method === 'notifications/initialized') {
        this.initializedNotif = line
        process.stderr.write('[bridge] MCP handshake complete\n')
      }
    }

    if (this.reconnecting) {
      // If the queue is full, drop the oldest message and answer it with an error if it is a request
      if (this.pendingQueue.length >= MAX_PENDING_QUEUE_SIZE) {
        const dropped = this.pendingQueue.shift()
        process.stderr.write(
          '[bridge] Pending queue full, dropping oldest message\n'
        )
        if (dropped !== undefined) {
          const droppedMsg = tryParseJsonRpcLine(dropped)
          if (droppedMsg) {
            this.sendDisconnectedError(droppedMsg)
          }
        }
      }
      this.pendingQueue.push(line)
      return
    }

    if (this.child?.stdin) {
      this.child.stdin.write(line + '\n')
    } else {
      // The child is not running (e.g. it exited while Chrome was unreachable): answer requests with an error to keep the session alive
      if (msg) {
        this.sendDisconnectedError(msg)
      }
    }
  }

  /**
   * Handles a Chrome reconnection
   *
   * Stops the existing child, spawns a new one, and replays the buffered
   * MCP handshake messages to restore the session.
   */
  private async handleChromeReconnected(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true

    try {
      if (this.child && this.childAlive) {
        process.stderr.write('[bridge] Stopping existing child process\n')
        const dying = this.child
        await new Promise<void>((resolve) => {
          // Continue anyway if it does not exit in time
          // (resolve() is safe to call more than once; later calls are ignored)
          const fallback = setTimeout(() => {
            process.stderr.write(
              '[bridge] Timed out waiting for child to exit, continuing\n'
            )
            resolve()
          }, 5000)
          dying.once('exit', () => {
            clearTimeout(fallback)
            resolve()
          })
          dying.kill('SIGTERM')
        })
      }

      this.spawnChild()
      const child = this.child

      if (this.initRequest && child?.stdin) {
        process.stderr.write('[bridge] Replaying initialize to child\n')
        child.stdin.write(this.initRequest + '\n')

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.waitingForInitResponse = false
            this.initResponseCallback = null
            process.stderr.write(
              '[bridge] Timed out waiting for initialize response\n'
            )
            resolve()
          }, 10_000)

          this.waitingForInitResponse = true
          this.initResponseCallback = () => {
            clearTimeout(timeout)
            resolve()
          }
        })

        // Replay notifications/initialized (child.stdin may have closed during the await, so check writable)
        if (this.initializedNotif && child.stdin.writable) {
          process.stderr.write(
            '[bridge] Replaying notifications/initialized to child\n'
          )
          child.stdin.write(this.initializedNotif + '\n')
        }
      }

      // If the child is not running (e.g. a failed premature reconnect), answer with an error instead
      const pending = [...this.pendingQueue]
      this.pendingQueue = []
      for (const pendingLine of pending) {
        if (this.child?.stdin?.writable) {
          this.child.stdin.write(pendingLine + '\n')
        } else {
          const parsed = tryParseJsonRpcLine(pendingLine)
          if (parsed) {
            this.sendDisconnectedError(parsed)
          }
        }
      }

      process.stderr.write('[bridge] Reconnection complete\n')
    } finally {
      this.reconnecting = false
    }
  }
}
