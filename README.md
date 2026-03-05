# chrome-mcp-router

A proxy wrapper for [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) that adds auto-reconnect and project-based configuration.

- **Auto-reconnect**: Detects Chrome crashes and automatically restarts the child process when Chrome comes back up
- **Project routing**: Resolve Chrome debug URLs by project name instead of specifying port numbers directly

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
| `--project <name>` | Resolve `browserUrl` by project name from the config file |
| `--browserUrl <url>` | Specify Chrome debug URL directly (e.g. `http://127.0.0.1:9222`) |

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
2. Starts `chrome-devtools-mcp` as a child process and bidirectionally proxies stdio
3. Polls Chrome's `/json/version` endpoint every 3 seconds to check liveness
4. When it detects that Chrome has restarted after a crash, stops the old child process, starts a new one, and transparently restores the session by replaying the MCP handshake

## License

MIT
