# Copilot code review instructions

`chrome-mcp-router` is a TypeScript stdio proxy that wraps `chrome-devtools-mcp`,
adding auto-reconnect on Chrome crashes and project-name based `browserUrl`
resolution. It runs as an npx CLI. When reviewing, focus on the points below.

## Project conventions

- Package manager is **pnpm** (not npm/yarn). Flag scripts or docs that invoke
  `npm`/`yarn` for this repo.
- Linting/formatting is enforced by `@book000/eslint-config` and Prettier; do
  not raise style nits that these tools already handle.
- `strict` TypeScript with `noUnusedLocals`/`noUnusedParameters`/
  `noImplicitReturns`. Flag new `any` and non-null assertions used to bypass the
  strict checks.
- Comments and JSDoc are Japanese by project convention — this is intentional,
  not a defect.

## What to prioritize in review

- **stdout is the MCP JSON-RPC channel.** Flag any non-protocol output written
  to `stdout` (`console.log`, stray `process.stdout.write`); diagnostics must go
  to `stderr`.
- **Untrusted input validation.** Config file contents and incoming JSON-RPC are
  external input. New parsing paths should go through the existing validators
  (`validateConfig`, `parseJsonRpcMessage`, `isValidBrowserUrl`) rather than
  trusting the shape.
- **Resilience paths must not throw out.** The reconnect and health-monitor code
  is designed to catch and log errors so the bridge stays alive. Flag changes
  that let exceptions escape those paths or that remove the process-level
  handlers in `src/index.ts`.
- **Child process and resource lifecycle.** Watch for leaks: `readline`
  interfaces, timers (`setInterval`), and child processes must be closed/cleared
  on exit and reconnect. The pending-message queue is bounded by
  `MAX_PENDING_QUEUE_SIZE`; flag unbounded buffering.
- **MCP handshake replay.** Reconnect logic buffers and replays `initialize` and
  `notifications/initialized`; verify changes here keep the client session
  consistent (e.g. suppressed duplicate `initialize` responses).

## Testing expectations

- Tests use Vitest and mock `node:fs` and network access. New logic in
  `config.ts` / `health-monitor.ts` should come with unit tests that follow the
  existing mocking pattern; flag PRs that add such logic without tests.

## Documentation

- `README.md` (English) and `README.ja.md` (Japanese) must stay in sync. Flag
  changes to CLI options, config schema, or behavior that update only one.
