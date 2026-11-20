import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { Bridge, parseJsonRpcMessage } from '../bridge'

interface FakeStdin {
  writable: boolean
  written: string[]
  write: (chunk: string) => boolean
  on: () => void
}

interface FakeChild {
  stdin: FakeStdin
  stdout: object
  emit: (event: string, ...args: unknown[]) => boolean
  kill: () => boolean
}

interface FakeReadline {
  emit: (event: string, ...args: unknown[]) => boolean
  close: () => void
}

interface FakeMonitor extends EventTarget {
  isConnected: boolean
}

const h = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const spawned: FakeChild[] = []
  const readlines = new Map<object, FakeReadline>()
  const state: { monitor: FakeMonitor | null } = { monitor: null }
  return { EventEmitter, spawned, readlines, state }
})

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => {
    const child = new h.EventEmitter() as unknown as FakeChild
    const written: string[] = []
    child.stdin = {
      writable: true,
      written,
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
      on: vi.fn(),
    }
    child.stdout = {}
    child.kill = () => {
      child.emit('exit', 0)
      return true
    }
    h.spawned.push(child)
    return child
  }),
}))

vi.mock('node:readline', () => ({
  createInterface: ({ input }: { input: object }) => {
    const rl = new h.EventEmitter() as unknown as FakeReadline
    rl.close = vi.fn()
    h.readlines.set(input, rl)
    return rl
  },
}))

vi.mock('../health-monitor', () => ({
  HealthMonitor: class extends EventTarget {
    isConnected = false
    constructor() {
      super()
      h.state.monitor = this
    }
    start = vi.fn()
    stop = vi.fn()
    updateBrowserUrl = vi.fn()
  },
}))

const DISCONNECTED_MESSAGE =
  'chrome-devtools-mcp exited before responding. The request was not retried because it may already have had side effects.'

let bridge: Bridge
let stdoutLines: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn<typeof process.stdout, 'write'>>
let stderrSpy: ReturnType<typeof vi.spyOn<typeof process.stderr, 'write'>>

function monitor(): FakeMonitor {
  if (!h.state.monitor) throw new Error('HealthMonitor was not constructed')
  return h.state.monitor
}

function readlineFor(input: object): FakeReadline {
  const rl = h.readlines.get(input)
  if (!rl) throw new Error('No readline interface for the given input')
  return rl
}

function clientSends(message: object): void {
  readlineFor(process.stdin).emit('line', JSON.stringify(message))
}

function childSays(child: FakeChild, message: object): void {
  readlineFor(child.stdout).emit('line', JSON.stringify(message))
}

function toClient(): unknown[] {
  return stdoutLines.map((line) => JSON.parse(line) as unknown)
}

function toChild(child: FakeChild): unknown[] {
  return child.stdin.written.map((line) => JSON.parse(line) as unknown)
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
}
const initResult = { jsonrpc: '2.0', id: 1, result: { capabilities: {} } }
const initError = {
  jsonrpc: '2.0',
  id: 1,
  error: { code: -32_603, message: 'init failed' },
}
const initializedNotification = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
}

/** Starts a bridge whose first child is alive and Chrome is up. */
function startWithLiveChild(): FakeChild {
  bridge.start()
  monitor().isConnected = true
  return h.spawned[0]
}

/** Starts a bridge and loses the first child while Chrome is unreachable. */
function startWithoutChild(): void {
  bridge.start()
  h.spawned[0].emit('exit', 1)
}

/** Completes a normal handshake against the live first child. */
function completeHandshake(child: FakeChild): void {
  clientSends(initRequest)
  childSays(child, initResult)
  clientSends(initializedNotification)
}

function restartChildWhileChromeIsUp(): void {
  monitor().dispatchEvent(new Event('reconnected'))
}

function chromeBecomesAvailable(): void {
  monitor().isConnected = true
  monitor().dispatchEvent(new Event('connected'))
}

