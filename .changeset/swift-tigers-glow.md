---
"@forks-sh/runner": minor
---

Add Runner class for executing subagents and attempt batches via Codex adapter.
Includes ExecutionRegistry for tracking active executions with O(1) lookups by context, thread, and chat ID.
Supports graceful shutdown, cancellation, and resource limits to prevent runaway executions.
