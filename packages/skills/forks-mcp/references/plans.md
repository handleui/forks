# Plans (Approval Workflows)

Plans enable approval workflows before executing significant changes. Propose a plan, wait for user approval, then proceed.

## When to Use

- Before making significant code changes
- When user confirmation is required
- For destructive or irreversible operations
- When multiple approaches exist and user should choose

## Tools

### plan_propose

Propose a plan and wait for user approval.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to propose the plan in |
| title | string | Yes | A short title for the plan |
| plan | string | Yes | The detailed plan content |

**Returns:** Plan object with ID and pending status.

**Example:**
```json
{
  "chatId": "chat_abc123",
  "title": "Refactor Authentication System",
  "plan": "## Summary\nMigrate from session-based to JWT authentication.\n\n## Steps\n1. Add JWT library\n2. Create token generation/validation\n3. Update middleware\n4. Migrate existing sessions\n\n## Impact\n- All users will need to re-login\n- API contracts remain unchanged"
}
```

### plan_respond

Respond to a proposed plan (approve or reject).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| planId | string | Yes | The ID of the plan to respond to |
| approved | boolean | Yes | true to approve, false to reject |
| feedback | string | No | Optional feedback or rejection reason |

**Returns:** Updated plan with new status.

**Example (approve):**
```json
{
  "planId": "plan_xyz789",
  "approved": true
}
```

**Example (reject):**
```json
{
  "planId": "plan_xyz789",
  "approved": false,
  "feedback": "Please also add refresh token support"
}
```

### plan_status

Get the current status of a plan by ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| planId | string | Yes | The ID of the plan to check |

**Returns:** Plan with current status and any feedback.

### plan_list

List all plans in a project.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| projectId | string | Yes | The project ID to list plans for |
| status | string | No | Filter: pending, approved, rejected, cancelled |
| limit | number | No | Max results (default 100, max 1000) |
| offset | number | No | Pagination offset |

**Returns:** Array of plans matching the filter.

### plan_cancel

Cancel a pending plan (agent-initiated).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| planId | string | Yes | The ID of the plan to cancel |

**Returns:** Confirmation of cancellation.

## Plan Lifecycle

```
1. PROPOSE: Agent creates plan with plan_propose
2. PENDING: Plan awaits user review
3. RESPOND: User approves/rejects via plan_respond
4. EXECUTE: If approved, agent proceeds with plan
```

## Statuses

- `pending` - Awaiting user response
- `approved` - User approved the plan
- `rejected` - User rejected the plan
- `cancelled` - Agent cancelled the plan

## Best Practices

1. **Clear titles**: Make plans easy to identify
2. **Structured content**: Use markdown for readability
3. **Include impact**: Explain consequences of the plan
4. **Handle rejection**: Use feedback to improve and re-propose
5. **Don't over-plan**: Only use for significant changes

## Plan Content Template

```markdown
## Summary
Brief description of what this plan accomplishes.

## Steps
1. First step
2. Second step
3. Third step

## Files Affected
- path/to/file1.ts
- path/to/file2.ts

## Impact
- What changes for users
- Any breaking changes
- Rollback strategy
```