beforeEach(() => {
  vi.useFakeTimers()
  h.spawned.length = 0
  h.readlines.clear()
  h.state.monitor = null
  stdoutLines = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string
  ) => {
    stdoutLines.push(...chunk.split('\n').filter(Boolean))
    return true
  }) as never)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  bridge = new Bridge({
    browserUrl: 'http://127.0.0.1:9222',
    passthroughArgs: [],
  })
})

afterEach(() => {
  bridge.stop()
  process.stdin.removeAllListeners('end')
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  vi.useRealTimers()
})

describe('Bridge diagnostics redaction', () => {
  it('does not log credentials, query values, or argument values but spawns with the real ones', () => {
    const secretBridge = new Bridge({
      browserUrl: 'http://u:p@h:1/?t=s',
      passthroughArgs: ['--k=v'],
    })
    vi.mocked(spawn).mockClear()
    try {
      secretBridge.start()

      const output = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join('')
      expect(output).toContain(
        '--browserUrl=http://***:***@h:1/?t=*** --k=***'
      )
      for (const secret of ['u:p', 't=s', 'k=v']) {
        expect(output).not.toContain(secret)
      }
      expect(vi.mocked(spawn).mock.calls[0][1]).toEqual([
        '--browserUrl=http://u:p@h:1/?t=s',
        '--k=v',
      ])
    } finally {
      secretBridge.stop()
    }
  })
})

describe('Bridge lifecycle: initialize response', () => {
  it('forwards the replayed initialize response when the client never received one', async () => {
    startWithoutChild()
    clientSends(initRequest)
    chromeBecomesAvailable()
    childSays(h.spawned[1], initResult)
    await flush()
    clientSends(initializedNotification)

    expect(toClient()).toEqual([initResult])
    expect(toChild(h.spawned[1])).toEqual([
      initRequest,
      initializedNotification,
    ])
  })

  it('suppresses the replayed initialize response and replays notifications/initialized after a restart', async () => {
    const first = startWithLiveChild()
    completeHandshake(first)
    restartChildWhileChromeIsUp()
    await flush()
    childSays(h.spawned[1], initResult)
    await flush()

    expect(toClient()).toEqual([initResult])
    expect(toChild(h.spawned[1])).toEqual([
      initRequest,
      initializedNotification,
    ])
  })

  it('suppresses a replayed initialize error already answered and skips notifications/initialized', async () => {
    const first = startWithLiveChild()
    completeHandshake(first)
    restartChildWhileChromeIsUp()
    await flush()
    childSays(h.spawned[1], initError)
    await flush()

    expect(toClient()).toEqual([initResult])
    expect(toChild(h.spawned[1])).toEqual([initRequest])
  })

  it('forwards a replayed initialize error when the client never received a response', async () => {
    startWithoutChild()
    clientSends(initRequest)
    chromeBecomesAvailable()
    childSays(h.spawned[1], initError)
    await flush()

    expect(toClient()).toEqual([initError])
  })

  it('skips notifications/initialized when the replayed initialize times out', async () => {
    const first = startWithLiveChild()
    completeHandshake(first)
    restartChildWhileChromeIsUp()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(toClient()).toEqual([initResult])
    expect(toChild(h.spawned[1])).toEqual([initRequest])
  })

  it('forwards a late initialize response exactly once after a replay timeout', async () => {
    startWithoutChild()
    clientSends(initRequest)
    chromeBecomesAvailable()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(toClient()).toEqual([])

    childSays(h.spawned[1], initResult)

    expect(toClient()).toEqual([initResult])
  })

  it('writes an initialize that arrives during a reconnect to the new child once', async () => {
    startWithLiveChild()
    restartChildWhileChromeIsUp()
    clientSends(initRequest)
    await flush()
    childSays(h.spawned[1], initResult)
    await flush()

    expect(toChild(h.spawned[1])).toEqual([initRequest])
    expect(toClient()).toEqual([initResult])
  })
})

