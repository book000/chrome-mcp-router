import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { isValidBrowserUrl, resolveProject } from './config'
import { HealthMonitor } from './health-monitor'
import { redactArgs, redactUrl } from './redact'

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
 * Recognizes a JSON.parse result using a shallow JSON-RPC envelope check
 *
 * Requires a non-null, non-array object with jsonrpc '2.0' and either a numeric/string
 * id or a string method. Other fields, including params, result, and error, are not
 * validated; this does not enforce full JSON-RPC request/response/notification shapes.
 * @param data Unvalidated data from JSON.parse
 * @returns The original message if the shallow check passes, otherwise null
 */
export function parseJsonRpcMessage(data: unknown): JsonRpcMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null
  }
  const obj = data as Record<string, unknown>
  if (obj.jsonrpc !== '2.0') {
    return null
  }
  const hasId =
    'id' in obj && (typeof obj.id === 'number' || typeof obj.id === 'string')
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
 * Parses a JSON string and applies the shallow JSON-RPC envelope check without throwing
 * @param line The JSON string to parse
 * @returns The JsonRpcMessage, or null if parsing or the shallow check fails
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

/** How a replayed initialize request ended */
type InitReplayOutcome = 'ok' | 'failed' | 'timeout' | 'exited'

interface ChildGeneration {
  process: ChildProcess
  alive: boolean
  ended: boolean
  failed: boolean
  termination: Promise<boolean> | null
  inFlight: Set<number | string>
  finishInit: ((outcome: InitReplayOutcome) => void) | null
}

