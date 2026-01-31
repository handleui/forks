---
name: forks-mcp:attempts
description: Attempts run multiple candidate solutions in parallel, then pick the best result
---

# Attempts (Parallel Exploration)

Attempts run multiple candidate solutions in parallel, then pick the best result.

## When to Use

- Unclear best approach
- Need quick comparison of strategies
- Risky change that benefits from alternatives

## Tools

### attempt_spawn

Spawn multiple parallel attempts to solve a task (poly-iteration)

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to spawn attempts in |
| count | number | Yes | Number of parallel attempts to spawn |
| task | string | Yes | The task description for the attempts |

**Example (input)**
```json
{
  "chatId": "chat_123",
  "count": 3,
  "task": "value"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### attempt_pick

Select the winning attempt from parallel attempts

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| attemptId | string | Yes | The ID of the attempt to pick as the winner |

**Example (input)**
```json
{
  "attemptId": "attempt_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### attempt_status

Get the status of all attempts in a chat

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to get attempt statuses for |

**Example (input)**
```json
{
  "chatId": "chat_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

## Attempt Lifecycle

```
1. SPAWN: attempt_spawn creates N attempts
2. RUN: each attempt works independently
3. REVIEW: inspect attempt outputs
4. PICK: attempt_pick selects the winner
```

## Statuses

- running
- completed
- failed
- picked
- discarded

## Best Practices

1. Keep attempt tasks focused and comparable
2. Use 2-5 attempts for most decisions
3. Pick promptly to reduce resource usage