describe('Bridge lifecycle: in-flight requests', () => {
  const toolCall = (id: number): object => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {},
  })
  const disconnected = (id: number): object => ({
    jsonrpc: '2.0',
    id,
    error: { code: -32_000, message: DISCONNECTED_MESSAGE },
  })

  it('answers an unanswered request with an error when the child exits and does not retry it', async () => {
    const child = startWithLiveChild()
    completeHandshake(child)
    stdoutLines.length = 0
    clientSends(toolCall(42))
    monitor().isConnected = false

    child.emit('exit', 1)
    await flush()

    expect(toClient()).toEqual([disconnected(42)])
    expect(h.spawned).toHaveLength(1)
  })

  it('does not answer a request that already received a response', () => {
    const child = startWithLiveChild()
    completeHandshake(child)
    stdoutLines.length = 0
    clientSends(toolCall(42))
    clientSends(toolCall(43))
    childSays(child, { jsonrpc: '2.0', id: 43, result: {} })
    monitor().isConnected = false

    child.emit('exit', 1)

    expect(toClient()).toEqual([
      { jsonrpc: '2.0', id: 43, result: {} },
      disconnected(42),
    ])
  })

  it('does not answer notifications when the child exits', () => {
    const child = startWithLiveChild()
    completeHandshake(child)
    stdoutLines.length = 0
    clientSends({ jsonrpc: '2.0', method: 'notifications/cancelled' })
    monitor().isConnected = false

    child.emit('exit', 1)

    expect(toClient()).toEqual([])
  })

  it('tracks requests drained from the pending queue against the new child', async () => {
    const first = startWithLiveChild()
    completeHandshake(first)
    stdoutLines.length = 0
    restartChildWhileChromeIsUp()
    clientSends(toolCall(7))
    await flush()
    childSays(h.spawned[1], initResult)
    await flush()
    expect(toChild(h.spawned[1])).toContainEqual(toolCall(7))
    monitor().isConnected = false

    h.spawned[1].emit('exit', 1)

    expect(toClient()).toEqual([disconnected(7)])
  })
})

describe('parseJsonRpcMessage', () => {
  it.each([
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 'request-1', method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, result: null },
    {
      jsonrpc: '2.0',
      id: 'request-1',
      error: { code: -32_000, message: 'Disconnected' },
    },
  ])('returns the original message for %j', (message) => {
    expect(parseJsonRpcMessage(message)).toBe(message)
  })

  it.each([
    { jsonrpc: '2.0', id: 0 },
    { jsonrpc: '2.0', id: '' },
    { jsonrpc: '2.0', method: '' },
    { jsonrpc: '2.0', id: 1, method: false },
    { jsonrpc: '2.0', id: null, method: 'initialize' },
    { jsonrpc: '2.0', id: false, method: 'initialize' },
    { jsonrpc: '2.0', method: 'tools/list', params: false },
    { jsonrpc: '2.0', id: 1, result: true, error: false },
    { jsonrpc: '2.0', id: 1, error: 'unchecked' },
  ])(
    'accepts %j under the shallow check without validating other fields',
    (message) => {
      expect(parseJsonRpcMessage(message)).toBe(message)
    }
  )

  it.each([
    null,
    true,
    1,
    'message',
    [],
    [{ jsonrpc: '2.0', id: 1 }],
    {},
    { id: 1, method: 'initialize' },
    { jsonrpc: '1.0', id: 1, method: 'initialize' },
    { jsonrpc: 2, id: 1, method: 'initialize' },
    { jsonrpc: '2.0' },
    { jsonrpc: '2.0', id: null },
    { jsonrpc: '2.0', id: false },
    { jsonrpc: '2.0', id: {} },
    { jsonrpc: '2.0', method: 1 },
    { jsonrpc: '2.0', method: null },
    { jsonrpc: '2.0', method: {} },
    { jsonrpc: '2.0', id: false, method: 1 },
  ])('rejects %j when the envelope check fails', (message) => {
    expect(parseJsonRpcMessage(message)).toBeNull()
  })
})
