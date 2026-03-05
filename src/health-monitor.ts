import http from 'node:http'

/**
 * Chrome の生存状態を定期的に HTTP ポーリングで監視するモニタ
 *
 * Chrome の `/json/version` エンドポイントを定期的に確認し、
 * 接続状態の変化に応じてイベントを発火する。
 * EventTarget を継承し、`connected` / `disconnected` / `reconnected` イベントを発火する。
 */
export class HealthMonitor extends EventTarget {
  private readonly browserUrl: string
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private _isConnected = false
  private hasEverConnected = false

  /**
   * @param browserUrl Chrome のデバッグ URL (例: http://127.0.0.1:9222)
   * @param pollIntervalMs ポーリング間隔（ミリ秒、デフォルト 3000）
   */
  constructor(browserUrl: string, pollIntervalMs = 3000) {
    super()
    this.browserUrl = browserUrl
    this.pollIntervalMs = pollIntervalMs
  }

  /** 現在 Chrome に接続できているかどうか */
  get isConnected(): boolean {
    return this._isConnected
  }

  /** ポーリングを開始する */
  start(): void {
    this.poll().catch((error: unknown) => {
      process.stderr.write(
        `[health-monitor] 予期しないエラー: ${String(error)}\n`
      )
    })
    this.timer = setInterval(() => {
      this.poll().catch((error: unknown) => {
        process.stderr.write(
          `[health-monitor] 予期しないエラー: ${String(error)}\n`
        )
      })
    }, this.pollIntervalMs)
  }

  /** ポーリングを停止する */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Chrome の /json/version エンドポイントに HTTP リクエストを送り、
   * 応答があれば true を返す
   */
  private async checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      let urlString: string
      try {
        const urlObj = new URL('/json/version', this.browserUrl)
        urlString = urlObj.toString()
      } catch {
        resolve(false)
        return
      }

      const req = http.get(urlString, { timeout: 2000 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => {
        resolve(false)
      })
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  /** ポーリング処理: 接続状態の変化を検知してイベントを発火する */
  private async poll(): Promise<void> {
    const healthy = await this.checkHealth()
    if (healthy && !this._isConnected) {
      this._isConnected = true
      if (this.hasEverConnected) {
        this.dispatchEvent(new Event('reconnected'))
      } else {
        this.hasEverConnected = true
        this.dispatchEvent(new Event('connected'))
      }
    } else if (!healthy && this._isConnected) {
      this._isConnected = false
      this.dispatchEvent(new Event('disconnected'))
    }
  }
}
