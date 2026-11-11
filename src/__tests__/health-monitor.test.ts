import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { HealthMonitor } from '../health-monitor'

vi.mock('node:http', () => ({
  default: {
    get: vi.fn(),
  },
}))

const mockHttpGet = vi.mocked(http.get)

// Suppress process.stderr.write
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

function mockHttpResponse(statusCode: number): void {
  mockHttpGet.mockImplementation((_url, _opts, callback) => {
    const res = {
      statusCode,
      resume: vi.fn(),
    }
    if (typeof _opts === 'function') {
      // The callback is the second argument
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

function mockHttpError(): void {
  mockHttpGet.mockImplementation(() => {
    const req = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'error') {
          // Fire the error on the next tick
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
  it('dispatches connected on the first successful poll', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const connectedHandler = vi.fn()
    monitor.addEventListener('connected', connectedHandler)

    monitor.start()

    // poll() is async, so flush microtasks
    await vi.advanceTimersByTimeAsync(0)

    expect(connectedHandler).toHaveBeenCalledTimes(1)
    expect(monitor.isConnected).toBe(true)

    monitor.stop()
  })

  it('dispatches disconnected when the connection is lost', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const disconnectedHandler = vi.fn()
    monitor.addEventListener('disconnected', disconnectedHandler)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(monitor.isConnected).toBe(true)

    mockHttpError()
    await vi.advanceTimersByTimeAsync(1000)

    expect(disconnectedHandler).toHaveBeenCalledTimes(1)
    expect(monitor.isConnected).toBe(false)

    monitor.stop()
  })

  it('dispatches reconnected, not connected, after a reconnect', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const connectedHandler = vi.fn()
    const reconnectedHandler = vi.fn()
    monitor.addEventListener('connected', connectedHandler)
    monitor.addEventListener('reconnected', reconnectedHandler)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(connectedHandler).toHaveBeenCalledTimes(1)

    mockHttpError()
    await vi.advanceTimersByTimeAsync(1000)

    expect(monitor.isConnected).toBe(false)

    mockHttpResponse(200)
    await vi.advanceTimersByTimeAsync(1000)

    expect(reconnectedHandler).toHaveBeenCalledTimes(1)
    expect(connectedHandler).toHaveBeenCalledTimes(1)
    expect(monitor.isConnected).toBe(true)

    monitor.stop()
  })

  it('polls the new URL after updateBrowserUrl()', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockHttpGet).toHaveBeenLastCalledWith(
      'http://127.0.0.1:9222/json/version',
      expect.anything(),
      expect.any(Function)
    )

    monitor.updateBrowserUrl('http://127.0.0.1:9333')
    mockHttpGet.mockClear()
    mockHttpResponse(200)
    await vi.advanceTimersByTimeAsync(1000)

    expect(mockHttpGet).toHaveBeenLastCalledWith(
      'http://127.0.0.1:9333/json/version',
      expect.anything(),
      expect.any(Function)
    )

    monitor.stop()
  })

  it('stops polling on stop()', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    monitor.stop()

    mockHttpGet.mockClear()
    await vi.advanceTimersByTimeAsync(5000)

    expect(mockHttpGet).not.toHaveBeenCalled()
  })

  it('treats HTTP 500 as a connection failure', async () => {
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

  it('does not dispatch connected again while already connected', async () => {
    mockHttpResponse(200)

    const monitor = new HealthMonitor('http://127.0.0.1:9222', 1000)
    const connectedHandler = vi.fn()
    monitor.addEventListener('connected', connectedHandler)

    monitor.start()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(1000)

    expect(connectedHandler).toHaveBeenCalledTimes(1)

    monitor.stop()
  })
})