const CHILD_EXITED_MESSAGE =
  'chrome-devtools-mcp exited before responding. The request was not retried because it may already have had side effects.'

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

  private child: ChildGeneration | null = null
  private stopped = false

  private reconnecting = false

  /** Timer that periodically checks the child and browserUrl and recovers */
  private recoveryTimer: ReturnType<typeof setInterval> | null = null

  /** Buffered initialize request from the client (replayed on reconnect) */
  private initRequest: string | null = null
  /** id of the initialize request (used to recognize its response from the child) */
  private initRequestId: number | string | null = null
  /** Whether a response to the buffered initialize request has been written to the client */
  private initResponseDelivered = false
  /** Buffered notifications/initialized message from the client (replayed on reconnect) */
  private initializedNotif: string | null = null

  /** Messages received from the client during a reconnection */
  private pendingQueue: string[] = []

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
      if (this.child || this.reconnecting) {
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
        (this.child !== null && !this.child.failed) ||
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
    this.stopped = true
    this.healthMonitor.stop()
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
      this.recoveryTimer = null
    }
    if (!this.child) {
      return
    }

    void this.terminateChild(this.child)
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
        `[bridge] Project "${projectName}" no longer found in config. Keeping current browserUrl: ${redactUrl(this.browserUrl)}\n`
      )
      return
    }

    if (resolved === this.browserUrl) {
      return
    }

    if (!isValidBrowserUrl(resolved)) {
      process.stderr.write(
        `[bridge] Resolved browserUrl for project "${projectName}" is invalid: ${redactUrl(resolved)}. Keeping current browserUrl: ${redactUrl(this.browserUrl)}\n`
      )
      return
    }

    process.stderr.write(
      `[bridge] browserUrl changed for project "${projectName}": ${redactUrl(this.browserUrl)} -> ${redactUrl(resolved)}. Restarting child process\n`
    )
    this.browserUrl = resolved
    this.healthMonitor.updateBrowserUrl(this.browserUrl)
    this.handleChromeReconnected().catch((error: unknown) => {
      process.stderr.write(
        `[bridge] Error during browserUrl change reconnection: ${String(error)}\n`
      )
    })
  }

  private spawnChild(): ChildGeneration {
    // The published CommonJS CLI resolves dependencies relative to this module.
    // eslint-disable-next-line unicorn/prefer-module
    const packagePath = require.resolve('chrome-devtools-mcp/package.json')
    const metadata: unknown = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      !('version' in metadata) ||
      metadata.version !== '1.13.0' ||
      !('bin' in metadata) ||
      typeof metadata.bin !== 'object' ||
      metadata.bin === null ||
      !('chrome-devtools-mcp' in metadata.bin) ||
      metadata.bin['chrome-devtools-mcp'] !==
        './out/Default/gen/src/bin/chrome-devtools-mcp.js'
    ) {
      throw new Error(
        'Unsupported chrome-devtools-mcp installation; expected version 1.13.0'
      )
    }
    const entry = path.resolve(
      path.dirname(packagePath),
      metadata.bin['chrome-devtools-mcp']
    )
    const args = [
      entry,
      `--browserUrl=${this.browserUrl}`,
      ...this.passthroughArgs,
    ]
    const loggedArgs = [
      `--browserUrl=${redactUrl(this.browserUrl)}`,
      ...redactArgs(this.passthroughArgs),
    ]
    process.stderr.write(
      `[bridge] Spawning chrome-devtools-mcp ${metadata.version}: ${loggedArgs.join(' ')}\n`
    )
    const cmd = process.execPath
    const child: ChildGeneration = {
      process: spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] }),
      alive: false,
      ended: false,
      failed: false,
      termination: null,
      inFlight: new Set(),
      finishInit: null,
    }
    this.child = child

    const rl = child.process.stdout
      ? createInterface({ input: child.process.stdout })
      : null
    const finish = (): void => {
      if (child.ended) return
      child.ended = true
      child.alive = false
      rl?.close()
      this.failInFlightRequests(child.inFlight)
      child.finishInit?.('exited')
      if (this.child === child) this.child = null
    }

    child.process.once('spawn', () => {
      if (this.child !== child || child.ended) return
      child.alive = true
    })
    child.process.on('error', (error: Error) => {
      if (this.child !== child || child.ended) return
      process.stderr.write(`[bridge] Child process error: ${error.message}\n`)
      child.failed = true
      this.failInFlightRequests(child.inFlight)
      child.finishInit?.('exited')
      if (!child.alive) finish()
    })
    child.process.stdin?.on('error', (error: Error) => {
      if (this.child !== child || child.ended) return
      process.stderr.write(
        `[bridge] Child stdin error (ignored): ${error.message}\n`
      )
    })
    rl?.on('line', (line) => {
      if (this.child !== child || child.ended || child.failed) return
      this.handleChildOutput(line, child)
    })
    child.process.once('exit', (code) => {
      if (this.child !== child || child.ended) return
      process.stderr.write(`[bridge] Child process exited (code: ${code})\n`)
      finish()
      if (
        child.failed ||
        this.stopped ||
        !this.healthMonitor.isConnected ||
        this.reconnecting
      )
        return
      this.handleChromeReconnected().catch((error: unknown) => {
        process.stderr.write(
          `[bridge] Error during reconnection: ${String(error)}\n`
        )
      })
    })
    return child
  }

  private terminateChild(child: ChildGeneration): Promise<boolean> {
    child.failed = true
    this.failInFlightRequests(child.inFlight)
    child.finishInit?.('exited')
    if (child.termination) return child.termination
    if (child.ended) return Promise.resolve(true)
    const termination = new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const onEnd = (): void => {
        clearTimeout(timer)
        child.process.removeListener('exit', onEnd)
        child.process.removeListener('close', onEnd)
        resolve(child.ended)
      }

      const signal = (name: NodeJS.Signals): void => {
        try {
          child.process.kill(name)
        } catch (error) {
          process.stderr.write(
            `[bridge] Child termination error: ${String(error)}\n`
          )
        }
      }
      child.process.once('exit', onEnd)
      child.process.once('close', onEnd)
      timer = setTimeout(() => {
        process.stderr.write(
          '[bridge] Child did not exit after SIGTERM; sending SIGKILL\n'
        )
        timer = setTimeout(() => {
          process.stderr.write(
            '[bridge] Child exit not confirmed; keeping ownership\n'
          )
          onEnd()
        }, 5000)
        signal('SIGKILL')
      }, 5000)
      signal('SIGTERM')
    })
    child.termination = termination
    void termination.then(() => {
      child.termination = null
    })
    return termination
  }

  /**
   * Handles an output line from the child process
   *
   * Forwards the initialize response unless the client already received one (a replay
   * duplicate), and settles a pending initialize replay. Other lines are forwarded as is.
   * Lines are parsed only while the initialize response or an in-flight request still needs tracking.
   * @param line A JSON-RPC message line received from the child
   * @param child The generation that emitted this line
   */
  private handleChildOutput(line: string, child: ChildGeneration): void {
    const trackingInit =
      this.initRequestId !== null &&
      (!this.initResponseDelivered || child.finishInit !== null)

    if (trackingInit || child.inFlight.size > 0) {
      const msg = tryParseJsonRpcLine(line)
      if (msg && isJsonRpcResponse(msg)) {
        if (trackingInit && msg.id === this.initRequestId) {
          this.handleInitializeResponse(line, msg, child)
          return
        }
        child.inFlight.delete(msg.id)
      }
    }

    process.stdout.write(line + '\n')
  }

  /**
   * Handles the child's response to the buffered initialize request
   *
   * Forwards it when the client has not received a response yet, otherwise suppresses
   * it as a replay duplicate, and then settles a pending replay wait.
   * @param line The raw response line
   * @param msg The parsed response
   * @param child The generation that emitted the response
   */
  private handleInitializeResponse(
    line: string,
    msg: JsonRpcResponse,
    child: ChildGeneration
  ): void {
    if (this.initResponseDelivered) {
      process.stderr.write(
        '[bridge] Received initialize response (suppressed, client already received one)\n'
      )
    } else {
      this.initResponseDelivered = true
      process.stdout.write(line + '\n')
    }

    child.finishInit?.(msg.error === undefined ? 'ok' : 'failed')
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
    this.sendError(
      msg.id,
      'Chrome is not connected. Waiting for Chrome to restart.'
    )
  }

  /**
   * Writes a JSON-RPC error response to the client
   * @param id The id of the request being answered
   * @param message The error message
   */
  private sendError(id: number | string, message: string): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code: -32_000, message },
    }
    process.stdout.write(JSON.stringify(response) + '\n')
  }

  /**
   * Answers every request the exited child never responded to with an error
   *
   * The requests are not replayed because they may already have had side effects.
   * @param inFlight Ids of requests written to the exited child
   */
  private failInFlightRequests(inFlight: Set<number | string>): void {
    for (const id of inFlight) {
      process.stderr.write(
        `[bridge] Child exited before responding to request ${String(id)}\n`
      )
      this.sendError(id, CHILD_EXITED_MESSAGE)
    }
    inFlight.clear()
  }

  /**
   * Records a request that was written to the current child so it can be failed if the child exits
   *
   * Initialize is not tracked: a replayed initialize is settled by the reconnect itself.
   * @param msg The parsed message that was written, or null if it was not valid JSON-RPC
   */
  private trackInFlight(msg: JsonRpcMessage | null): void {
    if (msg && isJsonRpcRequest(msg) && msg.method !== 'initialize') {
      this.child?.inFlight.add(msg.id)
    }
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
        this.initResponseDelivered = false
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

    if (
      this.child &&
      this.canUseChild(this.child) &&
      this.child.process.stdin
    ) {
      this.child.process.stdin.write(line + '\n')
      this.trackInFlight(msg)
    } else {
      // The child is not running (e.g. it exited while Chrome was unreachable): answer requests with an error to keep the session alive
      if (msg) {
        this.sendDisconnectedError(msg)
      }
    }
  }

  private canReconnect(): boolean {
    return !this.reconnecting && !this.stopped
  }

  private canUseChild(child: ChildGeneration): boolean {
    return this.child === child && !child.failed && !this.stopped
  }

  /**
   * Restarts the child and replays the buffered MCP handshake.
   */
  private async handleChromeReconnected(): Promise<void> {
    if (!this.canReconnect()) return
    this.reconnecting = true

    try {
      if (this.child) {
        process.stderr.write('[bridge] Stopping existing child process\n')
        if (!(await this.terminateChild(this.child))) {
          const pending = this.pendingQueue
          this.pendingQueue = []
          for (const line of pending) {
            const msg = tryParseJsonRpcLine(line)
            if (msg) this.sendDisconnectedError(msg)
          }
          return
        }
      }
      if (this.stopped) return
      const child = this.spawnChild()
      let replayedInitLine: string | null = null

      if (this.initRequest && child.process.stdin) {
        process.stderr.write('[bridge] Replaying initialize to child\n')
        const replayed = this.initRequest
        replayedInitLine = replayed
        const outcome = await new Promise<InitReplayOutcome>((resolve) => {
          const timeout = setTimeout(() => {
            child.finishInit = null
            process.stderr.write(
              '[bridge] Timed out waiting for initialize response\n'
            )
            resolve('timeout')
          }, 10_000)

          child.finishInit = (result) => {
            child.finishInit = null
            clearTimeout(timeout)
            resolve(result)
          }
          child.process.stdin?.write(replayed + '\n')
        })

        // Replay notifications/initialized only after a successful initialize (child.stdin may have closed during the await, so check writable)
        if (outcome !== 'ok') {
          process.stderr.write(
            `[bridge] Initialize replay ended with "${outcome}". Not replaying notifications/initialized\n`
          )
        } else if (
          this.initializedNotif &&
          this.canUseChild(child) &&
          child.process.stdin.writable
        ) {
          process.stderr.write(
            '[bridge] Replaying notifications/initialized to child\n'
          )
          child.process.stdin.write(this.initializedNotif + '\n')
        }
      }

      // If the child is not running (e.g. a failed premature reconnect), answer with an error instead
      const pending = [...this.pendingQueue]
      this.pendingQueue = []
      for (const pendingLine of pending) {
        if (pendingLine === replayedInitLine) {
          continue
        }
        if (this.canUseChild(child) && child.process.stdin?.writable) {
          child.process.stdin.write(pendingLine + '\n')
          this.trackInFlight(tryParseJsonRpcLine(pendingLine))
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
