# Attempts (Poly-Iteration)

Attempts enable parallel exploration of multiple solution paths. Spawn several agents to work on the same task simultaneously, then pick the best result.

## When to Use

- Unsure which approach will work best
- Want to explore multiple solutions in parallel
- Need to compare different implementations
- Complex problems with multiple valid solutions

## Tools

### attempt_spawn

Spawn multiple parallel attempts to solve a task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to spawn attempts in |
| count | number | Yes | Number of parallel attempts (1-10) |
| task | string | Yes | The task description for attempts |

**Returns:** Array of attempt objects with IDs and initial status.

**Example:**
```json
{
  "chatId": "chat_abc123",
  "count": 3,
  "task": "Implement a caching layer for the API. Try different strategies: in-memory, Redis, and file-based."
}
```

### attempt_pick

Select the winning attempt from parallel attempts. Other attempts are discarded.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| attemptId | string | Yes | The ID of the attempt to pick as winner |

**Returns:** The picked attempt with its result.

**Example:**
```json
{
  "attemptId": "attempt_xyz789"
}
```

### attempt_status

Get the status of all attempts in a chat.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to check |

**Returns:** Array of all attempts with their current status (running, completed, picked, discarded).

**Example:**
```json
{
  "chatId": "chat_abc123"
}
```

## Attempt Lifecycle

```
1. SPAWN: attempt_spawn creates N attempts with status "running"
2. WORK: Each attempt works independently on the task
3. COMPLETE: Attempts finish with status "completed"
4. PICK: attempt_pick selects winner, others become "discarded"
```

## Statuses

- `running` - Attempt is actively working
- `completed` - Attempt finished its work
- `picked` - Selected as the winning attempt
- `discarded` - Not selected, discarded

## Best Practices

1. **Clear task descriptions**: Give each attempt enough context to work independently
2. **Reasonable count**: 2-5 attempts is usually sufficient; more can waste resources
3. **Review before picking**: Check all completed attempts before selecting
4. **Different approaches**: Phrase tasks to encourage different solutions
