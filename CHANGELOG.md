# Changelog

## 0.1.0 — 2026-08-26

Initial release of `opencode-model-escalator`.

- Cheap → strong capability escalation on repeated identical test failures (Category B).
- Bounded Category-A (429 / 5xx / unavailable) same-model retry, latched at budget exhaustion.
- Same-session replay of the last user turn; no in-task de-escalation; reset on a new user task.
- Verified against **OpenCode 1.18.21**. Requires OpenCode `>= 1.18.21` (peer `@opencode-ai/plugin`).
