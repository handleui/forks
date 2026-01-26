# @forks-sh/runner

## 0.1.0

### Minor Changes

- a60b086: Add Runner class for executing subagents and attempt batches via Codex adapter.
  Includes ExecutionRegistry for tracking active executions with O(1) lookups by context, thread, and chat ID.
  Supports graceful shutdown, cancellation, and resource limits to prevent runaway executions.

### Patch Changes

- Updated dependencies [a60b086]
- Updated dependencies [4799f2a]
  - @forks-sh/store@0.1.1
  - @forks-sh/codex@0.1.0
