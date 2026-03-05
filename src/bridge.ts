import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { HealthMonitor } from './health-monitor'

/** Base type for JSON-RPC messages */
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

/** Options for initializing Bridge */
export interface BridgeOptions {
  /** Chrome remote debugging URL */
  browserUrl: string
  /** Flags to pass through to chrome-devtools-mcp */
  passthroughArgs: string[]
  /** Callback invoked when stdin is closed */
  onExit?: () => void
}

/**
 * stdio proxy bridge for chrome-devtools-mcp
 *
 * Operates as: Claude Code <-> Bridge <-> chrome-devtools-mcp (child process)
 * Automatically restarts the child process on Chrome crash and replays the MCP handshake.
 */
export class Bridge {
  private readonly browserUrl: string
  private readonly passthroughArgs: string[]
  private readonly healthMonitor: HealthMonitor
  private readonly onExit?: () => void

  private child: ChildProcess | null = null
  private childAlive = false

  /** Whether a reconnection is currently in progress */
  private reconnecting = false

  /** Buffered initialize request received from Claude (for replay on reconnect) */
  private initRequest: string | null = null
  /** id of the initialize request (used to suppress duplicate response to Claude) */
  private initRequestId: number | string | null = null
  /** Buffered notifications/initialized message received from Claude (for replay on reconnect) */
  private initializedNotif: string | null = null

  /** Queue of messages received from Claude while reconnecting */
  private pendingQueue: string[] = []

  /** Whether we are waiting for the initialize response from the child */
  private waitingForInitResponse = false
  /** Callback to invoke when the initialize response is received */
  private initResponseCallback: (() => void) | null = null

  /**
   * @param options Bridge initialization options
   */
  constructor(options: BridgeOptions) {
    this.browserUrl = options.browserUrl
    this.passthroughArgs = options.passthroughArgs
    this.onExit = options.onExit
    this.healthMonitor = new HealthMonitor(this.browserUrl)
  }

  /**
   * Start the bridge
   *
   * Starts the Chrome health monitor, spawns the child process, and begins proxying stdin.
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

    this.healthMonitor.start()
    this.spawnChild()
    this.setupStdinProxy()
  }

  /**
   * Stop the bridge
   *
   * Stops the health monitor and terminates the child process.
   */
  stop(): void {
    this.healthMonitor.stop()
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
    }
  }

  /**
   * Spawn the chrome-devtools-mcp child process
   */
  private spawnChild(): void {
    const args = [
      '-y',
      'chrome-devtools-mcp@latest',
      `--browserUrl=${this.browserUrl}`,
      ...this.passthroughArgs,
    ]

    process.stderr.write(`[bridge] Spawning child: npx ${args.join(' ')}\n`)

    this.child = spawn('npx', args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    this.childAlive = true

    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout })
      rl.on('line', (line) => {
        this.handleChildOutput(line)
      })
    }

    this.child.on('exit', (code) => {
      process.stderr.write(`[bridge] Child process exited (code: ${code})\n`)
      this.childAlive = false
      this.child = null

      // Restart immediately if Chrome is still reachable
      if (this.healthMonitor.isConnected && !this.reconnecting) {
        process.stderr.write(
          '[bridge] Chrome is still running. Restarting child process\n'
        )
        this.handleChromeReconnected().catch((error: unknown) => {
          process.stderr.write(
            `[bridge] Error during reconnection: ${String(error)}\n`
          )
        })
      }
    })
  }

  /**
   * Handle a line of output from the child process
   *
   * Suppresses the initialize response during reconnection (Claude already received it).
   * All other messages are forwarded to Claude.
   * @param line JSON-RPC message line received from the child
   */
  private handleChildOutput(line: string): void {
    // Intercept initialize response while waiting during reconnection
    if (this.waitingForInitResponse && this.initRequestId !== null) {
      try {
        const msg = JSON.parse(line) as JsonRpcMessage
        const isResponse =
          'id' in msg && msg.id === this.initRequestId && !('method' in msg)
        if (isResponse) {
          // Suppress initialize response - Claude already received one
          this.waitingForInitResponse = false
          process.stderr.write(
            '[bridge] Received initialize response (suppressed, not forwarded to Claude)\n'
          )
          this.initResponseCallback?.()
          this.initResponseCallback = null
          return
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Forward to Claude
    process.stdout.write(line + '\n')
  }

  /**
   * Set up the stdin proxy to forward Claude messages to the child process
   */
  private setupStdinProxy(): void {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      this.handleIncomingMessage(line)
    })
    process.stdin.on('end', () => {
      process.stderr.write('[bridge] stdin closed. Exiting\n')
      this.stop()
      this.onExit?.()
    })
  }

  /**
   * Handle a message received from Claude
   *
   * Buffers initialize / notifications/initialized for replay on reconnect,
   * queues messages while reconnecting, and forwards all others to the child.
   * @param line JSON-RPC message line received from Claude
   */
  private handleIncomingMessage(line: string): void {
    // Buffer MCP handshake messages for reconnection replay
    try {
      const msg = JSON.parse(line) as JsonRpcMessage
      if ('method' in msg && msg.method === 'initialize') {
        this.initRequest = line
        this.initRequestId = 'id' in msg ? msg.id : null
        process.stderr.write('[bridge] Buffered initialize request\n')
      }
      if ('method' in msg && msg.method === 'notifications/initialized') {
        this.initializedNotif = line
        process.stderr.write('[bridge] MCP handshake complete\n')
      }
    } catch {
      // Ignore JSON parse errors
    }

    // Queue messages while reconnecting
    if (this.reconnecting) {
      this.pendingQueue.push(line)
      return
    }

    // Forward to child process
    this.child?.stdin?.write(line + '\n')
  }

  /**
   * Handle Chrome reconnection
   *
   * Stops the existing child process, spawns a new one, replays the buffered
   * MCP handshake messages to restore the session.
   */
  private async handleChromeReconnected(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true

    try {
      // Stop the existing child process
      if (this.child && this.childAlive) {
        process.stderr.write('[bridge] Stopping existing child process\n')
        this.child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500)
        })
      }

      // Spawn a new child process
      this.spawnChild()
      const child = this.child

      // Replay the MCP handshake to initialize the new child
      if (this.initRequest && child?.stdin) {
        process.stderr.write('[bridge] Replaying initialize to child\n')
        child.stdin.write(this.initRequest + '\n')

        // Wait for initialize response (up to 10 seconds)
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

        // Replay notifications/initialized (child.stdin verified by outer condition)
        if (this.initializedNotif) {
          process.stderr.write(
            '[bridge] Replaying notifications/initialized to child\n'
          )
          child.stdin.write(this.initializedNotif + '\n')
        }
      }

      // Flush pending queue to child
      const pending = [...this.pendingQueue]
      this.pendingQueue = []
      for (const msg of pending) {
        this.child?.stdin?.write(msg + '\n')
      }

      process.stderr.write('[bridge] Reconnection complete\n')
    } finally {
      this.reconnecting = false
    }
  }
}
