import { execSync, type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { HealthMonitor } from './health-monitor'

/** JSON-RPC メッセージの基底型 */
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

/**
 * JSON.parse の結果が有効な JSON-RPC メッセージかどうかを検証する
 *
 * jsonrpc フィールドが '2.0' であること、および
 * リクエスト/レスポンス/通知のいずれかの構造を満たすことを確認する。
 * @param data JSON.parse で得られた未検証のデータ
 * @returns 有効な JSON-RPC メッセージの場合はパース結果、無効な場合は null
 */
function parseJsonRpcMessage(data: unknown): JsonRpcMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null
  }
  const obj = data as Record<string, unknown>
  if (obj.jsonrpc !== '2.0') {
    return null
  }
  // リクエスト: method + id を持つ
  // レスポンス: id を持ち method を持たない
  // 通知: method を持ち id を持たない
  const hasId =
    'id' in obj &&
    (typeof obj.id === 'number' || typeof obj.id === 'string')
  const hasMethod = 'method' in obj && typeof obj.method === 'string'
  if (!hasId && !hasMethod) {
    return null
  }
  return data as JsonRpcMessage
}

/**
 * JSON-RPC メッセージがリクエスト（id と method の両方を持つ）かどうかを判定する
 *
 * レスポンスも id を持つため、'id' in msg だけではリクエストとレスポンスを区別できない。
 * この関数は method フィールドの有無でリクエストかどうかを正確に判定する。
 * @param msg 判定対象の JSON-RPC メッセージ
 * @returns リクエストの場合は true
 */
function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'id' in msg && 'method' in msg
}

/**
 * JSON-RPC メッセージがレスポンスかどうかを判定する
 *
 * レスポンスは id を持ち、method を持たない。
 * @param msg 判定対象の JSON-RPC メッセージ
 * @returns レスポンスの場合は true
 */
function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg)
}

/**
 * JSON 文字列を安全にパースし、JSON-RPC メッセージとして検証する
 * @param line パース対象の JSON 文字列
 * @returns パース・検証に成功した場合は JsonRpcMessage、失敗時は null
 */
function tryParseJsonRpcLine(line: string): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parseJsonRpcMessage(parsed)
  } catch {
    return null
  }
}

/** Bridge の初期化オプション */
export interface BridgeOptions {
  /** Chrome リモートデバッグ URL */
  browserUrl: string
  /** chrome-devtools-mcp にそのまま渡すフラグ */
  passthroughArgs: string[]
  /** stdin が閉じられたときに呼び出されるコールバック */
  onExit?: () => void
}

/** 保留メッセージキューの最大サイズ */
const MAX_PENDING_QUEUE_SIZE = 500

/**
 * chrome-devtools-mcp 用の stdio プロキシブリッジ
 *
 * Claude Code <-> Bridge <-> chrome-devtools-mcp（子プロセス）として動作する。
 * Chrome クラッシュ時に子プロセスを自動再起動し、MCP ハンドシェイクを再生する。
 */
export class Bridge {
  private readonly browserUrl: string
  private readonly passthroughArgs: string[]
  private readonly healthMonitor: HealthMonitor
  private readonly onExit?: () => void

  private child: ChildProcess | null = null
  private childAlive = false

  /** 再接続が現在進行中かどうか */
  private reconnecting = false

  /** 子プロセスの死活を定期監視してリカバリするタイマー */
  private recoveryTimer: ReturnType<typeof setInterval> | null = null

  /** Claude から受信した initialize リクエストのバッファ（再接続時の再生用） */
  private initRequest: string | null = null
  /** initialize リクエストの id（Claude への重複レスポンス抑制に使用） */
  private initRequestId: number | string | null = null
  /** Claude から受信した notifications/initialized メッセージのバッファ（再接続時の再生用） */
  private initializedNotif: string | null = null

  /** 再接続中に Claude から受信したメッセージのキュー */
  private pendingQueue: string[] = []

