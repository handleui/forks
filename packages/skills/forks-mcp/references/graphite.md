---
name: forks-mcp:graphite
description: Graphite tools expose stack operations. Read-only stack inspection is safe; destructive operations require approval
---

# Graphite (Stack Operations)

Graphite tools expose stack operations. Read-only stack inspection is safe; destructive operations require approval.

## When to Use

- Inspect current stack state
- Continue or abort a restack after resolving conflicts

## Tools

### graphite_stack

Get the current Graphite stack information including branches, PR numbers, and restack status. Read-only operation.

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| cwd | string | Yes | Working directory of the Graphite-enabled repository |

**Example (input)**
```json
{
  "cwd": "/path/to/repo"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### graphite_continue

Continue a Graphite rebase/restack operation after resolving conflicts. Use after manually resolving merge conflicts.

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID requesting approval |
| cwd | string | Yes | Working directory of the Graphite-enabled repository |
| all | boolean | No | Stage all changes before continuing |

**Example (input)**
```json
{
  "chatId": "chat_123",
  "cwd": "/path/to/repo"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### graphite_abort

Abort an in-progress Graphite rebase/restack operation. Use to escape from a conflict state without resolving.

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID requesting approval |
| cwd | string | Yes | Working directory of the Graphite-enabled repository |
| force | boolean | No | Force abort even with unresolved conflicts |

**Example (input)**
```json
{
  "chatId": "chat_123",
  "cwd": "/path/to/repo"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

## Approval Gate

- graphite_continue and graphite_abort require explicit user approval
- The MCP call waits for approval or timeout
- Approval events are emitted to the UI via the approvals system

## Requirements

- Graphite CLI must be installed
- Repository must be initialized with gt init
