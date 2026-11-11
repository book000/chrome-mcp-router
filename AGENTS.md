# AGENTS.md

Guidance for AI coding agents and contributors. `CLAUDE.md` imports this file, and `.github/copilot-instructions.md` adds the review checklist.

## Language

- All deliverables are written in **English**: commit messages, PR/Issue titles and bodies, review comments, code comments and JSDoc, and documentation (`README.md`, `AGENTS.md`, etc.).
- `README.ja.md` is an intentionally kept Japanese translation of `README.md`. Keep it in sync whenever `README.md` changes.
- Runtime messages (logs, errors) are English.
- Exceptions (keep as is): quotations, technical identifiers, generated files, and external source text.
- Do not rewrite Git history to change the language of past commits.

## Overview

`chrome-mcp-router` is a stdio proxy that wraps [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) and is published to npm as an npx-runnable CLI (`bin: chrome-mcp-router`). It adds two things:

- **Auto-reconnect**: polls Chrome's `/json/version` endpoint; when Chrome crashes and comes back, it restarts the child process and replays the MCP handshake so the client's session survives.
- **Project routing**: resolves the Chrome debug `browserUrl` from a project name defined in `~/.config/chrome-mcp-router/config.json`.

## Commands

```bash
pnpm install        # install dependencies
pnpm build          # tsc -p tsconfig.build.json (output to build/)
pnpm lint           # ESLint over src (lint:fix to fix)
pnpm test           # Vitest, single run
pnpm format         # Prettier write over src
pnpm typecheck      # tsc --noEmit
pnpm clean          # remove build/ and *.tsbuildinfo
```

- Use **pnpm** (version pinned by `packageManager` in `package.json`); do not use `npm` or `yarn`. Node.js is pinned in `.node-version` and `engines`.
- CI (`.github/workflows/nodejs-ci-pnpm.yml`, reusable workflow from `book000/templates`) runs the build, lint, and test scripts. `pnpm typecheck` is not run in CI and currently fails because of type errors in the Vitest typings and `health-monitor.test.ts`.
- `.github/workflows/release.yml` runs on every push to the default branch (`master`): it bumps the version from the commit prefix (`feat` minor; `fix`, `docs`, `chore`, `refactor`, `build`, `ci`, `revert`, `style`, `test`, `perf` patch; `release` or a breaking change major; any other or non-conventional commit defaults to minor) and publishes to npm. Choose the commit type deliberately.

## Architecture

Data flow: `MCP client (stdin/stdout) <-> Bridge <-> chrome-devtools-mcp (child process)`.

- `src/index.ts`: CLI entry point. Parses `--project` / `--browserUrl`, passes all other flags through to `chrome-devtools-mcp`, and installs process-level handlers that keep the bridge alive (`uncaughtException`, `unhandledRejection`, `SIGPIPE`).
- `src/bridge.ts`: the `Bridge` class. Spawns and supervises the child, proxies JSON-RPC line by line, buffers `initialize` and `notifications/initialized` for replay, and queues client messages during a reconnect (bounded by `MAX_PENDING_QUEUE_SIZE`). With a project name, it re-resolves `browserUrl` every 5 seconds and restarts the child if it changed.
- `src/health-monitor.ts`: `HealthMonitor extends EventTarget`. Polls Chrome every 3 seconds and dispatches `connected` / `disconnected` / `reconnected`.
- `src/config.ts`: loads and validates the config file, resolves a project name to a `browserUrl`, and validates that a URL is `http(s)`.
- `src/__tests__/`: Vitest unit tests for `config.ts` and `health-monitor.ts`. `Bridge` has no automated tests; verify reconnect behavior manually by killing and restarting Chrome against a live `--browserUrl`.

## Conventions

- TypeScript is `strict` with `noUnusedLocals`, `noUnusedParameters`, and `noImplicitReturns`. Keep the build clean and do not silence errors with `any`.
- `stdout` is the MCP JSON-RPC channel: never write anything but valid MCP JSON-RPC to it. Log diagnostics to `stderr` (`process.stderr.write`).
- Pass external input (config JSON, incoming JSON-RPC) through the existing validators (`validateConfig`, `parseJsonRpcMessage`, `isValidBrowserUrl`) instead of trusting its shape.
- Do not throw out of the reconnect and health paths; errors there are caught and logged so the bridge stays alive.
- Tests mock `node:fs` and `node:http`; follow that pattern instead of touching the real filesystem or network.
- Update `README.md` and `README.ja.md` when CLI options, the config schema, or behavior change, and update this file when commands or the structure change.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/); branches follow [Conventional Branch](https://conventional-branch.github.io) short form (`feat/...`, `fix/...`).
- Do not commit to Renovate PRs. Never commit secrets; `browserUrl` values are local debug endpoints, so do not hardcode real hosts.
