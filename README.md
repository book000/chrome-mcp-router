# chrome-mcp-router

A proxy wrapper for [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) that adds auto-reconnect and project-based configuration.

- **Auto-reconnect**: Detects Chrome crashes and automatically restarts the child process when Chrome comes back up
- **Project routing**: Resolve Chrome debug URLs by project name instead of specifying port numbers directly

## Requirements

- Node.js 26.13.0 (the `engines` field in `package.json`)
- Chrome started with remote debugging enabled (e.g. `--remote-debugging-port=9222`)

## Installation

```bash
# Run with npx (no installation required)
npx -y chrome-mcp-router@latest --project myproject
```

## Usage

### .mcp.json configuration

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-mcp-router@latest", "--project", "myproject"]
    }
  }
}
```

### CLI Options

```
chrome-mcp-router --project <name>
chrome-mcp-router --browserUrl <url>
```

| Option | Description |
| --- | --- |
| `--project <name>` | Resolve `browserUrl` by project name from the config file. Exits with an error if the project is not found |
| `--browserUrl <url>` | Specify Chrome debug URL directly (e.g. `http://127.0.0.1:9222`). Must start with `http://` or `https://` |

Other flags (`--slim`, `--no-usage-statistics`, etc.) are passed through to `chrome-devtools-mcp`.

### Config file

Specify project name to URL mappings in `~/.config/chrome-mcp-router/config.json`.

```json
{
  "projects": {
    "myproject": {
      "browserUrl": "http://127.0.0.1:9200"
    },
    "anotherproject": {
      "browserUrl": "http://127.0.0.1:9201"
    }
  }
}
```

## How it works

1. If `--project` is specified, resolves `browserUrl` by project name from the config file
2. Starts `chrome-devtools-mcp` as a child process (the binary in `PATH` if found, otherwise `npx -y chrome-devtools-mcp`) and bidirectionally proxies stdio
3. Polls Chrome's `/json/version` endpoint every 3 seconds to check liveness
4. When it detects that Chrome has restarted after a crash, stops the old child process, starts a new one, and transparently restores the session by replaying the MCP handshake
5. If `--project` is specified, re-resolves `browserUrl` from the config file every 5 seconds; if it has changed, restarts the child process with the new URL

Requests from the client (other than `initialize`) receive a JSON-RPC error (`-32000`) while the child process is not running and no reconnection is in progress (for example, after the child exits while Chrome is unreachable); while the child is still running, requests are forwarded to it even if Chrome is down. Messages received during a reconnection are queued (up to 500; when full, the oldest is dropped, and a dropped request is answered with the same error). Diagnostics are written to stderr; the bridge writes only MCP JSON-RPC messages to stdout (the child's output is forwarded as is).

## License

MIT
