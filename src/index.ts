#!/usr/bin/env node
import { Bridge } from './bridge'
import { isValidBrowserUrl, resolveProject } from './config'

/** パース済みの CLI 引数 */
interface ParsedArgs {
  /** Chrome リモートデバッグ URL */
  browserUrl: string
  /** chrome-devtools-mcp にそのまま渡すフラグ */
  passthroughArgs: string[]
}

/**
 * `--key value` または `--key=value` 形式の CLI 引数を取得する
 *
 * `--key=value` 形式の場合は `=` 以降の値を返し、インデックスはそのまま。
 * `--key value` 形式の場合は次の引数を値として返し、インデックスを 1 進める。
 * @param args 引数配列
 * @param index 現在のインデックス（参照渡し用オブジェクト）
 * @param prefix `--key` 部分の文字列（例: `'--project'`）
 * @returns 値の文字列。マッチしない場合は null
 */
function extractArgValue(
  args: string[],
  index: { value: number },
  prefix: string
): string | null {
  const arg = args[index.value]
  const eqPrefix = `${prefix}=`
  if (arg === prefix && index.value + 1 < args.length) {
    index.value++
    return args[index.value]
  }
  if (arg.startsWith(eqPrefix)) {
    return arg.slice(eqPrefix.length)
  }
  return null
}

/**
 * URL のバリデーションを行い、無効な場合はエラーメッセージを出力して終了する
 * @param url 検証する URL 文字列
 * @param label エラーメッセージに含めるラベル（例: `'project "foo"'`）
 */
function validateUrlOrExit(url: string, label: string): void {
  if (!isValidBrowserUrl(url)) {
    process.stderr.write(`Error: Invalid URL for ${label}: ${url}\n`)
    process.stderr.write('URL must start with http:// or https://\n')
    process.exit(1)
  }
}

/**
 * CLI 引数をパースして browserUrl とパススルーフラグを返す
 *
 * --project <name>: 設定ファイルからプロジェクト名で browserUrl を解決する
 * --browserUrl <url>: Chrome リモートデバッグ URL を直接指定する
 * その他のフラグはすべて chrome-devtools-mcp にそのまま渡す
 * @returns パース済みの引数
 */
function parseArgs(): ParsedArgs {
  const rawArgs = process.argv.slice(2)
  let browserUrl: string | null = null
  const passthroughArgs: string[] = []

  const index = { value: 0 }
  while (index.value < rawArgs.length) {
    // --project の処理
    const projectName = extractArgValue(rawArgs, index, '--project')
    if (projectName !== null) {
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
      validateUrlOrExit(browserUrl, `project "${projectName}"`)
      index.value++
      continue
    }

    // --browserUrl の処理
    const directUrl = extractArgValue(rawArgs, index, '--browserUrl')
    if (directUrl !== null) {
      browserUrl = directUrl
      validateUrlOrExit(browserUrl, 'browserUrl')
      index.value++
      continue
    }

    // 不明なフラグは chrome-devtools-mcp にそのまま渡す
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

  return { browserUrl, passthroughArgs }
}

const { browserUrl, passthroughArgs } = parseArgs()
const bridge = new Bridge({
  browserUrl,
  passthroughArgs,
  onExit: () => process.exit(0),
})

bridge.start()

// stdout の SIGPIPE / write エラーでプロセスがクラッシュしないようにする
process.stdout.on('error', (err: Error) => {
  process.stderr.write(`[bridge] stdout error: ${err.message}\n`)
})

// 未処理の例外・Rejection をログに記録して継続する（Bridge プロセスを生かし続ける）
process.on('uncaughtException', (err: Error) => {
  process.stderr.write(`[bridge] Uncaught exception: ${err.stack ?? err.message}\n`)
})

process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`[bridge] Unhandled rejection: ${String(reason)}\n`)
})

// SIGPIPE を無視する（stdout の読み取り側が閉じられても継続）
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
