---
name: forks-mcp:plans
description: Plans capture intended changes and wait for user approval before execution
---

# Plans (Approval Workflows)

Plans capture intended changes and wait for user approval before execution.

## When to Use

- Significant or risky changes
- User confirmation required
- Multiple valid approaches and user should choose

## Tools

### plan_propose

Propose a plan and wait for user approval

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to propose the plan in |
| title | string | Yes | A short title for the plan (AI-generated name) |
| plan | string | Yes | The plan content to propose |

**Example (input)**
```json
{
  "chatId": "chat_123",
  "title": "value",
  "plan": "value"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### plan_respond

Respond to a proposed plan (approve or reject)

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| planId | string | Yes | The ID of the plan to respond to |
| approved | boolean | Yes | Whether to approve (true) or reject (false) the plan |
| feedback | string | No | Optional feedback for the plan (e.g., rejection reason) |

**Example (input)**
```json
{
  "planId": "plan_123",
  "approved": true
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### plan_status

Get the current status of a plan by ID

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| planId | string | Yes | The ID of the plan to check |

**Example (input)**
```json
{
  "planId": "plan_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### plan_list

List all plans in a project

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectId | string | Yes | The project ID to list plans for |
| status | string | No | Filter plans by status |
| limit | number | No | Maximum number of plans to return (default 100) |
| offset | number | No | Number of plans to skip for pagination |

**Example (input)**
```json
{
  "projectId": "project_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### plan_cancel

Cancel a pending plan (agent-initiated)

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| planId | string | Yes | The ID of the plan to cancel |

**Example (input)**
```json
{
  "planId": "plan_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

## Plan Lifecycle

```
1. PROPOSE: plan_propose creates a pending plan
2. RESPOND: plan_respond approves or rejects
3. EXECUTE: proceed only if approved
```

## Statuses

- pending
- approved
- rejected
- cancelled

## Plan Content Template

```markdown
## Summary
What this plan changes.

## Steps
1. Step one
2. Step two

## Impact
- User-visible effects
- Rollback strategy
```
