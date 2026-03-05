import http from 'node:http'
import https from 'node:https'

/**
 * Chrome の死活を定期ポーリングで監視するモニター
 *
 * `/json/version` エンドポイントを一定間隔でチェックし、接続状態の変化に応じて
 * `connected`、`disconnected`、`reconnected` イベントをディスパッチする。
 * HTTP / HTTPS の両方に対応する。
 */
export class HealthMonitor extends EventTarget {
  private readonly browserUrl: string
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private _isConnected = false
  private hasEverConnected = false

  /**
   * @param browserUrl Chrome リモートデバッグ URL（例: http://127.0.0.1:9222）
   * @param pollIntervalMs ポーリング間隔（ミリ秒、デフォルト: 3000）
   */
  constructor(browserUrl: string, pollIntervalMs = 3000) {
    super()
    this.browserUrl = browserUrl
    this.pollIntervalMs = pollIntervalMs
  }

  /** Chrome が現在到達可能かどうか */
  get isConnected(): boolean {
    return this._isConnected
  }

  /** ポーリングを開始する */
  start(): void {
    this.poll().catch((error: unknown) => {
      process.stderr.write(
        `[health-monitor] Unexpected error: ${String(error)}\n`
      )
    })
    this.timer = setInterval(() => {
      this.poll().catch((error: unknown) => {
        process.stderr.write(
          `[health-monitor] Unexpected error: ${String(error)}\n`
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
   * Chrome の /json/version エンドポイントに HTTP(S) リクエストを送信する
   *
   * URL スキームに応じて http / https モジュールを自動で切り替える。
   * @returns Chrome が HTTP 200 で応答した場合は true
   */
  private async checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      let urlObj: URL
      try {
        urlObj = new URL('/json/version', this.browserUrl)
      } catch {
        resolve(false)
        return
      }

      // URL スキームに応じて http / https を切り替える
      const transport = urlObj.protocol === 'https:' ? https : http

      const req = transport.get(urlObj.toString(), { timeout: 2000 }, (res) => {
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

  /** Chrome をポーリングし、接続状態の変化に応じてイベントをディスパッチする */
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
