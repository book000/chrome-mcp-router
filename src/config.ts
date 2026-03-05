import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** プロジェクト設定 */
export interface ProjectConfig {
  /** Chrome のデバッグ URL (例: http://127.0.0.1:9222) */
  browserUrl: string
}

/** ブリッジ設定ファイルのスキーマ */
export interface BridgeConfig {
  /** プロジェクト名 → 設定のマッピング */
  projects: Record<string, ProjectConfig>
}

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'chrome-devtools-mcp-bridge',
  'config.json'
)

/**
 * 設定ファイルを読み込む
 * @param configPath 設定ファイルのパス（省略時はデフォルトパス）
 * @returns ブリッジ設定
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH): BridgeConfig {
  if (!fs.existsSync(configPath)) {
    return { projects: {} }
  }
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    return JSON.parse(content) as BridgeConfig
  } catch (error) {
    process.stderr.write(
      `[bridge] 設定ファイルの読み込みに失敗しました: ${configPath}\n`
    )
    process.stderr.write(`[bridge] ${String(error)}\n`)
    return { projects: {} }
  }
}

/**
 * プロジェクト名から browserUrl を解決する
 * @param projectName プロジェクト名
 * @param configPath 設定ファイルのパス（省略時はデフォルトパス）
 * @returns 対応する browserUrl、見つからない場合は null
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
