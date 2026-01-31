---
name: forks-mcp:tasks
description: Tasks coordinate multiple agents through a shared task list
---

# Tasks (Shared Work Coordination)

Tasks coordinate multiple agents through a shared task list.

## When to Use

- Divide work among agents
- Track progress for multi-step work
- Avoid duplicated effort

## Tools

### task_create

Create a new task in the shared task list

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to create the task in |
| description | string | Yes | Description of the task to be done |
| planId | string | No | Optional plan ID to link this task to |

**Example (input)**
```json
{
  "chatId": "chat_123",
  "description": "value"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### task_claim

Claim a task from the shared task list

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to claim |

**Example (input)**
```json
{
  "taskId": "task_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### task_unclaim

Release a claimed task back to pending status with optional context for the next agent

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to unclaim |
| reason | string | No | Optional reason or context for unclaiming (helps next agent understand what was attempted) |

**Example (input)**
```json
{
  "taskId": "task_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### task_complete

Mark a claimed task as complete with a result

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to complete |
| result | string | Yes | The result or output of the completed task |

**Example (input)**
```json
{
  "taskId": "task_123",
  "result": "value"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### task_fail

Mark a claimed task as failed with an optional error message

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to fail |
| result | string | No | Optional error message or reason for failure |

**Example (input)**
```json
{
  "taskId": "task_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### task_update

Update a task's description

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to update |
| description | string | No | New description for the task |

**Example (input)**
```json
{
  "taskId": "task_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### task_delete

Delete a task from the task list

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| taskId | string | Yes | The ID of the task to delete |

**Example (input)**
```json
{
  "taskId": "task_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### task_list

List tasks by chat ID or plan ID. At least one of chatId or planId must be provided.

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | No | The chat ID to list tasks for |
| planId | string | No | The plan ID to list tasks for |

**Example (input)**
```json
{}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

## Task Lifecycle

```
1. CREATE: task_create
2. CLAIM: task_claim or task_unclaim
3. UPDATE: task_update (optional)
4. FINISH: task_complete/task_fail
5. CLEANUP: task_delete (optional)
```

## Statuses

- pending
- claimed
- completed
- failed

## Best Practices

1. Keep tasks atomic and well-scoped
2. Always claim before working
3. Provide useful results on completion
