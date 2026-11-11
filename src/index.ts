#!/usr/bin/env node
import { Bridge } from './bridge'
import { isValidBrowserUrl, resolveProject } from './config'

interface ParsedArgs {
  /** Chrome remote debugging URL */
  browserUrl: string
  /** Project name given by `--project` (undefined when only `--browserUrl` is used) */
  projectName?: string
  /** Flags passed through to chrome-devtools-mcp as is */
  passthroughArgs: string[]
}

/**
 * Extracts the value of a `--key value` or `--key=value` CLI argument
 *
 * For `--key=value`, returns the part after `=` and leaves the index unchanged.
 * For `--key value`, returns the next argument and advances the index by 1.
 * @param args The argument array
 * @param index The current index (an object so it can be advanced by reference)
 * @param prefix The `--key` part (e.g. `'--project'`)
 * @returns The value, or null if the current argument does not match
 */
function extractArgValue(
  args: string[],
  index: { value: number },
  prefix: string
): string | null {
  const arg = args[index.value]
  if (arg === prefix && index.value + 1 < args.length) {
    index.value++
    return args[index.value]
  }
  const eqPrefix = `${prefix}=`
  return arg.startsWith(eqPrefix) ? arg.slice(eqPrefix.length) : null
}

/**
 * Validates a URL and exits with an error message if it is invalid
 * @param url The URL string to validate
 * @param label Label for the error message (e.g. `'project "foo"'`)
 */
function validateUrlOrExit(url: string, label: string): void {
  if (isValidBrowserUrl(url)) {
    return
  }
  process.stderr.write(`Error: Invalid URL for ${label}: ${url}\n`)
  process.stderr.write('URL must start with http:// or https://\n')
  process.exit(1)
}

/**
 * Parses CLI arguments into a browserUrl and passthrough flags
 *
 * --project <name>: resolves browserUrl from the config file by project name
 * --browserUrl <url>: specifies the Chrome remote debugging URL directly
 * All other flags are passed to chrome-devtools-mcp as is.
 * Exits with status 1 on an unknown project, an invalid URL, or when neither option is given.
 * @returns The parsed arguments
 */
function parseArgs(): ParsedArgs {
  const rawArgs = process.argv.slice(2)
  let browserUrl: string | null = null
  let projectName: string | undefined
  const passthroughArgs: string[] = []

  const index = { value: 0 }
  while (index.value < rawArgs.length) {
    const parsedProjectName = extractArgValue(rawArgs, index, '--project')
    if (parsedProjectName !== null) {
      browserUrl = resolveProject(parsedProjectName)
      if (!browserUrl) {
        process.stderr.write(
          `Error: Project "${parsedProjectName}" not found in config\n`
        )
        process.stderr.write(
          'Config file: ~/.config/chrome-mcp-router/config.json\n'
        )
        process.exit(1)
      }
      validateUrlOrExit(browserUrl, `project "${parsedProjectName}"`)
      projectName = parsedProjectName
      index.value++
      continue
    }

    const directUrl = extractArgValue(rawArgs, index, '--browserUrl')
    if (directUrl !== null) {
      browserUrl = directUrl
      validateUrlOrExit(browserUrl, 'browserUrl')
      index.value++
      continue
    }

    // Anything else is passed through to chrome-devtools-mcp
    passthroughArgs.push(rawArgs[index.value])
    index.value++
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

  return { browserUrl, projectName, passthroughArgs }
}

const { browserUrl, projectName, passthroughArgs } = parseArgs()
const bridge = new Bridge({
  browserUrl,
  projectName,
  passthroughArgs,
  onExit: () => process.exit(0),
})

bridge.start()

// Keep the process alive on stdout SIGPIPE / write errors
process.stdout.on('error', (err: Error) => {
  process.stderr.write(`[bridge] stdout error: ${err.message}\n`)
})

// Log uncaught exceptions and rejections and keep running, so the bridge stays alive
process.on('uncaughtException', (err: Error) => {
  process.stderr.write(`[bridge] Uncaught exception: ${err.stack ?? err.message}\n`)
})

process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`[bridge] Unhandled rejection: ${String(reason)}\n`)
})

// Ignore SIGPIPE (keep running even if the reader of stdout closes)
process.on('SIGPIPE', () => {
  process.stderr.write('[bridge] SIGPIPE received (ignored)\n')
})

process.on('SIGTERM', () => {
  bridge.stop()
  process.exit(0)
})

process.on('SIGINT', () => {
  bridge.stop()
  process.exit(0)
})
