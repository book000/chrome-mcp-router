#!/usr/bin/env node
import { Bridge } from './bridge'
import { resolveProject } from './config'

/** Parsed CLI arguments */
interface ParsedArgs {
  browserUrl: string
  passthroughArgs: string[]
}

/**
 * Parse CLI arguments and return browserUrl and pass-through flags
 *
 * --project <name>: Resolve browserUrl from config file by project name
 * --browserUrl <url>: Use Chrome remote debugging URL directly
 * All other flags are passed through to chrome-devtools-mcp
 * @returns Parsed arguments
 */
function parseArgs(): ParsedArgs {
  const rawArgs = process.argv.slice(2)
  let browserUrl: string | null = null
  const passthroughArgs: string[] = []

  let i = 0
  while (i < rawArgs.length) {
    const arg = rawArgs[i]

    if (arg === '--project' && i + 1 < rawArgs.length) {
      const projectName = rawArgs[++i]
      browserUrl = resolveProject(projectName)
      if (!browserUrl) {
        process.stderr.write(
          `Error: Project "${projectName}" not found in config\n`
        )
        process.stderr.write(
          'Config file: ~/.config/chrome-mcp-router/config.json\n'
        )
        process.exit(1)
      }
    } else if (arg.startsWith('--project=')) {
      const projectName = arg.slice('--project='.length)
      browserUrl = resolveProject(projectName)
      if (!browserUrl) {
        process.stderr.write(
          `Error: Project "${projectName}" not found in config\n`
        )
        process.exit(1)
      }
    } else if (arg === '--browserUrl' && i + 1 < rawArgs.length) {
      browserUrl = rawArgs[++i]
    } else if (arg.startsWith('--browserUrl=')) {
      browserUrl = arg.slice('--browserUrl='.length)
    } else {
      // Unknown flags are passed through to chrome-devtools-mcp
      passthroughArgs.push(arg)
    }

    i++
  }

  if (!browserUrl) {
    process.stderr.write('Usage: chrome-mcp-router --project <name>\n')
    process.stderr.write('   or: chrome-mcp-router --browserUrl <url>\n')
    process.stderr.write('\nOptions:\n')
    process.stderr.write(
      '  --project <name>     Resolve browserUrl from config file by project name\n'
    )
    process.stderr.write(
      '  --browserUrl <url>   Chrome remote debugging URL (e.g. http://127.0.0.1:9222)\n'
    )
    process.stderr.write(
      '  Other flags are passed through to chrome-devtools-mcp\n'
    )
    process.stderr.write(
      '\nConfig file: ~/.config/chrome-mcp-router/config.json\n'
    )
    process.exit(1)
  }

  return { browserUrl, passthroughArgs }
}

const { browserUrl, passthroughArgs } = parseArgs()
const bridge = new Bridge({
  browserUrl,
  passthroughArgs,
  onExit: () => process.exit(0),
})

bridge.start()

process.on('SIGTERM', () => {
  bridge.stop()
  process.exit(0)
})

process.on('SIGINT', () => {
  bridge.stop()
  process.exit(0)
})
