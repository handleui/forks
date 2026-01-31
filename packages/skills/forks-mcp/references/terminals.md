---
name: forks-mcp:terminals
description: Terminal tools provide read-only access to user terminals and controlled spawning of background processes
---

# Terminals (PTY Access)

Terminal tools provide read-only access to user terminals and controlled spawning of background processes.

## When to Use

- Inspect output from a user terminal
- Start a background dev server or test runner
- Promote a background terminal to the UI

## Tools

### list_terminals

List all terminal sessions with metadata (id, cwd, owner, visible)

**Parameters**
No parameters.

**Example (input)**
```json
{}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### read_terminal

Get the output history buffer for a terminal (for @terminal context)

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| terminalId | string | Yes | The ID of the terminal to read |

**Example (input)**
```json
{
  "terminalId": "pty_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### spawn_background_terminal

Spawn a background terminal for running dev servers, tests, etc.

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| cwd | string | Yes | Working directory for the terminal |
| command | array<string> | Yes | Command and arguments to run (e.g., ["npm", "run", "dev"]) |

**Example (input)**
```json
{
  "cwd": "/path/to/repo",
  "command": [
    "npm",
    "run",
    "dev"
  ]
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### promote_terminal

Promote a background terminal to visible (for Cursor handoff)

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| terminalId | string | Yes | The ID of the terminal to promote |

**Example (input)**
```json
{
  "terminalId": "pty_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### kill_terminal

Kill a background terminal owned by this agent. Cannot kill visible or user-owned terminals.

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| terminalId | string | Yes | The ID of the terminal to kill |

**Example (input)**
```json
{
  "terminalId": "pty_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

## Security and Limits

- Blocked commands include: rm, sudo, chmod, chown, mkfs, dd, fdisk, shutdown
- Blocked patterns include: rm -rf /, pipe to shell, eval, backticks
- Rate limit: 3 spawns per minute
- Concurrency limit: 5 agent terminals
- Agent can only kill agent-owned background terminals

## Lifecycle

```
spawn_background_terminal -> owner: agent, visible: false
promote_terminal -> owner: user, visible: true
kill_terminal -> only if owner: agent and visible: false
```
