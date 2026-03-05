import http from 'node:http'

/**
 * Health monitor that periodically polls Chrome via HTTP
 *
 * Checks the `/json/version` endpoint at a fixed interval and dispatches
 * `connected`, `disconnected`, and `reconnected` events on state changes.
 */
export class HealthMonitor extends EventTarget {
  private readonly browserUrl: string
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private _isConnected = false
  private hasEverConnected = false

  /**
   * @param browserUrl Chrome remote debugging URL (e.g. http://127.0.0.1:9222)
   * @param pollIntervalMs Polling interval in milliseconds (default: 3000)
   */
  constructor(browserUrl: string, pollIntervalMs = 3000) {
    super()
    this.browserUrl = browserUrl
    this.pollIntervalMs = pollIntervalMs
  }

  /** Whether Chrome is currently reachable */
  get isConnected(): boolean {
    return this._isConnected
  }

  /** Start polling */
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

  /** Stop polling */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Send an HTTP request to Chrome's /json/version endpoint
   * @returns true if Chrome responded with HTTP 200
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

  /** Poll Chrome and dispatch events on connectivity changes */
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