  /** 子プロセスからの initialize レスポンスを待機中かどうか */
  private waitingForInitResponse = false
  /** initialize レスポンス受信時に呼び出すコールバック */
  private initResponseCallback: (() => void) | null = null

  /**
   * chrome-devtools-mcp の起動コマンド解決結果のキャッシュ
   *
   * PATH に chrome-devtools-mcp が存在すれば直接実行、なければ npx にフォールバック。
   * 初回 spawnChild 時に解決されて以降は再利用する。
   */
  private resolvedCmd: { cmd: string; baseArgs: string[] } | null = null

  /**
   * @param options Bridge の初期化オプション
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
   * Chrome ヘルスモニターを起動し、子プロセスをスポーンして stdin のプロキシを開始する。
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

    // Chrome が初めて到達可能になったとき、子プロセスが死んでいれば起動する
    // （起動時に Chrome がダウンしていて後から復帰したケースのカバー）
    this.healthMonitor.addEventListener('connected', () => {
      if (!this.childAlive && !this.reconnecting) {
        process.stderr.write(
          '[bridge] Chrome became available. Starting child process\n'
        )
        this.handleChromeReconnected().catch((error: unknown) => {
          process.stderr.write(
            `[bridge] Error during initial connection: ${String(error)}\n`
          )
        })
      }
    })

    this.healthMonitor.addEventListener('disconnected', () => {
      process.stderr.write('[bridge] Chrome disconnected\n')
    })

    this.healthMonitor.start()

    // Chrome は生きているが子プロセスが死んでいる状態（premature reconnect 後のスタックなど）を
    // 定期的に検出してリカバリする
    this.recoveryTimer = setInterval(() => {
      if (
        this.healthMonitor.isConnected &&
        !this.childAlive &&
        !this.reconnecting
      ) {
        process.stderr.write(
          '[bridge] Recovery: Chrome is up but child is dead. Reconnecting.\n'
        )
        this.handleChromeReconnected().catch((error: unknown) => {
          process.stderr.write(
            `[bridge] Error during recovery reconnection: ${String(error)}\n`
          )
        })
      }
    }, 5000)

    this.spawnChild()
    this.setupStdinProxy()
  }

  /**
   * ブリッジを停止する
   *
   * ヘルスモニターを停止し、子プロセスを終了する。
   */
  stop(): void {
    this.healthMonitor.stop()
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
      this.recoveryTimer = null
    }
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
      this.childAlive = false
    }
  }

  /**
   * chrome-devtools-mcp の起動コマンドを解決してキャッシュする
   *
   * PATH に chrome-devtools-mcp が見つかれば直接実行する。
   * 見つからない場合は npx にフォールバックする。
   * 解決結果は初回のみ execSync を実行し、以降はキャッシュを返す。
   */
  private resolveSpawnCommand(): { cmd: string; baseArgs: string[] } {
    if (this.resolvedCmd) return this.resolvedCmd

    // Windows は where、Unix 系は which でバイナリを探す
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

  /**
   * chrome-devtools-mcp の子プロセスをスポーンする
   */
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

    // stdin への書き込みエラー（ERR_STREAM_DESTROYED 等）でプロセスがクラッシュしないようにする
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
      // 子プロセス終了時に readline を閉じてリソースリークを防ぐ
      this.child.once('exit', () => {
        rl.close()
      })
    }

    this.child.on('exit', (code) => {
      process.stderr.write(`[bridge] Child process exited (code: ${code})\n`)
      this.childAlive = false
      this.child = null

      // reconnect 待機中に子が終了した場合（Chrome が同時に落ちた premature reconnect など）、
      // init 応答待機を即座に解除して 10 秒タイムアウトを回避する
      if (this.waitingForInitResponse) {
        this.waitingForInitResponse = false
        this.initResponseCallback?.()
        this.initResponseCallback = null
      }

      // Chrome がまだ到達可能であれば即座に再起動する
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
   * 子プロセスからの出力行を処理する
   *
   * 再接続中の initialize レスポンスを抑制する（Claude は既に受信済み）。
   * その他のメッセージはすべて Claude に転送する。
   * @param line 子プロセスから受信した JSON-RPC メッセージ行
   */
  private handleChildOutput(line: string): void {
    // 再接続中の initialize レスポンスをインターセプトする
    if (this.waitingForInitResponse && this.initRequestId !== null) {
      const msg = tryParseJsonRpcLine(line)
      if (msg && isJsonRpcResponse(msg) && msg.id === this.initRequestId) {
        // 初期化レスポンスを抑制 - Claude は既に受信済み
        this.waitingForInitResponse = false
        process.stderr.write(
          '[bridge] Received initialize response (suppressed, not forwarded to Claude)\n'
        )
        this.initResponseCallback?.()
        this.initResponseCallback = null
        return
      }
    }

    // Claude に転送する
    process.stdout.write(line + '\n')
  }

  /**
   * Claude からのメッセージを子プロセスに転送する stdin プロキシを設定する
   */
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
   * リクエストメッセージに対して Chrome 切断エラーレスポンスを返す
   *
   * initialize リクエストは除外する（ハンドシェイク再生用にバッファ済みのため）。
   * @param msg パース済みの JSON-RPC メッセージ
   */
  private sendDisconnectedError(msg: JsonRpcMessage): void {
    if (isJsonRpcRequest(msg) && msg.method !== 'initialize') {
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
  }

  /**
   * Claude から受信したメッセージを処理する
   *
   * 再接続時の再生用に initialize / notifications/initialized をバッファし、
   * 再接続中はメッセージをキューに入れ、それ以外は子プロセスに転送する。
   * @param line Claude から受信した JSON-RPC メッセージ行
   */
  private handleIncomingMessage(line: string): void {
    // 再接続時の再生用に MCP ハンドシェイクメッセージをバッファする
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

    // 再接続中はメッセージをキューに入れる
    if (this.reconnecting) {
      // キューが満杯の場合は最も古いメッセージを破棄し、リクエストであればエラーレスポンスを返す
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

    // 子プロセスに転送する
    if (this.child?.stdin) {
      this.child.stdin.write(line + '\n')
    } else {
      // Chrome 切断中 - リクエストにはエラーレスポンスを返して接続を維持する
      if (msg) {
        this.sendDisconnectedError(msg)
      }
    }
  }

  /**
   * Chrome 再接続を処理する
   *
   * 既存の子プロセスを停止し、新しいプロセスをスポーンして、バッファした
   * MCP ハンドシェイクメッセージを再生してセッションを復元する。
   */
  private async handleChromeReconnected(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true

    try {
      // 既存の子プロセスを停止し、実際に終了するまで待機する
      if (this.child && this.childAlive) {
        process.stderr.write('[bridge] Stopping existing child process\n')
        const dying = this.child
        await new Promise<void>((resolve) => {
          // 5 秒以内に exit しない場合は強制的に続行する
          // resolve() は複数回呼んでも安全（後続呼び出しは無視される）
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

      // 新しい子プロセスをスポーンする
      this.spawnChild()
      const child = this.child

      // 新しい子プロセスを初期化するために MCP ハンドシェイクを再生する
      if (this.initRequest && child?.stdin) {
        process.stderr.write('[bridge] Replaying initialize to child\n')
        child.stdin.write(this.initRequest + '\n')

        // initialize レスポンスを待機する（最大 10 秒）
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

        // notifications/initialized を再生する
        // await 後に child.stdin が既に閉じている可能性があるため writable を確認する
        if (this.initializedNotif && child.stdin.writable) {
          process.stderr.write(
            '[bridge] Replaying notifications/initialized to child\n'
          )
          child.stdin.write(this.initializedNotif + '\n')
        }
      }

      // 保留キューを子プロセスにフラッシュする
      // child が起動していない場合（premature reconnect 失敗時など）はエラーレスポンスを返す
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
