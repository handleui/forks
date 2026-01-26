# Terminal Tools Reference

Terminal tools provide agents with read-only access to user terminals and controlled spawning of background processes.

## Architecture

Two separate terminal systems:

1. **Codex internal shell** - Sandboxed command execution (unchanged by these tools)
2. **PTY pool** - User terminals + agent background terminals + @terminal context

Agents access the PTY pool via MCP tools (read-only bridge to user terminals, controlled spawning for background processes).

## Tools

### list_terminals

List all terminal sessions with metadata.

**Input**
```json
{}
```

**Output**
```json
{
  "content": [{
    "type": "text",
    "text": "[{\"id\":\"pty-abc123\",\"cwd\":\"/project\",\"owner\":\"user\",\"visible\":true,\"createdAt\":1706234567890}]"
  }]
}
```

**Session Metadata**
- `id` - Unique terminal identifier
- `cwd` - Working directory
- `owner` - `"user"` or `"agent"`
- `visible` - Whether terminal is visible to user
- `createdAt` - Unix timestamp (ms)
- `command` - Command array (for agent-spawned terminals)

### read_terminal

Get the output history buffer for a terminal. Used for @terminal context.

**Input**
```json
{
  "terminalId": "pty-abc123"
}
```

**Output**
```json
{
  "content": [{
    "type": "text",
    "text": "{\"terminalId\":\"pty-abc123\",\"history\":\"$ npm run dev\\nServer started on port 3000\\n\"}"
  }]
}
```

**Notes**
- History buffer is 64KB (ring buffer, truncates oldest data)
- Truncation happens at newline boundaries when possible
- Returns empty string if terminal has no output

### spawn_background_terminal

Spawn a background terminal for running dev servers, tests, etc.

**Input**
```json
{
  "cwd": "/path/to/project",
  "command": ["npm", "run", "dev"]
}
```

**Output**
```json
{
  "content": [{
    "type": "text",
    "text": "{\"id\":\"pty-xyz789\",\"cwd\":\"/path/to/project\",\"owner\":\"agent\",\"visible\":false,\"createdAt\":1706234567890,\"command\":[\"npm\",\"run\",\"dev\"]}"
  }]
}
```

**Security Constraints**
- **Blocked commands**: `rm`, `sudo`, `chmod`, `chown`, `mkfs`, `dd`, `fdisk`, `shutdown`, `reboot`, `halt`, `poweroff`, `kill`, `killall`, `pkill`
- **Blocked patterns**: `rm -rf /`, `> /dev/`, `| sh`, `| bash`, `eval`, backticks, command substitution
- **Rate limit**: Max 3 spawns per minute
- **Concurrency limit**: Max 5 agent terminals simultaneously

**Error Responses**
- `"Command blocked for security reasons"` - Command or pattern is blocklisted
- `"Spawn rate limit exceeded (max 3/minute)"` - Too many recent spawns
- `"Maximum concurrent agent terminals reached (5)"` - Too many active terminals

### promote_terminal

Promote a background terminal to visible. Useful for Cursor handoff when a dev server is ready.

**Input**
```json
{
  "terminalId": "pty-xyz789"
}
```

**Output**
```json
{
  "content": [{
    "type": "text",
    "text": "{\"id\":\"pty-xyz789\",\"cwd\":\"/path/to/project\",\"owner\":\"user\",\"visible\":true,\"createdAt\":1706234567890,\"command\":[\"npm\",\"run\",\"dev\"]}"
  }]
}
```

