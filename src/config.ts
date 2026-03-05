import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** プロジェクトごとの設定 */
export interface ProjectConfig {
  /** Chrome リモートデバッグ URL（例: http://127.0.0.1:9222） */
  browserUrl: string
}

/** ルーター設定ファイルのスキーマ */
export interface BridgeConfig {
  /** プロジェクト名からプロジェクト設定へのマッピング */
  projects: Record<string, ProjectConfig>
}

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'chrome-mcp-router',
  'config.json'
)

/**
 * 設定ファイルの内容を BridgeConfig として検証する
 * @param data JSON.parse した生データ
 * @returns 検証済みの BridgeConfig
 * @throws 構造が不正な場合にエラーをスローする
 */
function validateConfig(data: unknown): BridgeConfig {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Config must be a JSON object')
  }
  const obj = data as Record<string, unknown>
  if (
    typeof obj.projects !== 'object' ||
    obj.projects === null ||
    Array.isArray(obj.projects)
  ) {
    throw new Error('Config must have a "projects" object')
  }
  const projects: Record<string, ProjectConfig> = {}
  for (const [name, value] of Object.entries(
    obj.projects as Record<string, unknown>
  )) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Project "${name}" must be an object`)
    }
    const proj = value as Record<string, unknown>
    if (typeof proj.browserUrl !== 'string' || !proj.browserUrl) {
      throw new Error(
        `Project "${name}" must have a non-empty string "browserUrl"`
      )
    }
    projects[name] = { browserUrl: proj.browserUrl }
  }
  return { projects }
}

/**
 * browserUrl が有効な HTTP(S) URL かどうかを検証する
 * @param url 検証する URL 文字列
 * @returns http:// または https:// で始まる有効な URL の場合は true
 */
export function isValidBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 設定ファイルを読み込む
 * @param configPath 設定ファイルのパス（デフォルト: ~/.config/chrome-mcp-router/config.json）
 * @returns パース済みのブリッジ設定。ファイルが存在しない場合は空の設定を返す
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH): BridgeConfig {
  if (!fs.existsSync(configPath)) {
    return { projects: {} }
  }
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    const parsed: unknown = JSON.parse(content)
    return validateConfig(parsed)
  } catch (error) {
    process.stderr.write(
      `[bridge] Failed to load config file: ${configPath}\n`
    )
    process.stderr.write(`[bridge] ${String(error)}\n`)
    return { projects: {} }
  }
}

/**
 * プロジェクト名から browserUrl を解決する
 * @param projectName 検索するプロジェクト名
 * @param configPath 設定ファイルのパス（省略可）
 * @returns プロジェクトの browserUrl。見つからない場合は null
 */
export function resolveProject(
  projectName: string,
  configPath?: string
): string | null {
  const config = loadConfig(configPath)
  if (!Object.hasOwn(config.projects, projectName)) {
    return null
  }
  return config.projects[projectName].browserUrl
}
