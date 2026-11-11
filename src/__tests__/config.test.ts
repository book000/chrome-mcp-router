import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isValidBrowserUrl, loadConfig, resolveProject } from '../config'

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}))

import fs from 'node:fs'

const mockExistsSync = vi.mocked(fs.existsSync)
const mockReadFileSync = vi.mocked(fs.readFileSync)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isValidBrowserUrl', () => {
  it('accepts a URL starting with http://', () => {
    expect(isValidBrowserUrl('http://127.0.0.1:9222')).toBe(true)
  })

  it('accepts a URL starting with https://', () => {
    expect(isValidBrowserUrl('https://localhost:9222')).toBe(true)
  })

  it('rejects an invalid URL', () => {
    expect(isValidBrowserUrl('ftp://example.com')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidBrowserUrl('')).toBe(false)
  })

  it('rejects a string without a protocol', () => {
    expect(isValidBrowserUrl('not-a-url')).toBe(false)
  })
})

describe('loadConfig', () => {
  it('returns an empty config when the file does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    const config = loadConfig('/tmp/nonexistent.json')

    expect(config).toEqual({ projects: {} })
    expect(mockExistsSync).toHaveBeenCalledWith('/tmp/nonexistent.json')
  })

  it('loads a valid config file', () => {
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

  it('returns an empty config for invalid JSON', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('invalid json{{{')

    // Suppress stderr output
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true)

    const config = loadConfig('/tmp/bad.json')

    expect(config).toEqual({ projects: {} })
    stderrSpy.mockRestore()
  })

  it('returns an empty config when the object has no projects', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ notProjects: {} }))

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true)

    const config = loadConfig('/tmp/invalid.json')

    expect(config).toEqual({ projects: {} })
    stderrSpy.mockRestore()
  })

  it('returns an empty config when browserUrl is an empty string', () => {
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
  it('returns the browserUrl of an existing project', () => {
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

  it('returns null for a project that does not exist', () => {
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

  it('returns null when the config file does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    const result = resolveProject('anyProject', '/tmp/missing.json')

    expect(result).toBeNull()
  })

  it('re-reads the config file on each call and returns the updated browserUrl', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({
        projects: {
          myApp: { browserUrl: 'http://127.0.0.1:9222' },
        },
      })
    )

    const first = resolveProject('myApp', '/tmp/config.json')
    expect(first).toBe('http://127.0.0.1:9222')

    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({
        projects: {
          myApp: { browserUrl: 'http://127.0.0.1:9333' },
        },
      })
    )

    const second = resolveProject('myApp', '/tmp/config.json')
    expect(second).toBe('http://127.0.0.1:9333')
  })
})
