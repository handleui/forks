# Tasks (Shared Work Coordination)

Tasks enable coordination between multiple agents through a shared task list. Create tasks, claim them, and mark them complete or failed.

## When to Use

- Dividing work between multiple agents
- Tracking progress on multi-step work
- Ensuring work items aren't duplicated
- Coordinating parallel execution

## Tools

### task_create

Create a new task in the shared task list.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to create the task in |
| description | string | Yes | Description of the task to be done |

**Returns:** Task object with ID and pending status.

**Example:**
```json
{
  "chatId": "chat_abc123",
  "description": "Write unit tests for the UserService class covering all public methods"
}
```

### task_claim

Claim a task from the shared task list. Prevents other agents from working on it.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to claim |

**Returns:** Updated task showing it's claimed by you.

**Example:**
```json
{
  "taskId": "task_xyz789"
}
```

### task_complete

Mark a claimed task as complete with a result.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to complete |
| result | string | Yes | The result or output of the task |

**Returns:** Updated task with completed status and result.

**Example:**
```json
{
  "taskId": "task_xyz789",
  "result": "Added 15 unit tests covering all public methods. All tests passing. Coverage increased from 45% to 78%."
}
```

### task_fail

Mark a claimed task as failed with an optional error message.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to fail |
| result | string | No | Error message or reason for failure |

**Returns:** Updated task with failed status.

**Example:**
```json
{
  "taskId": "task_xyz789",
  "result": "Cannot write tests - the UserService class has circular dependencies that need to be resolved first."
}
```

### task_list

List all tasks in a chat with their statuses.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to list tasks for |

**Returns:** Array of all tasks with their current status.

**Example:**
```json
{
  "chatId": "chat_abc123"
}
```

## Task Lifecycle

```
1. CREATE: task_create adds task with status "pending"
2. CLAIM: Agent claims with task_claim, status becomes "claimed"
3. WORK: Agent works on the task
4. FINISH: task_complete or task_fail ends the task
```

## Statuses

- `pending` - Available to be claimed
- `claimed` - Being worked on by an agent
- `completed` - Successfully finished
- `failed` - Failed with error

## Best Practices

1. **Atomic tasks**: Create small, self-contained tasks
2. **Clear descriptions**: Include all context needed to complete
3. **Claim before working**: Always claim to prevent duplication
4. **Report results**: Include useful information in completion
5. **Fail gracefully**: Provide actionable error messages

## Coordination Pattern

```
Agent A (Coordinator):
1. task_create("Implement API endpoints")
2. task_create("Write integration tests")
3. task_create("Update API documentation")

Agent B:
1. task_list() - sees available tasks
2. task_claim("Implement API endpoints")
3. ... works on task ...
4. task_complete("Added 5 REST endpoints for user CRUD")

Agent C:
1. task_list() - sees remaining tasks
2. task_claim("Write integration tests")
3. ... works on task ...
4. task_complete("Added 12 integration tests, all passing")
```

## Task vs Subagent

| Aspect | Tasks | Subagents |
|--------|-------|-----------|
| Creation | Explicit create | Spawn on demand |
| Claiming | Any agent can claim | Owned by spawner |
| Visibility | Shared list | Private to parent |
| Use case | Work distribution | Work delegation |
