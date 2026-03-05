#!/usr/bin/env node
import { Bridge } from './bridge'
import { resolveProject } from './config'

/** CLI 引数の解析結果 */
interface ParsedArgs {
  browserUrl: string
  passthroughArgs: string[]
}

/**
 * CLI 引数を解析して browserUrl と pass-through フラグを取得する
 *
 * --project <name>: 設定ファイルからプロジェクト名で browserUrl を解決する
 * --browserUrl <url>: Chrome のデバッグ URL を直接指定する
 * その他のフラグ: chrome-devtools-mcp に pass-through する
 * @returns 解析結果
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
          `Error: プロジェクト "${projectName}" が設定ファイルに見つかりません\n`
        )
        process.stderr.write(
          '設定ファイル: ~/.config/chrome-devtools-mcp-bridge/config.json\n'
        )
        process.exit(1)
      }
    } else if (arg.startsWith('--project=')) {
      const projectName = arg.slice('--project='.length)
      browserUrl = resolveProject(projectName)
      if (!browserUrl) {
        process.stderr.write(
          `Error: プロジェクト "${projectName}" が設定ファイルに見つかりません\n`
        )
        process.exit(1)
      }
    } else if (arg === '--browserUrl' && i + 1 < rawArgs.length) {
      browserUrl = rawArgs[++i]
    } else if (arg.startsWith('--browserUrl=')) {
      browserUrl = arg.slice('--browserUrl='.length)
    } else {
      // bridge が知らないフラグは chrome-devtools-mcp に pass-through する
      passthroughArgs.push(arg)
    }

    i++
  }

  if (!browserUrl) {
    process.stderr.write('Usage: chrome-devtools-mcp-bridge --project <name>\n')
    process.stderr.write(
      '   or: chrome-devtools-mcp-bridge --browserUrl <url>\n'
    )
    process.stderr.write('\nOptions:\n')
    process.stderr.write(
      '  --project <name>     設定ファイルのプロジェクト名で browserUrl を解決する\n'
    )
    process.stderr.write(
      '  --browserUrl <url>   Chrome のデバッグ URL (例: http://127.0.0.1:9222)\n'
    )
    process.stderr.write(
      '  その他のフラグは chrome-devtools-mcp に pass-through される\n'
    )
    process.stderr.write(
      '\n設定ファイル: ~/.config/chrome-devtools-mcp-bridge/config.json\n'
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
