import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { HealthMonitor } from './health-monitor'

/** JSON-RPC メッセージの基本型 */
interface JsonRpcBase {
  jsonrpc: '2.0'
}

/** JSON-RPC リクエスト */
interface JsonRpcRequest extends JsonRpcBase {
  id: number | string
  method: string
  params?: unknown
}

/** JSON-RPC レスポンス */
interface JsonRpcResponse extends JsonRpcBase {
  id: number | string
  result?: unknown
  error?: unknown
}

/** JSON-RPC 通知（id なし） */
interface JsonRpcNotification extends JsonRpcBase {
  method: string
  params?: unknown
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

/** Bridge の初期化オプション */
export interface BridgeOptions {
  /** Chrome のデバッグ URL */
  browserUrl: string
  /** chrome-devtools-mcp に pass-through するフラグ */
  passthroughArgs: string[]
  /** stdin が閉じられた際に呼び出されるコールバック */
  onExit?: () => void
}

/**
 * chrome-devtools-mcp の stdio プロキシとして動作するブリッジ
 *
 * Claude Code ↔ Bridge ↔ chrome-devtools-mcp (子プロセス) という構成で動作し、
 * Chrome クラッシュ時に子プロセスを自動再起動し、MCP handshake を再送する。
 */
export class Bridge {
  private readonly browserUrl: string
  private readonly passthroughArgs: string[]
  private readonly healthMonitor: HealthMonitor
  private readonly onExit?: () => void

  private child: ChildProcess | null = null
  private childAlive = false

  /** 再接続処理中フラグ */
  private reconnecting = false

  /** Claude から受信した initialize リクエスト（再送用にバッファ） */
  private initRequest: string | null = null
  /** initialize リクエストの id（レスポンス抑制に使用） */
  private initRequestId: number | string | null = null
  /** Claude から受信した notifications/initialized（再送用にバッファ） */
  private initializedNotif: string | null = null

  /** 再接続中に Claude から届いたメッセージを保持するキュー */
  private pendingQueue: string[] = []

  /** 子プロセスからの initialize レスポンスを待ち受けているかどうか */
  private waitingForInitResponse = false
  /** initialize レスポンスを受信した際に呼び出すコールバック */
  private initResponseCallback: (() => void) | null = null

  /**
   * @param options ブリッジの初期化オプション
   */
  constructor(options: BridgeOptions) {
    this.browserUrl = options.browserUrl
    this.passthroughArgs = options.passthroughArgs
    this.onExit = options.onExit
    this.healthMonitor = new HealthMonitor(this.browserUrl)
  }

  /**
   * ブリッジを開始する
   *
   * Chrome ヘルスモニタを起動し、子プロセスを起動して stdin のプロキシを開始する。
   */
  start(): void {
    this.healthMonitor.addEventListener('reconnected', () => {
      process.stderr.write(
        '[bridge] Chrome の再起動を検知しました。子プロセスを再起動します\n'
      )
      this.handleChromeReconnected().catch((error: unknown) => {
        process.stderr.write(
          `[bridge] 再接続中にエラーが発生しました: ${String(error)}\n`
        )
      })
    })

    this.healthMonitor.start()
    this.spawnChild()
    this.setupStdinProxy()
  }

  /**
   * ブリッジを停止する
   *
   * ヘルスモニタと子プロセスを停止する。
   */
  stop(): void {
    this.healthMonitor.stop()
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
    }
  }

