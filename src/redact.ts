const MASK = '***'

/**
 * Redacts a URL for diagnostics.
 * Replaces userinfo and query values with `***` and drops the fragment.
 * @param url The URL string to redact
 * @returns The redacted URL, or `[invalid URL]` if it cannot be parsed or is not http(s) (the input is never echoed)
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '[invalid URL]'
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '[invalid URL]'
  }

  let userinfo = ''
  if (parsed.username || parsed.password) {
    userinfo = `${MASK}${parsed.password ? `:${MASK}` : ''}@`
  }

  const query = parsed.search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((param) => {
      const eq = param.indexOf('=')
      return eq === -1 ? param : `${param.slice(0, eq)}=${MASK}`
    })
    .join('&')

  return `${parsed.protocol}//${userinfo}${parsed.host}${parsed.pathname}${query ? `?${query}` : ''}`
}

/**
 * Redacts passthrough arguments for diagnostics.
 * Keeps flag names and replaces every value with `***`.
 * @param args Raw arguments forwarded to the child process
 * @returns Arguments safe to log
 */
export function redactArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (!arg.startsWith('-')) {
      return MASK
    }
    const eq = arg.indexOf('=')
    return eq === -1 ? arg : `${arg.slice(0, eq)}=${MASK}`
  })
}
