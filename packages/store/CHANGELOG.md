# @forks-sh/store

## 0.1.1

### Patch Changes

- a60b086: Emit store events when attempt and subagent statuses change.
  Enables real-time status updates via the event emitter for downstream consumers.

## 0.1.0

### Minor Changes

- 88cd584: Add SQLite-based persistence layer for projects and workspaces using better-sqlite3.
  Includes CRUD operations, WAL mode for performance, and proper foreign key constraints.

### Patch Changes

- Updated dependencies [88cd584]
  - @forks-sh/protocol@0.1.0
