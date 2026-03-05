import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isValidBrowserUrl, loadConfig, resolveProject } from '../config'

// node:fs をモックする
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}))

// モックした fs を取得
import fs from 'node:fs'

const mockExistsSync = vi.mocked(fs.existsSync)
const mockReadFileSync = vi.mocked(fs.readFileSync)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isValidBrowserUrl', () => {
  it('http:// で始まる URL を有効と判定する', () => {
    expect(isValidBrowserUrl('http://127.0.0.1:9222')).toBe(true)
  })

  it('https:// で始まる URL を有効と判定する', () => {
    expect(isValidBrowserUrl('https://localhost:9222')).toBe(true)
  })

  it('無効な URL を false と判定する', () => {
    expect(isValidBrowserUrl('ftp://example.com')).toBe(false)
  })

  it('空文字列を false と判定する', () => {
    expect(isValidBrowserUrl('')).toBe(false)
  })

  it('プロトコルのない文字列を false と判定する', () => {
    expect(isValidBrowserUrl('not-a-url')).toBe(false)
  })
})

describe('loadConfig', () => {
  it('ファイルが存在しない場合は空の設定を返す', () => {
    mockExistsSync.mockReturnValue(false)

    const config = loadConfig('/tmp/nonexistent.json')

    expect(config).toEqual({ projects: {} })
    expect(mockExistsSync).toHaveBeenCalledWith('/tmp/nonexistent.json')
  })

  it('正常な設定ファイルを読み込む', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          myProject: { browserUrl: 'http://127.0.0.1:9222' },
        },
      })
    )

    const config = loadConfig('/tmp/config.json')

    expect(config).toEqual({
      projects: {
        myProject: { browserUrl: 'http://127.0.0.1:9222' },
      },
    })
  })

  it('不正な JSON の場合は空の設定を返す', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('invalid json{{{')

    // stderr への出力を抑制
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true)

    const config = loadConfig('/tmp/bad.json')

    expect(config).toEqual({ projects: {} })
    stderrSpy.mockRestore()
  })

  it('projects がないオブジェクトの場合は空の設定を返す', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ notProjects: {} }))

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true)

    const config = loadConfig('/tmp/invalid.json')

    expect(config).toEqual({ projects: {} })
    stderrSpy.mockRestore()
  })

  it('browserUrl が空文字の場合は空の設定を返す', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          myProject: { browserUrl: '' },
        },
      })
    )

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true)

    const config = loadConfig('/tmp/empty-url.json')

    expect(config).toEqual({ projects: {} })
    stderrSpy.mockRestore()
  })
})

describe('resolveProject', () => {
  it('存在するプロジェクトの browserUrl を返す', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          myApp: { browserUrl: 'http://127.0.0.1:9222' },
        },
      })
    )

    const result = resolveProject('myApp', '/tmp/config.json')

    expect(result).toBe('http://127.0.0.1:9222')
  })

  it('存在しないプロジェクトの場合は null を返す', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        projects: {
          myApp: { browserUrl: 'http://127.0.0.1:9222' },
        },
      })
    )

    const result = resolveProject('nonExistent', '/tmp/config.json')

    expect(result).toBeNull()
  })

  it('設定ファイルが存在しない場合は null を返す', () => {
    mockExistsSync.mockReturnValue(false)

    const result = resolveProject('anyProject', '/tmp/missing.json')

    expect(result).toBeNull()
  })
})
