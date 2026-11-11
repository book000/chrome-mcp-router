import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ProjectConfig {
  /** Chrome remote debugging URL (e.g. http://127.0.0.1:9222) */
  browserUrl: string
}

/** Schema of the router config file */
export interface BridgeConfig {
  /** Mapping from project name to project settings */
  projects: Record<string, ProjectConfig>
}

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'chrome-mcp-router',
  'config.json'
)

/**
 * Validates the config file contents as a BridgeConfig
 * @param data Raw data from JSON.parse
 * @returns The validated BridgeConfig
 * @throws {Error} If the structure is invalid
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
 * Checks whether a browserUrl is a valid HTTP(S) URL
 * @param url The URL string to check
 * @returns true if the URL is valid and uses the http: or https: scheme
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
 * Loads the config file
 *
 * A missing, unreadable, or invalid file is not an error: it is logged to stderr (except when missing)
 * and an empty config is returned, so callers only see "project not found".
 * @param configPath Path to the config file (default: ~/.config/chrome-mcp-router/config.json)
 * @returns The parsed config, or an empty config if the file is missing or invalid
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
 * Resolves a browserUrl from a project name
 *
 * The config file is re-read on every call so that edits are picked up while the bridge is running.
 * @param projectName The project name to look up
 * @param configPath Path to the config file (optional)
 * @returns The project's browserUrl, or null if not found
 */
export function resolveProject(
  projectName: string,
  configPath?: string
): string | null {
  const config = loadConfig(configPath)
  return Object.hasOwn(config.projects, projectName)
    ? config.projects[projectName].browserUrl
    : null
}
