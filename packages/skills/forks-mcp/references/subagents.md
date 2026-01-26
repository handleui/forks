# Subagents (Delegation)

Subagents enable delegation of work to child agents. Spawn a subagent for a specific task and monitor its progress.

## When to Use

- Delegate a self-contained subtask
- Need to run work in parallel while continuing
- Want to isolate a specific piece of work
- Complex tasks that benefit from decomposition

## Tools

### subagent_spawn

Spawn a subagent to execute a streamed task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to spawn the subagent in |
| task | string | Yes | The task description for the subagent |

**Returns:** Subagent object with ID and initial status.

**Example:**
```json
{
  "chatId": "chat_abc123",
  "task": "Write comprehensive unit tests for the authentication module. Cover all edge cases including invalid tokens, expired sessions, and rate limiting."
}
```

### subagent_status

Get the current status of a subagent.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| subagentId | string | Yes | The ID of the subagent to check |

**Returns:** Subagent status including progress and result if completed.

**Example:**
```json
{
  "subagentId": "subagent_xyz789"
}
```

### subagent_cancel

Cancel a running subagent.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| subagentId | string | Yes | The ID of the subagent to cancel |

**Returns:** Confirmation of cancellation.

**Example:**
```json
{
  "subagentId": "subagent_xyz789"
}
```

## Subagent Lifecycle

```
1. SPAWN: subagent_spawn creates a new subagent
2. WORK: Subagent executes its task independently
3. STREAM: Progress is streamed back to parent
4. COMPLETE: Subagent finishes with result
```

## Statuses

- `running` - Subagent is actively working
- `completed` - Subagent finished successfully
- `failed` - Subagent encountered an error
- `cancelled` - Subagent was cancelled

## Best Practices

1. **Self-contained tasks**: Give subagents complete context to work independently
2. **Clear deliverables**: Specify what output is expected
3. **Check status periodically**: Monitor long-running subagents
4. **Cancel gracefully**: Cancel subagents that are no longer needed
5. **Handle failures**: Check for failed status and handle appropriately

## Subagents vs Attempts

| Aspect | Subagents | Attempts |
|--------|-----------|----------|
| Purpose | Delegate work | Explore options |
| Count | Usually 1 | Usually 2-5 |
| Result | Single output | Pick best |
| Use case | Known approach | Uncertain approach |
