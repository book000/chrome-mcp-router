# CLAUDE.md

## Overview

`chrome-mcp-router` is a stdio proxy that wraps
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).
It adds two things on top of the upstream MCP server:

- **Auto-reconnect**: polls Chrome's `/json/version` endpoint, and when Chrome
  crashes and comes back it restarts the child process and replays the MCP
  handshake so the client's session survives transparently.
- **Project routing**: resolves the Chrome debug `browserUrl` from a project
  name defined in `~/.config/chrome-mcp-router/config.json`.

It ships as an npx-runnable CLI (`bin: chrome-mcp-router`).

## Development commands

- `pnpm build`: compile with `tsc -p tsconfig.build.json` (output to `build/`).
- `pnpm test`: run the Vitest suite once (`vitest run`).
- `pnpm lint` / `pnpm lint:fix`: ESLint over `src` (also enforced in CI).
- `pnpm format`: Prettier write over `src`.
- `pnpm typecheck`: `tsc --noEmit`.
- `pnpm clean`: remove `build/` and `*.tsbuildinfo`.

This repo uses **pnpm** (see `packageManager` in `package.json`); do not use
`npm` or `yarn`. Node `>=20.19.0` is required.

## Architecture

Data flow: `MCP client (stdin/stdout) <-> Bridge <-> chrome-devtools-mcp (child)`.

- `src/index.ts`: CLI entry point. Parses `--project` / `--browserUrl`, passes
  all other flags through to `chrome-devtools-mcp`, and installs
  process-level handlers that keep the bridge alive (`uncaughtException`,
  `unhandledRejection`, `SIGPIPE`, etc.).
- `src/bridge.ts`: the core `Bridge` class. Spawns and supervises the child,
  proxies JSON-RPC line by line, buffers the `initialize` request and
  `notifications/initialized` for replay, and queues client messages during a
  reconnect (bounded by `MAX_PENDING_QUEUE_SIZE`). When started with a project
  name, it also re-resolves `browserUrl` from the config file every 5 seconds
  and restarts the child process if it changed.
- `src/health-monitor.ts`: `HealthMonitor extends EventTarget`. Polls Chrome
  and dispatches `connected` / `disconnected` / `reconnected` events.
- `src/config.ts`: loads and validates the config file, resolves a project name
  to a `browserUrl`, and validates that a URL is `http(s)`.
- `src/__tests__/`: Vitest unit tests (`config.test.ts`, `health-monitor.test.ts`).

## Coding conventions

- TypeScript is `strict` with `noUnusedLocals` / `noUnusedParameters` /
  `noImplicitReturns` on; keep the build clean, do not silence with `any`.
- Comments and JSDoc are written in **Japanese** (match the existing files).
- Recommended: guard every unvalidated external input (config JSON, incoming
  JSON-RPC) through the existing validators (`validateConfig`,
  `parseJsonRpcMessage`) rather than trusting the shape.
- Recommended: log diagnostics to `stderr` (`process.stderr.write`). `stdout`
  is the MCP JSON-RPC channel — never write non-protocol text to it.
- Discouraged: throwing out of the reconnect/health paths; errors there are
  caught and logged so the bridge stays alive.

## Testing

- `pnpm test` runs Vitest. `node:fs` and network calls are mocked in tests
  (see `config.test.ts`); follow that pattern rather than touching the real
  filesystem or network.
- There is no coverage of the full `Bridge` reconnect flow via automated tests;
  verify reconnect behavior manually by killing and restarting Chrome against a
  live `--browserUrl`.

## Documentation update rules

- Keep `README.md` (English) and `README.ja.md` (Japanese) in sync when CLI
  options, config schema, or behavior change.
- Update this file when commands, the directory layout, or the config schema
  change.

## Security / prohibitions

- Never commit secrets. `browserUrl` values are local debug endpoints; do not
  hardcode real hosts into the repo.
- Do not write anything but valid MCP JSON-RPC to `stdout`.