**Notes**
- Changes `visible` from `false` to `true`
- **Transfers ownership** from `"agent"` to `"user"`
- Terminal becomes visible in UI for user interaction
- Clears inactivity timeout (user-owned terminals don't timeout)
- Cannot demote visible terminals back to background
- Agent can no longer kill promoted terminals

### kill_terminal

Kill a background terminal owned by this agent. Cannot kill visible or user-owned terminals.

**Input**
```json
{
  "terminalId": "pty-xyz789"
}
```

**Output (success)**
```json
{
  "content": [{
    "type": "text",
    "text": "{\"terminated\":true,\"id\":\"pty-xyz789\"}"
  }]
}
```

**Output (blocked)**
```json
{
  "content": [{
    "type": "text",
    "text": "Cannot kill visible or user-owned terminals"
  }],
  "isError": true
}
```

**Notes**
- Only works on terminals where `owner="agent"` AND `visible=false`
- Idempotent: killing a non-existent terminal returns success
- Emits a "closed" TerminalEvent before cleanup
- Use to clean up background dev servers, test runners, etc.

**Security Model**
```
Agent spawns terminal    → owner: "agent", visible: false → can kill ✓
Agent promotes terminal  → owner: "user",  visible: true  → cannot kill ✗
User spawns terminal     → owner: "user",  visible: true  → cannot kill ✗
```

## WebSocket Protocol

### Client → Server

```typescript
// Attach to receive output
{ type: "pty:attach", id: "pty-abc123" }

// Detach from output stream
{ type: "pty:detach", id: "pty-abc123" }

// Send input (user terminals only)
{ type: "pty:input", id: "pty-abc123", data: "ls -la\n" }

// Resize terminal
{ type: "pty:resize", id: "pty-abc123", cols: 120, rows: 40 }
```

### Server → Client

```typescript
// Successfully attached with history
{ type: "pty:attached", id: "pty-abc123", history?: "..." }

// Terminal output
{ type: "pty:output", id: "pty-abc123", data: "output text" }

// Terminal exited
{ type: "pty:exit", id: "pty-abc123", exitCode: 0 }

// Error
{ type: "pty:error", id: "pty-abc123", error: "Session not found" }
```

## Event Flow

```
MCP tool call → PtyManager → storeEmitter.emit("agent", TerminalEvent)
                                    ↓
                            WebSocket → UI
```

### TerminalEvent Types

```typescript
interface TerminalEvent {
  type: "terminal";
  event: "created" | "promoted" | "closed" | "output";
  terminal: Terminal;
  output?: string; // Only for "output" event
}
```

## Lifecycle Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Terminal Lifecycle                        │
└─────────────────────────────────────────────────────────────┘

User Terminal:                    Agent Terminal:

/pty/spawn (HTTP) ─┐              spawn_background_terminal ─┐
                   │                                         │
                   ▼                                         ▼
            ┌──────────┐                              ┌──────────┐
            │  user    │                              │  agent   │
            │  visible │                              │background│
            │ no kill  │                              │ 5min     │
            └────┬─────┘                              └────┬─────┘
                 │                                    ┌────┴────┐
        pty:attach (WS)                               │         │
        pty:input (WS)                         read_terminal  [timeout]
        pty:resize (WS)                         list_terminals    │
                 │                                    │           │
                 │                         ┌──────────┴───┐       │
                 │                         │              │       │
                 │                  promote_terminal  kill_terminal
                 │                         │              │       │
                 │                         ▼              ▼       ▼
                 │                  ┌──────────┐    ┌──────────────┐
                 │                  │  user    │    │   cleanup    │
                 │                  │  visible │    │ (unregister) │
                 │                  │ no kill  │    └──────────────┘
                 │                  └────┬─────┘
                 │                       │
                 ▼                       ▼
            ┌──────────┐          ┌──────────┐
            │ process  │          │ process  │
            │  exits   │          │  exits   │
            └────┬─────┘          └────┬─────┘
                 │                     │
           pty:exit (WS)        TerminalEvent
           TerminalEvent        (event: closed)
                 │                     │
                 ▼                     ▼
            unregister            unregister
```

## Inactivity Timeout

Background agent terminals automatically close after 5 minutes of inactivity.

**Behavior**
- Applies to: `owner="agent"` AND `visible=false`
- Duration: 5 minutes
- Resets on: Any PTY output or input
- Cleared when: Terminal is promoted to visible

**Why?**
Prevents accumulation of stale background processes. If an agent spawns a dev server and forgets about it, it will auto-cleanup after 5 minutes of no activity.

**Exceptions**
- User terminals never timeout
- Promoted terminals never timeout (ownership transferred to user)
- Active terminals (with ongoing I/O) don't timeout

## Ownership Model

Terminal ownership determines what agents can do.

| State | Owner | Visible | Agent Can Kill? | Timeout? |
|-------|-------|---------|-----------------|----------|
| Just spawned | agent | false | Yes | Yes (5min) |
| Promoted | user | true | No | No |
| User-created | user | true | No | No |

**Ownership Transfer**
When `promote_terminal` is called, ownership automatically transfers:
- `owner: "agent"` → `owner: "user"`
- This prevents agents from killing terminals users are actively using

## Best Practices

1. **Check before spawning**: Use `list_terminals` to see if a similar terminal already exists
2. **Monitor output**: Use `read_terminal` to check if a server started successfully before proceeding
3. **Background first**: Spawn as background, promote when stable
4. **Clean up**: Use `kill_terminal` to clean up background terminals you no longer need
5. **Let timeout work**: Background terminals auto-cleanup after 5 minutes of inactivity
6. **Respect limits**: Handle rate limit and concurrency errors gracefully
