/** Maps Claude Code stream events to Codex-compatible events */

import type { CCEvent, CCPermissionMode } from "../types.js";
import { CCPermissionModeValues } from "../types.js";
import type {
  CCAssistantEvent,
  CCContentBlock,
  CCResultEvent,
  CCStreamEvent,
  CCSystemEvent,
  CCTextBlock,
  CCToolResultBlock,
  CCToolUseBlock,
  CCUserEvent,
} from "./events.js";

/**
 * Validates that a permission mode string is a valid CCPermissionMode.
 * Returns the validated mode or undefined if invalid.
 */
const validatePermissionMode = (
  mode: string | undefined
): CCPermissionMode | undefined => {
  if (mode === undefined) {
    return undefined;
  }
  return CCPermissionModeValues.includes(mode as CCPermissionMode)
    ? (mode as CCPermissionMode)
    : undefined;
};

export interface MapperContext {
  threadId: string;
  turnId: string;
  sessionId: string | null;
  itemCounter: number;
}

/**
 * Handle system events (init, hook_started, hook_response)
 */
const handleSystemEvent = (
  event: CCSystemEvent,
  context: MapperContext
): CCEvent[] => {
  context.sessionId = event.session_id;
  // Only emit thread/started for the "init" subtype, not for hook events
  if (event.subtype === "init") {
    const validatedMode = validatePermissionMode(event.permissionMode);
    return [
      {
        type: "thread/started",
        conversationId: context.threadId,
        sessionId: event.session_id,
        ...(validatedMode !== undefined && { permissionMode: validatedMode }),
      },
    ];
  }
  return [];
};

/**
 * Handle a single content block from assistant messages
 */
const handleContentBlock = (
  block: CCContentBlock,
  context: MapperContext
): CCEvent | null => {
  if (block.type === "text") {
    const textBlock = block as CCTextBlock;
    return {
      type: "item/agentMessage/delta",
      conversationId: context.threadId,
      turnId: context.turnId,
      itemId: `item-${context.itemCounter++}`,
      delta: textBlock.text,
    };
  }

  if (block.type === "tool_use") {
    const toolBlock = block as CCToolUseBlock;
    return {
      type: "item/started",
      conversationId: context.threadId,
      turnId: context.turnId,
      itemId: toolBlock.id,
      itemType: "mcpToolCall",
      toolName: toolBlock.name,
      input: toolBlock.input,
    };
  }

  return null;
};

/**
 * Handle assistant events (text, tool_use)
 */
const handleAssistantEvent = (
  event: CCAssistantEvent,
  context: MapperContext
): CCEvent[] => {
  const events: CCEvent[] = [];
  for (const block of event.message.content) {
    const mapped = handleContentBlock(block, context);
    if (mapped) {
      events.push(mapped);
    }
  }
  return events;
};

/**
 * Handle tool result blocks from user events
 */
const handleToolResultBlock = (
  block: CCToolResultBlock,
  context: MapperContext
): CCEvent => ({
  type: "item/completed",
  conversationId: context.threadId,
  turnId: context.turnId,
  itemId: block.tool_use_id,
  itemType: "mcpToolCall",
  result: block.content,
  isError: block.is_error ?? false,
});

/**
 * Handle user events (tool results)
 */
const handleUserEvent = (
  event: CCUserEvent,
  context: MapperContext
): CCEvent[] => {
  const content = event.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const events: CCEvent[] = [];
  for (const block of content as CCContentBlock[]) {
    if (block.type === "tool_result") {
      events.push(handleToolResultBlock(block as CCToolResultBlock, context));
    }
  }
  return events;
};

/**
 * Handle result events (turn completion)
 */
const handleResultEvent = (
  event: CCResultEvent,
  context: MapperContext
): CCEvent[] => {
  context.sessionId = event.session_id;
  return [
    {
      type: "turn/completed",
      conversationId: context.threadId,
      turnId: context.turnId,
      result: event.result,
      isError: event.is_error,
      usage: {
        inputTokens: event.usage.input_tokens,
        outputTokens: event.usage.output_tokens,
        cacheCreationInputTokens: event.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: event.usage.cache_read_input_tokens ?? 0,
        totalCostUsd: event.total_cost_usd,
      },
      durationMs: event.duration_ms,
      numTurns: event.num_turns,
    },
  ];
};

/**
 * Maps a Claude Code stream event to one or more Codex-compatible events
 */
export const mapCCEventToCodexEvents = (
  event: CCStreamEvent,
  context: MapperContext
): CCEvent[] => {
  switch (event.type) {
    case "system":
      return handleSystemEvent(event, context);
    case "assistant":
      return handleAssistantEvent(event, context);
    case "user":
      return handleUserEvent(event, context);
    case "result":
      return handleResultEvent(event, context);
    default:
      return [];
  }
};

/**
 * Creates a new mapper context for a turn
 */
export const createMapperContext = (
  threadId: string,
  turnId: string
): MapperContext => ({
  threadId,
  turnId,
  sessionId: null,
  itemCounter: 0,
});