  /**
   * chrome-devtools-mcp の子プロセスを起動する
   */
  private spawnChild(): void {
    const args = [
      '-y',
      'chrome-devtools-mcp@latest',
      `--browserUrl=${this.browserUrl}`,
      ...this.passthroughArgs,
    ]

    process.stderr.write(
      `[bridge] 子プロセスを起動します: npx ${args.join(' ')}\n`
    )

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
      process.stderr.write(
        `[bridge] 子プロセスが終了しました (コード: ${code})\n`
      )
      this.childAlive = false
      this.child = null

      // Chrome が接続状態の場合は即座に再起動する
      if (this.healthMonitor.isConnected && !this.reconnecting) {
        process.stderr.write(
          '[bridge] Chrome は動作中のため、子プロセスを再起動します\n'
        )
        this.handleChromeReconnected().catch((error: unknown) => {
          process.stderr.write(
            `[bridge] 再接続中にエラーが発生しました: ${String(error)}\n`
          )
        })
      }
    })
  }

  /**
   * 子プロセスからの出力行を処理する
   *
   * 再接続中に initialize レスポンスを受信した場合は Claude に転送せず抑制する。
   * それ以外のメッセージは Claude に転送する。
   * @param line 子プロセスから受信した JSON-RPC メッセージ（1 行）
   */
  private handleChildOutput(line: string): void {
    // 再接続中に initialize レスポンスを待っている場合
    if (this.waitingForInitResponse && this.initRequestId !== null) {
      try {
        const msg = JSON.parse(line) as JsonRpcMessage
        const isResponse =
          'id' in msg && msg.id === this.initRequestId && !('method' in msg)
        if (isResponse) {
          // initialize レスポンスをキャッチ - Claude には転送しない
          this.waitingForInitResponse = false
          process.stderr.write(
            '[bridge] initialize レスポンスを受信しました（Claude には転送しません）\n'
          )
          this.initResponseCallback?.()
          this.initResponseCallback = null
          return
        }
      } catch {
        // JSON パースエラーは無視
      }
    }

    // Claude に転送
    process.stdout.write(line + '\n')
  }

  /**
   * stdin から Claude のメッセージを受け取り子プロセスに転送するプロキシを設定する
   */
  private setupStdinProxy(): void {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      this.handleIncomingMessage(line)
    })
    process.stdin.on('end', () => {
      process.stderr.write('[bridge] stdin が閉じられました。終了します\n')
      this.stop()
      this.onExit?.()
    })
  }

  /**
   * Claude から受信したメッセージを処理する
   *
   * initialize / notifications/initialized をバッファし、
   * 再接続中はキューに積み、それ以外は子プロセスに転送する。
   * @param line Claude から受信した JSON-RPC メッセージ（1 行）
   */
  private handleIncomingMessage(line: string): void {
    // MCP handshake メッセージをバッファ
    try {
      const msg = JSON.parse(line) as JsonRpcMessage
      if ('method' in msg && msg.method === 'initialize') {
        this.initRequest = line
        this.initRequestId = 'id' in msg ? msg.id : null
        process.stderr.write('[bridge] initialize リクエストをバッファしました\n')
      }
      if ('method' in msg && msg.method === 'notifications/initialized') {
        this.initializedNotif = line
        process.stderr.write('[bridge] MCP handshake が完了しました\n')
      }
    } catch {
      // JSON パースエラーは無視
    }

    // 再接続中はキューに積む
    if (this.reconnecting) {
      this.pendingQueue.push(line)
      return
    }

    // 子プロセスに転送
    this.child?.stdin?.write(line + '\n')
  }

  /**
   * Chrome 再接続時の処理
   *
   * 既存の子プロセスを停止し、新しい子プロセスを起動した後、
   * バッファした MCP handshake メッセージを再送してセッションを復元する。
   */
  private async handleChromeReconnected(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true

    try {
      // 既存の子プロセスを停止
      if (this.child && this.childAlive) {
        process.stderr.write('[bridge] 既存の子プロセスを停止します\n')
        this.child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500)
        })
      }

      // 新しい子プロセスを起動
      this.spawnChild()
      const child = this.child

      // MCP handshake を再送して新しい子プロセスを初期化する
      if (this.initRequest && child?.stdin) {
        process.stderr.write('[bridge] initialize を子プロセスに再送します\n')
        child.stdin.write(this.initRequest + '\n')

        // initialize レスポンスを待つ（最大 10 秒）
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.waitingForInitResponse = false
            this.initResponseCallback = null
            process.stderr.write(
              '[bridge] initialize レスポンスがタイムアウトしました\n'
            )
            resolve()
          }, 10_000)

          this.waitingForInitResponse = true
          this.initResponseCallback = () => {
            clearTimeout(timeout)
            resolve()
          }
        })

        // notifications/initialized を再送（child.stdin は外側の条件で確認済み）
        if (this.initializedNotif) {
          process.stderr.write(
            '[bridge] notifications/initialized を子プロセスに再送します\n'
          )
          child.stdin.write(this.initializedNotif + '\n')
        }
      }

      // ペンディングキューのメッセージを子プロセスに転送
      const pending = [...this.pendingQueue]
      this.pendingQueue = []
      for (const msg of pending) {
        this.child?.stdin?.write(msg + '\n')
      }

      process.stderr.write('[bridge] 再接続が完了しました\n')
    } finally {
      this.reconnecting = false
    }
  }
}
