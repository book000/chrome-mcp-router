import http from 'node:http'
import https from 'node:https'

/**
 * Monitors Chrome liveness by polling
 *
 * Polls the `/json/version` endpoint at a fixed interval. Dispatches `connected` (first success), `disconnected`, and `reconnected` (success after a disconnect) when the connection state changes. Supports HTTP and HTTPS.
 */
export class HealthMonitor extends EventTarget {
  private browserUrl: string
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

  stop(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Switches the browserUrl being polled
   *
   * Call this when re-resolving config.json yields a different browserUrl.
   * The polling interval and connection state are not reset;
   * subsequent poll() calls simply run checkHealth() against the new URL.
   * @param newUrl The new URL to poll
   */
  updateBrowserUrl(newUrl: string): void {
    this.browserUrl = newUrl
  }

  /**
   * Sends an HTTP(S) request to Chrome's /json/version endpoint
   *
   * Picks the http or https module from the URL scheme. A request error or a timeout counts as unhealthy.
   * @returns true if Chrome responded with HTTP 200
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

      const transport = urlObj.protocol === 'https:' ? https : http

      const req = transport.get(urlObj.href, { timeout: 2000 }, (res) => {
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

  /** Polls Chrome and dispatches events when the connection state changes */
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
