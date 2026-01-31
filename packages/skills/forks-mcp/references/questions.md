---
name: forks-mcp:questions
description: Questions ask the user for input when requirements are unclear
---

# Questions (User Interaction)

Questions ask the user for input when requirements are unclear.

## When to Use

- Requirements are ambiguous
- Multiple valid options exist
- You need user preference

## Tools

### question_create

Ask the user a question and wait for their answer

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to ask the question in |
| question | string | Yes | The question to ask the user |

**Example (input)**
```json
{
  "chatId": "chat_123",
  "question": "value"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### question_respond

Provide an answer to a pending question

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| questionId | string | Yes | The ID of the question to answer |
| answer | string | Yes | The answer to the question |

**Example (input)**
```json
{
  "questionId": "question_123",
  "answer": "value"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### question_status

Get the current status of a question by ID

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| questionId | string | Yes | The ID of the question to check |

**Example (input)**
```json
{
  "questionId": "question_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### question_list

List all questions in a chat

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chatId | string | Yes | The chat ID to list questions for |
| limit | number | No | Maximum number of questions to return (default 100) |
| offset | number | No | Number of questions to skip for pagination |

**Example (input)**
```json
{
  "chatId": "chat_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

### question_cancel

Cancel a pending question (agent-initiated)

**Parameters**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| questionId | string | Yes | The ID of the question to cancel |

**Example (input)**
```json
{
  "questionId": "question_123"
}
```

**Output**
See Response Contract in SKILL.md (content.text is JSON).

## Question Lifecycle

```
1. ASK: question_create
2. RESPOND: question_respond
3. CHECK: question_status/question_list
4. CANCEL: question_cancel if no longer needed
```

## Statuses

- pending
- answered
- cancelled

## Best Practices

1. Ask one focused question at a time
2. Provide options when possible
3. Include relevant context
