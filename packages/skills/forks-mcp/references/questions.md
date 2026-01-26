# Questions (User Interaction)

Questions enable asking the user for input and waiting for their response. Use when you need clarification or user decisions.

## When to Use

- Requirements are ambiguous
- Multiple valid approaches exist
- User preference matters
- Need confirmation before proceeding

## Tools

### ask_question

Ask the user a question and wait for their answer.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to ask the question in |
| question | string | Yes | The question to ask the user |

**Returns:** Question object with ID and pending status.

**Example:**
```json
{
  "chatId": "chat_abc123",
  "question": "Which authentication method should I implement?\n\n1. JWT tokens (stateless, good for APIs)\n2. Session cookies (traditional, simpler)\n3. OAuth 2.0 (third-party integration)"
}
```

### ask_respond

Provide an answer to a pending question.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| questionId | string | Yes | The ID of the question to answer |
| answer | string | Yes | The answer to the question |

**Returns:** Updated question with answer.

**Example:**
```json
{
  "questionId": "question_xyz789",
  "answer": "Use JWT tokens. We need stateless auth for our microservices."
}
```

### question_status

Get the current status of a question by ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| questionId | string | Yes | The ID of the question to check |

**Returns:** Question with status and answer if provided.

### question_list

List all questions in a chat.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to list questions for |
| limit | number | No | Max results (default 100, max 1000) |
| offset | number | No | Pagination offset |

**Returns:** Array of questions in the chat.

### question_cancel

Cancel a pending question (agent-initiated).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| questionId | string | Yes | The ID of the question to cancel |

**Returns:** Confirmation of cancellation.

## Question Lifecycle

```
1. ASK: Agent asks question with ask_question
2. PENDING: Question awaits user response
3. RESPOND: User answers via ask_respond
4. PROCEED: Agent continues with the answer
```

## Statuses

- `pending` - Awaiting user response
- `answered` - User provided an answer
- `cancelled` - Agent cancelled the question

## Best Practices

1. **Be specific**: Ask clear, focused questions
2. **Provide options**: When applicable, offer choices
3. **One thing at a time**: Don't combine multiple questions
4. **Context matters**: Include relevant context in the question
5. **Don't block unnecessarily**: Only ask when truly needed

## Question Patterns

### Multiple Choice
```
Which database should I use?

1. PostgreSQL (relational, robust)
2. MongoDB (document-based, flexible)
3. Redis (key-value, fast caching)
```

### Yes/No Confirmation
```
The tests are failing. Should I:
- Fix the tests to match new behavior, or
- Revert the changes that broke them?
```

### Open-Ended
```
What naming convention do you prefer for API endpoints?
(e.g., /users/get-by-id vs /users/:id)
```

### Clarification
```
You mentioned "optimize the database queries." Which queries should I focus on?
- User authentication queries
- Product search queries
- Order history queries
- All of the above
```
