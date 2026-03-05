import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { HealthMonitor } from '../health-monitor'

// node:http をモックする
vi.mock('node:http', () => ({
  default: {
    get: vi.fn(),
  },
}))

const mockHttpGet = vi.mocked(http.get)

// process.stderr.write を抑制する
let stderrSpy: ReturnType<typeof vi.spyOn<typeof process.stderr, 'write'>>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(() => {
  vi.useRealTimers()
  stderrSpy.mockRestore()
})

/**
 * HTTP レスポンスのモックヘルパー
 * @param statusCode レスポンスのステータスコード
 */
function mockHttpResponse(statusCode: number): void {
  mockHttpGet.mockImplementation((_url, _opts, callback) => {
    const res = {
      statusCode,
      resume: vi.fn(),
    }
    if (typeof _opts === 'function') {
      // callback が第 2 引数の場合
      _opts(res)
    } else if (typeof callback === 'function') {
      callback(res as never)
    }
    const req = {
      on: vi.fn(),
      destroy: vi.fn(),
    }
    return req as never
  })
}

/**
 * HTTP エラーのモックヘルパー
 */
function mockHttpError(): void {
  mockHttpGet.mockImplementation(() => {
    const req = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'error') {
          // 次の tick でエラーを発火させる
          queueMicrotask(handler)
        }
        return req
      }),
      destroy: vi.fn(),
    }
    return req as never
  })
}

describe('HealthMonitor', () => {
  it('初回接続で connected イベントが発火する', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const connectedHandler = vi.fn()
    monitor.addEventListener('connected', connectedHandler)

    monitor.start()

    // poll() は非同期なので、マイクロタスクを処理する
    await vi.advanceTimersByTimeAsync(0)

    expect(connectedHandler).toHaveBeenCalledTimes(1)
    expect(monitor.isConnected).toBe(true)

    monitor.stop()
  })

  it('切断で disconnected イベントが発火する', async () => {
    // 最初は接続成功
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const disconnectedHandler = vi.fn()
    monitor.addEventListener('disconnected', disconnectedHandler)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(monitor.isConnected).toBe(true)

    // 次のポーリングではエラーにする
    mockHttpError()
    await vi.advanceTimersByTimeAsync(1000)

    expect(disconnectedHandler).toHaveBeenCalledTimes(1)
    expect(monitor.isConnected).toBe(false)

    monitor.stop()
  })

  it('再接続で reconnected イベントが発火する（connected ではなく）', async () => {
    // 最初は接続成功
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const connectedHandler = vi.fn()
    const reconnectedHandler = vi.fn()
    monitor.addEventListener('connected', connectedHandler)
    monitor.addEventListener('reconnected', reconnectedHandler)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(connectedHandler).toHaveBeenCalledTimes(1)

    // 切断
    mockHttpError()
    await vi.advanceTimersByTimeAsync(1000)

    expect(monitor.isConnected).toBe(false)

    // 再接続
    mockHttpResponse(200)
    await vi.advanceTimersByTimeAsync(1000)

    // reconnected が発火し、connected は追加で発火しない
    expect(reconnectedHandler).toHaveBeenCalledTimes(1)
    expect(connectedHandler).toHaveBeenCalledTimes(1)
    expect(monitor.isConnected).toBe(true)

    monitor.stop()
  })

  it('stop() でポーリングが停止する', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    monitor.stop()

    // stop 後はポーリングが行われない
    mockHttpGet.mockClear()
    await vi.advanceTimersByTimeAsync(5000)

    expect(mockHttpGet).not.toHaveBeenCalled()
  })

  it('HTTP 500 の場合は接続失敗として扱う', async () => {
    mockHttpResponse(500)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const connectedHandler = vi.fn()
    monitor.addEventListener('connected', connectedHandler)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(connectedHandler).not.toHaveBeenCalled()
    expect(monitor.isConnected).toBe(false)

    monitor.stop()
  })

  it('既に接続中の場合に再度 connected が発火しない', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const connectedHandler = vi.fn()
    monitor.addEventListener('connected', connectedHandler)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    // 2 回目のポーリング
    await vi.advanceTimersByTimeAsync(1000)

    // connected は 1 回だけ
    expect(connectedHandler).toHaveBeenCalledTimes(1)

    monitor.stop()
  })
})
