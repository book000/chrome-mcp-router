# chrome-mcp-router

A proxy wrapper for [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) that adds automatic reconnection and project-based configuration.

- **Auto-reconnect**: Detects Chrome crashes and automatically restarts the child process when Chrome comes back up
- **Project routing**: Resolve the Chrome debugging URL by project name instead of specifying a port number directly

## Installation

```bash
# Run via npx (no install required)
npx -y chrome-mcp-router@latest --project myproject
```

## Usage

### .mcp.json

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

### CLI options

```
chrome-mcp-router --project <name>
chrome-mcp-router --browserUrl <url>
```

| Option | Description |
| --- | --- |
| `--project <name>` | Resolve `browserUrl` from config file by project name |
| `--browserUrl <url>` | Chrome remote debugging URL (e.g. `http://127.0.0.1:9222`) |

Any other flags (`--slim`, `--no-usage-statistics`, etc.) are passed through to `chrome-devtools-mcp`.

### Config file

Create `~/.config/chrome-mcp-router/config.json` with a mapping of project names to URLs:

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

1. If `--project` is given, resolves `browserUrl` from the config file
2. Spawns `chrome-devtools-mcp` as a child process and proxies stdio bidirectionally
3. Polls Chrome's `/json/version` endpoint every 3 seconds
4. When Chrome restarts after a crash, kills the stale child process, spawns a fresh one, and replays the MCP handshake to restore the session transparently

## License

MIT
