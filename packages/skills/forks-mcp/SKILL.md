---
name: forks-mcp
description: Forks orchestration tools for parallel exploration (attempts), delegation (subagents), approval workflows (plans), user interaction (questions), shared work coordination (tasks), and terminal management (terminals). Use when orchestrating AI agent workflows in the Forks platform.
---

# Forks MCP Tools

This skill documents the 26 MCP tools available in the Forks daemon for orchestrating AI agent workflows.

## Tool Categories

| Category | Tools | Purpose | Reference |
|----------|-------|---------|-----------|
| Attempts | 3 | Parallel exploration (poly-iteration) | [references/attempts.md](references/attempts.md) |
| Subagents | 3 | Delegate work to child agents | [references/subagents.md](references/subagents.md) |
| Plans | 5 | Approval workflows for changes | [references/plans.md](references/plans.md) |
| Questions | 5 | Ask user for input | [references/questions.md](references/questions.md) |
| Tasks | 5 | Shared work coordination | [references/tasks.md](references/tasks.md) |
| Terminals | 5 | Terminal session management | [references/terminals.md](references/terminals.md) |

## Quick Reference

### Attempts (Poly-Iteration)
Spawn multiple parallel agents to explore different solutions, then pick the best one.

- `attempt_spawn` - Spawn N parallel attempts for a task
- `attempt_pick` - Select the winning attempt
- `attempt_status` - Check status of all attempts

### Subagents (Delegation)
Delegate work to child agents that run independently.

- `subagent_spawn` - Spawn a subagent for a task
- `subagent_status` - Check subagent progress
- `subagent_cancel` - Cancel a running subagent

### Plans (Approval Workflows)
Propose plans and wait for user approval before executing.

- `plan_propose` - Submit a plan for approval
- `plan_respond` - Approve or reject a plan
- `plan_status` - Check plan status
- `plan_list` - List plans in a project
- `plan_cancel` - Cancel a pending plan

### Questions (User Interaction)
Ask the user questions and wait for their response.

- `ask_question` - Ask the user a question
- `ask_respond` - Provide an answer
- `question_status` - Check if answered
- `question_list` - List questions in a chat
- `question_cancel` - Cancel a pending question

### Tasks (Shared Work)
Coordinate work between multiple agents with a shared task list.

- `task_create` - Create a new task
- `task_claim` - Claim a task to work on
- `task_complete` - Mark task as done
- `task_fail` - Mark task as failed
- `task_list` - List all tasks

### Terminals (Session Management)
Access user terminals and spawn background processes.

- `list_terminals` - List all terminal sessions with metadata
- `read_terminal` - Get the output history buffer for a terminal
- `spawn_background_terminal` - Spawn a background terminal for dev servers, tests, etc.
- `promote_terminal` - Promote a background terminal to visible
- `kill_terminal` - Kill a background terminal owned by the agent

## Common Patterns

### Parallel Exploration
When unsure which approach is best, spawn multiple attempts:
```
1. attempt_spawn(chatId, count: 3, task: "Implement feature X")
2. Wait for attempts to complete
3. Review results and attempt_pick(bestAttemptId)
```

### Plan Before Execute
For significant changes, get approval first:
```
1. plan_propose(chatId, title: "Refactor auth", plan: "...")
2. Wait for plan_respond with approved: true
3. Execute the approved plan
```

### Clarify Requirements
When requirements are unclear, ask:
```
1. ask_question(chatId, "Should we support OAuth or JWT?")
2. Wait for ask_respond with answer
3. Proceed with clarified requirements
```

### Divide and Conquer
For large tasks, create subtasks for parallel work:
```
1. task_create(chatId, "Implement API endpoints")
2. task_create(chatId, "Write tests")
3. task_create(chatId, "Update documentation")
4. Agents claim and complete tasks independently
```

### Background Dev Servers
For long-running processes like dev servers:
```
1. list_terminals() to check existing sessions
2. spawn_background_terminal("npm run dev")
3. read_terminal(id) to check if server started
4. promote_terminal(id) when stable
```

## Terminal Security & Lifecycle

- **Command allowlist**: Only safe dev commands (npm, bun, vite, jest, etc.)
- **Rate limiting**: Max 3 spawns per minute, max 5 concurrent agent terminals
- **Inactivity timeout**: Background agent terminals auto-close after 5 minutes of inactivity
- **Ownership transfer**: When promoted, ownership transfers from agent to user

```
spawn_background_terminal() → background terminal (owner: agent)
        ↓                              ↓
   [5min timeout]              read_terminal() → get output
        ↓                              ↓
   auto-cleanup           promote_terminal() → visible (owner: user)
                                       ↓
                          kill_terminal() ← blocked (user-owned)
                                       ↓
                               terminal exits
```

## Input Validation

All tools validate inputs with these constraints:
- **IDs**: 1-128 characters, alphanumeric + underscore/hyphen only
- **Text**: 1-10,000 characters
- **Count**: 1-10 for attempt_spawn
- **Pagination**: limit 1-1000, offset >= 0

## Response Format

All tools return JSON in the format:
```json
{
  "content": [{ "type": "text", "text": "..." }],
  "isError": false
}
```

For detailed documentation on each tool category, read the appropriate reference file.
