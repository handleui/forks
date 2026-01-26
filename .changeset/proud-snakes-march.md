---
"forksd": minor
---

Integrate runner to execute subagents and attempt batches via MCP tools.
The spawn and cancel tool handlers now delegate to the runner for actual Codex execution.
Adds graceful runner shutdown on process termination.
