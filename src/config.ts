import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Per-project configuration */
export interface ProjectConfig {
  /** Chrome remote debugging URL (e.g. http://127.0.0.1:9222) */
  browserUrl: string
}

/** Schema for the router config file */
export interface BridgeConfig {
  /** Mapping of project name to project configuration */
  projects: Record<string, ProjectConfig>
}

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'chrome-mcp-router',
  'config.json'
)

/**
 * Load the config file
 * @param configPath Path to config file (defaults to ~/.config/chrome-mcp-router/config.json)
 * @returns Parsed bridge config, or an empty config if the file does not exist
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
      `[bridge] Failed to load config file: ${configPath}\n`
    )
    process.stderr.write(`[bridge] ${String(error)}\n`)
    return { projects: {} }
  }
}

/**
 * Resolve a project name to its browserUrl
 * @param projectName Project name to look up
 * @param configPath Path to config file (optional)
 * @returns The browserUrl for the project, or null if not found
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
