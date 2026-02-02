/** Claude Code stream-json event types */

/**
 * Result message emitted when a turn completes
 * This is the final message in a stream-json response
 */
export interface CCResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: CCResultUsage;
  permission_denials: unknown[];
  uuid: string;
  /** Per-model usage breakdown */
  modelUsage?: Record<string, CCModelUsage>;
}

export interface CCModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests?: number;
  costUSD: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface CCResultUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier?: string;
  /** Breakdown of cache creation by TTL */
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
}

/**
 * System message with conversation/session info
 * Subtypes include:
 * - "init": Session initialization with tools, MCP servers, etc.
 * - "hook_started": A hook has started executing
 * - "hook_response": A hook has finished executing
 */
export interface CCSystemEvent {
  type: "system";
  subtype: "init" | "hook_started" | "hook_response";
  session_id: string;
  uuid?: string;
  /** Only for subtype "init" */
  cwd?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  model?: string;
  permissionMode?: string;
  slash_commands?: string[];
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  plugins?: Array<{ name: string; path: string }>;
  /** Only for subtype "hook_started" | "hook_response" */
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  /** Only for subtype "hook_response" */
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
}

/**
 * Assistant message content block
 */
export interface CCAssistantEvent {
  type: "assistant";
  message: CCAssistantMessage;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
}

export interface CCAssistantMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: CCContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
    cache_creation?: {
      ephemeral_1h_input_tokens?: number;
      ephemeral_5m_input_tokens?: number;
    };
  };
  context_management?: unknown;
}

export type CCContentBlock = CCTextBlock | CCToolUseBlock | CCToolResultBlock;

export interface CCTextBlock {
  type: "text";
  text: string;
}

export interface CCToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface CCToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | CCToolResultContent[];
  is_error?: boolean;
}

export interface CCToolResultContent {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/**
 * User message (echoed back in stream)
 * Contains tool results when tools are executed
 */
export interface CCUserEvent {
  type: "user";
  message: {
    role: "user";
    content: string | CCContentBlock[];
  };
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  /** Human-readable tool result summary */
  tool_use_result?: string;
}

/**
 * Union of all Claude Code stream events
 */
export type CCStreamEvent =
  | CCResultEvent
  | CCSystemEvent
  | CCAssistantEvent
  | CCUserEvent;

/**
 * Type guard for result events
 */
export const isResultEvent = (event: CCStreamEvent): event is CCResultEvent =>
  event.type === "result";

/**
 * Type guard for assistant events
 */
export const isAssistantEvent = (
  event: CCStreamEvent
): event is CCAssistantEvent => event.type === "assistant";

/**
 * Type guard for system events
 */
export const isSystemEvent = (event: CCStreamEvent): event is CCSystemEvent =>
  event.type === "system";

/**
 * Type guard for user events
 */
export const isUserEvent = (event: CCStreamEvent): event is CCUserEvent =>
  event.type === "user";
