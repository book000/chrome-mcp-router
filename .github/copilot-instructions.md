# Copilot code review instructions

Follow `AGENTS.md` at the repository root for the project overview, commands, and conventions. Review against it and focus on the points below.

## Language

- Deliverables (code comments, JSDoc, docs, commit messages, PR/Issue text) are English; runtime messages are English.
- `README.ja.md` is an intentional Japanese translation of `README.md`. Flag changes to CLI options, config schema, or behavior that update only one of them.
- Do not suggest rewriting Git history.

## Review checklist

- **stdout is the MCP JSON-RPC channel.** Flag any non-protocol output to `stdout` (`console.log`, stray `process.stdout.write`); diagnostics go to `stderr`.
- **Untrusted input.** Config file contents and incoming JSON-RPC must go through the existing validators (`validateConfig`, `parseJsonRpcMessage`, `isValidBrowserUrl`).
- **Resilience paths must not throw out.** Flag changes that let exceptions escape the reconnect or health-monitor code, or that remove the process-level handlers in `src/index.ts`.
- **Resource lifecycle.** `readline` interfaces, timers (`setInterval`), and child processes must be closed or cleared on exit and reconnect. The pending-message queue is bounded by `MAX_PENDING_QUEUE_SIZE`; flag unbounded buffering.
- **MCP handshake replay.** Changes must keep the client session consistent (e.g. the duplicate `initialize` response stays suppressed).
- **Tests.** New logic in `config.ts` or `health-monitor.ts` needs Vitest tests that follow the existing mocking pattern.
- **Tooling.** pnpm only (flag `npm`/`yarn` usage); do not raise style nits that ESLint and Prettier already handle; flag new `any`.
