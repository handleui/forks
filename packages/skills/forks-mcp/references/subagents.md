---
name: forks-mcp:subagents
description: Subagents execute a scoped task independently while the parent continues
---

# Subagents (Delegation)

Subagents execute a scoped task independently while the parent continues.

## When to Use

- Known subtask with clear deliverable
- Parallel execution without exploration
- Work that can be isolated safely

## Tools

### subagent_spawn

Spawn a subagent to execute a streamed task

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to spawn the subagent in |
| task | string | Yes | The task description for the subagent |

**Example (input)**
```json
{
  "chatId": "chat_123",
  "task": "value"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### subagent_status

Get the current status of a subagent

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| subagentId | string | Yes | The ID of the subagent to check |

**Example (input)**
```json
{
  "subagentId": "subagent_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### subagent_cancel

Cancel a running subagent

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| subagentId | string | Yes | The ID of the subagent to cancel |

**Example (input)**
```json
{
  "subagentId": "subagent_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### subagent_await

Block until all running subagents in a chat complete. Returns summary of final statuses.

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to await subagents for |
| timeout_ms | number | No | Maximum time to wait in ms (1000-600000, default 300000 = 5min) |

**Example (input)**
```json
{
  "chatId": "chat_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### subagent_list

List subagents in a chat, optionally filtered by status

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to list subagents for |
| status | string | No | Filter by status |
| limit | number | No | Maximum number of subagents to return (default 100) |
| offset | number | No | Number of subagents to skip for pagination |

**Example (input)**
```json
{
  "chatId": "chat_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

## Subagent Lifecycle

```
1. SPAWN: subagent_spawn creates a subagent
2. RUN: subagent works independently
3. MONITOR: subagent_status/subagent_list
4. AWAIT: subagent_await blocks until completion
5. CANCEL: subagent_cancel if no longer needed
```

## Statuses

- running
- completed
- failed
- cancelled
- interrupted

## Best Practices

1. Provide full context and explicit output format
2. Avoid spawning many subagents for simple tasks
3. Use subagent_list for shared visibility
