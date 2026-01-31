---
name: forks-mcp
description: Forks MCP tools for orchestration, approvals, questions, tasks, terminals, and Graphite stack operations.
---

# Forks MCP Tools

This skill documents the 34 MCP tools available in forksd.

## Tool Categories

| Category | Count |
|----------|-------|
| Attempts | 3 |
| Subagents | 5 |
| Plans | 5 |
| Questions | 5 |
| Tasks | 8 |
| Terminals | 5 |
| Graphite | 3 |

## Quick Reference

### Attempts
- attempt_spawn
- attempt_pick
- attempt_status

### Subagents
- subagent_spawn
- subagent_status
- subagent_cancel
- subagent_await
- subagent_list

### Plans
- plan_propose
- plan_respond
- plan_status
- plan_list
- plan_cancel

### Questions
- question_create
- question_respond
- question_status
- question_list
- question_cancel

### Tasks
- task_create
- task_claim
- task_unclaim
- task_complete
- task_fail
- task_update
- task_delete
- task_list

### Terminals
- list_terminals
- read_terminal
- spawn_background_terminal
- promote_terminal
- kill_terminal

### Graphite
- graphite_stack
- graphite_continue
- graphite_abort

## Response Contract

All MCP tools return a JSON envelope where the real payload is JSON-encoded inside content.text.
Always parse content[0].text to get the payload.

**Success example (raw MCP response):**
```json
{
  "content": [
    { "type": "text", "text": "{\"id\":\"task_123\",\"status\":\"pending\"}" }
  ],
  "isError": false
}
```

**Parsed payload:**
```json
{ "id": "task_123", "status": "pending" }
```

**Error example (raw MCP response):**
```json
{
  "content": [
    { "type": "text", "text": "{\"error\":{\"message\":\"Not found\",\"code\":\"not_found\"}}" }
  ],
  "isError": true
}
```

**Parsed error:**
```json
{ "error": { "message": "Not found", "code": "not_found" } }
```

## Error Contract

- isError is true when the tool fails
- content.text is JSON with an error.message and optional error.code
- Validation errors from MCP may be returned as MCP protocol errors instead of tool output

## ID Availability

- chatId: provided by the chat context
- projectId: comes from the workspace/project selection
- planId: returned by plan_propose
- questionId: returned by question_create or question_list
- taskId: returned by task_create or task_list
- subagentId: returned by subagent_spawn or subagent_list
- attemptId: returned by attempt_spawn or attempt_status
- terminalId: returned by list_terminals or spawn_background_terminal

## Tool Selection Heuristics

- attempt_* when you are unsure and want multiple options
- subagent_* when you know the task and want parallel execution
- plan_* when changes need approval or are risky
- question_* when blocked by user preference or ambiguity
- task_* to coordinate work across agents

## Skill Injection Strategy

- Always load this SKILL.md as the core overview
- Load only the relevant reference docs per task: attempts, subagents, plans, questions, tasks, terminals, graphite

## Collision Mitigation

- Call these tools through the forksd MCP server to avoid name collisions
- Prefer the fully qualified server name when multiple MCP servers are configured

## Examples With IDs

**Plan approval flow**
1. plan_propose(chatId, title, plan) -> returns planId
2. plan_respond(planId, approved: true)
3. plan_status(planId)

**Question flow**
1. question_create(chatId, question) -> returns questionId
2. question_respond(questionId, answer)
3. question_status(questionId)

**Task flow**
1. task_create(chatId, description) -> returns taskId
2. task_claim(taskId)
3. task_complete(taskId, result)

**Terminal flow**
1. list_terminals() -> returns terminalId
2. read_terminal(terminalId)

**Graphite approval flow**
1. graphite_continue(chatId, cwd, all?) -> waits for approval
2. graphite_abort(chatId, cwd, force?)

For details on each tool category, read the reference docs in references/.