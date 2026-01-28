import { VALIDATION } from "@forks-sh/protocol";
import type { Store, StoreEventEmitter } from "@forks-sh/store";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PtyManager } from "../pty-manager.js";
import {
  createGraphiteToolHandlers,
  GRAPHITE_TOOL_DEFINITIONS,
  graphiteToolSchemas,
} from "./graphite-tools.js";
import {
  createTerminalToolHandlers,
  TERMINAL_TOOL_DEFINITIONS,
  type TerminalToolName,
  terminalToolSchemas,
} from "./terminal-tools.js";

/** Session context passed to tool handlers */
interface SessionContext {
  sessionId: string;
  agentId: string;
}

/**
 * Authorization Strategy for MCP Tool Handlers
 *
 * Handlers are divided into two categories based on their security requirements:
 *
 * 1. **Resource-gated handlers** (no explicit session check):
 *    - attempt_spawn, attempt_pick, attempt_status
 *    - subagent_spawn, subagent_status, subagent_cancel
 *    - task_create, task_list
 *    These verify the target resource exists (chat, attempt, etc.) which implicitly
 *    requires knowledge of valid IDs. The session context is still available for
 *    agent identification (e.g., task_claim uses session.agentId).
 *
 * 2. **Session-validated handlers** (explicit session check):
 *    - plan_respond, plan_status, plan_list, plan_cancel
 *    - ask_respond, question_status, question_list, question_cancel
 *    These involve user-facing approval workflows where an invalid session could
 *    indicate a rogue agent attempting to approve its own plans/answer questions.
 *
 * Future: Add role-based checks (user vs agent) for approval handlers.
 */

/** Zod schemas for tool argument validation */
const idSchema = z
  .string()
  .min(1)
  .max(VALIDATION.MAX_ID_LENGTH)
  .regex(VALIDATION.ID_PATTERN, "Invalid ID format");

const textSchema = z.string().min(1).max(VALIDATION.MAX_TEXT_LENGTH);

const toolSchemas = {
  attempt_spawn: z.object({
    chatId: idSchema,
    count: z.number().int().min(1).max(VALIDATION.MAX_ATTEMPT_COUNT),
    task: textSchema,
  }),
  attempt_pick: z.object({ attemptId: idSchema }),
  attempt_status: z.object({ chatId: idSchema }),
  subagent_spawn: z.object({ chatId: idSchema, task: textSchema }),
  subagent_status: z.object({ subagentId: idSchema }),
  subagent_cancel: z.object({ subagentId: idSchema }),
  plan_propose: z.object({
    chatId: idSchema,
    title: textSchema,
    plan: textSchema,
  }),
  plan_respond: z.object({
    planId: idSchema,
    approved: z.boolean(),
    feedback: textSchema.optional(),
  }),
  plan_status: z.object({ planId: idSchema }),
  plan_list: z.object({
    projectId: idSchema,
    status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  plan_cancel: z.object({ planId: idSchema }),
  ask_question: z.object({ chatId: idSchema, question: textSchema }),
  ask_respond: z.object({ questionId: idSchema, answer: textSchema }),
  question_status: z.object({ questionId: idSchema }),
  question_list: z.object({
    chatId: idSchema,
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  question_cancel: z.object({ questionId: idSchema }),
  task_create: z.object({
    chatId: idSchema,
    description: textSchema,
    planId: idSchema.optional(),
  }),
  task_claim: z.object({ taskId: idSchema }),
  task_unclaim: z.object({ taskId: idSchema, reason: textSchema.optional() }),
  task_complete: z.object({ taskId: idSchema, result: textSchema }),
  task_fail: z.object({ taskId: idSchema, result: textSchema.optional() }),
  task_update: z.object({
    taskId: idSchema,
    description: textSchema.optional(),
  }),
  task_delete: z.object({ taskId: idSchema }),
  task_list: z.object({
    chatId: idSchema.optional(),
    planId: idSchema.optional(),
  }),
} as const;

type ToolName = keyof typeof toolSchemas;

const TOOL_DEFINITIONS = [
  // Attempts (poly-iteration)
  {
    name: "attempt_spawn",
    description:
      "Spawn multiple parallel attempts to solve a task (poly-iteration)",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to spawn attempts in",
        },
        count: {
          type: "number",
          description: "Number of parallel attempts to spawn",
        },
        task: {
          type: "string",
          description: "The task description for the attempts",
        },
      },
      required: ["chatId", "count", "task"],
    },
  },
  {
    name: "attempt_pick",
    description: "Select the winning attempt from parallel attempts",
    inputSchema: {
      type: "object" as const,
      properties: {
        attemptId: {
          type: "string",
          description: "The ID of the attempt to pick as the winner",
        },
      },
      required: ["attemptId"],
    },
  },
  {
    name: "attempt_status",
    description: "Get the status of all attempts in a chat",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to get attempt statuses for",
        },
      },
      required: ["chatId"],
    },
  },

  // Subagents (streamed tasks)
  {
    name: "subagent_spawn",
    description: "Spawn a subagent to execute a streamed task",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to spawn the subagent in",
        },
        task: {
          type: "string",
          description: "The task description for the subagent",
        },
      },
      required: ["chatId", "task"],
    },
  },
  {
    name: "subagent_status",
    description: "Get the current status of a subagent",
    inputSchema: {
      type: "object" as const,
      properties: {
        subagentId: {
          type: "string",
          description: "The ID of the subagent to check",
        },
      },
      required: ["subagentId"],
    },
  },
  {
    name: "subagent_cancel",
    description: "Cancel a running subagent",
    inputSchema: {
      type: "object" as const,
      properties: {
        subagentId: {
          type: "string",
          description: "The ID of the subagent to cancel",
        },
      },
      required: ["subagentId"],
    },
  },

  // Plan mode
  {
    name: "plan_propose",
    description: "Propose a plan and wait for user approval",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to propose the plan in",
        },
        title: {
          type: "string",
          description: "A short title for the plan (AI-generated name)",
        },
        plan: {
          type: "string",
          description: "The plan content to propose",
        },
      },
      required: ["chatId", "title", "plan"],
    },
  },
  {
    name: "plan_respond",
    description: "Respond to a proposed plan (approve or reject)",
    inputSchema: {
      type: "object" as const,
      properties: {
        planId: {
          type: "string",
          description: "The ID of the plan to respond to",
        },
        approved: {
          type: "boolean",
          description: "Whether to approve (true) or reject (false) the plan",
        },
        feedback: {
          type: "string",
          description:
            "Optional feedback for the plan (e.g., rejection reason)",
        },
      },
      required: ["planId", "approved"],
    },
  },
  {
    name: "plan_status",
    description: "Get the current status of a plan by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        planId: {
          type: "string",
          description: "The ID of the plan to check",
        },
      },
      required: ["planId"],
    },
  },
  {
    name: "plan_list",
    description: "List all plans in a project",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: "The project ID to list plans for",
        },
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected", "cancelled"],
          description: "Filter plans by status",
        },
        limit: {
          type: "number",
          description: "Maximum number of plans to return (default 100)",
        },
        offset: {
          type: "number",
          description: "Number of plans to skip for pagination",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "plan_cancel",
    description: "Cancel a pending plan (agent-initiated)",
    inputSchema: {
      type: "object" as const,
      properties: {
        planId: {
          type: "string",
          description: "The ID of the plan to cancel",
        },
      },
      required: ["planId"],
    },
  },

  // Ask mode
  {
    name: "ask_question",
    description: "Ask the user a question and wait for their answer",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to ask the question in",
        },
        question: {
          type: "string",
          description: "The question to ask the user",
        },
      },
      required: ["chatId", "question"],
    },
  },
  {
    name: "ask_respond",
    description: "Provide an answer to a pending question",
    inputSchema: {
      type: "object" as const,
      properties: {
        questionId: {
          type: "string",
          description: "The ID of the question to answer",
        },
        answer: {
          type: "string",
          description: "The answer to the question",
        },
      },
      required: ["questionId", "answer"],
    },
  },
  {
    name: "question_status",
    description: "Get the current status of a question by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        questionId: {
          type: "string",
          description: "The ID of the question to check",
        },
      },
      required: ["questionId"],
    },
  },
  {
    name: "question_list",
    description: "List all questions in a chat",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to list questions for",
        },
        limit: {
          type: "number",
          description: "Maximum number of questions to return (default 100)",
        },
        offset: {
          type: "number",
          description: "Number of questions to skip for pagination",
        },
      },
      required: ["chatId"],
    },
  },
  {
    name: "question_cancel",
    description: "Cancel a pending question (agent-initiated)",
    inputSchema: {
      type: "object" as const,
      properties: {
        questionId: {
          type: "string",
          description: "The ID of the question to cancel",
        },
      },
      required: ["questionId"],
    },
  },

  // Idempotent tasks
  {
    name: "task_create",
    description: "Create a new task in the shared task list",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to create the task in",
        },
        description: {
          type: "string",
          description: "Description of the task to be done",
        },
        planId: {
          type: "string",
          description: "Optional plan ID to link this task to",
        },
      },
      required: ["chatId", "description"],
    },
  },
  {
    name: "task_claim",
    description: "Claim a task from the shared task list",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the task to claim",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_unclaim",
    description:
      "Release a claimed task back to pending status with optional context for the next agent",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the task to unclaim",
        },
        reason: {
          type: "string",
          description:
            "Optional reason or context for unclaiming (helps next agent understand what was attempted)",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_complete",
    description: "Mark a claimed task as complete with a result",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the task to complete",
        },
        result: {
          type: "string",
          description: "The result or output of the completed task",
        },
      },
      required: ["taskId", "result"],
    },
  },
  {
    name: "task_fail",
    description: "Mark a claimed task as failed with an optional error message",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the task to fail",
        },
        result: {
          type: "string",
          description: "Optional error message or reason for failure",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's description",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the task to update",
        },
        description: {
          type: "string",
          description: "New description for the task",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_delete",
    description: "Delete a task from the task list",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the task to delete",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_list",
    description:
      "List tasks by chat ID or plan ID. At least one of chatId or planId must be provided.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID to list tasks for",
        },
        planId: {
          type: "string",
          description: "The plan ID to list tasks for",
        },
      },
      required: [],
    },
  },
];

interface ToolResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Helper to create a success response */
const successResponse = (data: unknown): ToolResponse => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

/** Helper to create an error response */
const errorResponse = (message: string): ToolResponse => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

type ToolHandler = (
  data: unknown,
  store: Store,
  session: SessionContext
) => ToolResponse | Promise<ToolResponse>;

const DEFAULT_LIST_LIMIT = 100;

const handleAttemptSpawn: ToolHandler = async (data, store, _session) => {
  const { chatId, count, task } = data as {
    chatId: string;
    count: number;
    task: string;
  };
  const chat = store.getChat(chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }
  // TODO: Store task on attempts when schema supports it (Attempt interface lacks task field)
  // For now, task is validated but returned in response for client-side tracking
  const attempts = store.createAttemptBatch(chatId, count);

  // Execute via runner (fire and forget, errors handled internally)
  try {
    const { initRunnerIfNeeded } = await import("../runner.js");
    const runner = await initRunnerIfNeeded();
    // v1: Parent summary intentionally empty. Summary extraction requires
    // message history access which is not yet implemented in the chat model.
    const parentSummary = "";
    runner.executeAttemptBatch(attempts, task, parentSummary).catch((err) => {
      console.error("[MCP] Failed to execute attempt batch:", err);
    });
  } catch (err) {
    console.error("[MCP] Failed to initialize runner:", err);
  }

  return successResponse({ attempts, task });
};

const handleAttemptPick: ToolHandler = (data, store, _session) => {
  const { attemptId } = data as { attemptId: string };
  // Use atomic pickAttempt to prevent race conditions from concurrent picks
  const attempt = store.pickAttempt(attemptId);
  if (!attempt) {
    // Could be: not found, not in "completed" status, or already picked
    return errorResponse(
      "Attempt not found or not in completed status (may have been picked already)"
    );
  }
  return successResponse(attempt);
};

const handleAttemptStatus: ToolHandler = (data, store, _session) => {
  const { chatId } = data as { chatId: string };
  const attempts = store.listAttempts(chatId, DEFAULT_LIST_LIMIT);
  return successResponse(attempts);
};

const handleSubagentSpawn: ToolHandler = async (data, store, _session) => {
  const { chatId, task } = data as { chatId: string; task: string };
  const chat = store.getChat(chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }
  const subagent = store.createSubagent(chatId, task);

  // Execute via runner (fire and forget, errors handled internally)
  try {
    const { initRunnerIfNeeded } = await import("../runner.js");
    const runner = await initRunnerIfNeeded();
    runner.executeSubagent(subagent).catch((err) => {
      console.error("[MCP] Failed to execute subagent:", err);
    });
  } catch (err) {
    console.error("[MCP] Failed to initialize runner:", err);
  }

  return successResponse(subagent);
};

const handleSubagentStatus: ToolHandler = (data, store, _session) => {
  const { subagentId } = data as { subagentId: string };
  const subagent = store.getSubagent(subagentId);
  if (!subagent) {
    return errorResponse("Subagent not found");
  }
  return successResponse(subagent);
};

const handleSubagentCancel: ToolHandler = async (data, store, _session) => {
  const { subagentId } = data as { subagentId: string };
  const subagent = store.getSubagent(subagentId);
  if (!subagent) {
    return errorResponse("Subagent not found");
  }

  // Cancel via runner first (handles Codex cancellation)
  try {
    const { initRunnerIfNeeded } = await import("../runner.js");
    const runner = await initRunnerIfNeeded();
    await runner.cancel(subagentId);
  } catch (err) {
    console.error("[MCP] Failed to cancel via runner:", err);
    // Fallback: update status directly
    store.updateSubagent(subagentId, { status: "cancelled" });
  }

  return successResponse({ ...subagent, status: "cancelled" });
};

/** Resolve projectId from chatId via chat → workspace → project */
const resolveProjectId = (
  store: Store,
  chatId: string
): { projectId: string } | { error: string } => {
  const chat = store.getChat(chatId);
  if (!chat) {
    return { error: "Chat not found" };
  }
  const workspace = store.getWorkspace(chat.workspaceId);
  if (!workspace) {
    return { error: "Workspace not found" };
  }
  return { projectId: workspace.projectId };
};

const handlePlanPropose: ToolHandler = (data, store, session) => {
  const { chatId, title, plan } = data as {
    chatId: string;
    title: string;
    plan: string;
  };

  const result = resolveProjectId(store, chatId);
  if ("error" in result) {
    return errorResponse(result.error);
  }

  try {
    const createdPlan = store.proposePlan(
      result.projectId,
      chatId,
      session.agentId,
      title,
      plan
    );
    return successResponse(createdPlan);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to propose plan";
    return errorResponse(message);
  }
};

const handlePlanRespond: ToolHandler = (data, store, session) => {
  const { planId, approved, feedback } = data as {
    planId: string;
    approved: boolean;
    feedback?: string;
  };

  // Verify plan exists before attempting response
  const existingPlan = store.getPlan(planId);
  if (!existingPlan) {
    return errorResponse("Plan not found");
  }

  // Authorization: verify the responder has access to the chat
  const chat = store.getChat(existingPlan.chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }

  // Note: In production, add role-based check here (e.g., user vs agent)
  // For now, we verify the session is valid and log the action
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  // Plans must have at least 1 task to be approved.
  // Task descriptions are already validated at creation time via:
  // - MCP layer: textSchema (min 1 char, max MAX_TEXT_LENGTH)
  // - Store layer: validateText() defense-in-depth
  // - DB schema: description NOT NULL constraint
  const MIN_TASKS_FOR_APPROVAL = 1;
  if (approved) {
    const taskCount = store.countTasksByPlan(planId);
    if (taskCount < MIN_TASKS_FOR_APPROVAL) {
      return errorResponse(
        `Cannot approve plan: requires at least ${MIN_TASKS_FOR_APPROVAL} task(s), found ${taskCount}`
      );
    }
  }

  const plan = store.respondToPlan(planId, approved, feedback);
  if (!plan) {
    return errorResponse("Plan not pending or already responded");
  }
  return successResponse(plan);
};

const handlePlanStatus: ToolHandler = (data, store, session) => {
  const { planId } = data as { planId: string };

  // Require valid session for data access
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  const plan = store.getPlan(planId);
  if (!plan) {
    return errorResponse("Plan not found");
  }
  return successResponse(plan);
};

const handlePlanList: ToolHandler = (data, store, session) => {
  const { projectId, status, limit, offset } = data as {
    projectId: string;
    status?: "pending" | "approved" | "rejected" | "cancelled";
    limit?: number;
    offset?: number;
  };

  // Require valid session for data access
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  // Verify project exists
  const project = store.getProject(projectId);
  if (!project) {
    return errorResponse("Project not found");
  }

  const plans = store.listPlans(
    projectId,
    status,
    limit ?? DEFAULT_LIST_LIMIT,
    offset ?? 0
  );
  return successResponse(plans);
};

const handlePlanCancel: ToolHandler = (data, store, session) => {
  const { planId } = data as { planId: string };

  // Require valid session
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  // Verify plan exists and get chat for authorization
  const existingPlan = store.getPlan(planId);
  if (!existingPlan) {
    return errorResponse("Plan not found");
  }

  const chat = store.getChat(existingPlan.chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }

  const plan = store.cancelPlan(planId);
  if (!plan) {
    return errorResponse("Plan not pending or already responded");
  }
  return successResponse(plan);
};

const handleAskQuestion: ToolHandler = (data, store, session) => {
  const { chatId, question } = data as { chatId: string; question: string };

  const chat = store.getChat(chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }

  try {
    const createdQuestion = store.askQuestion(
      chatId,
      session.agentId,
      question
    );
    return successResponse(createdQuestion);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to ask question";
    return errorResponse(message);
  }
};

const handleAskRespond: ToolHandler = (data, store, session) => {
  const { questionId, answer } = data as { questionId: string; answer: string };

  // Verify question exists before attempting response
  const existingQuestion = store.getQuestion(questionId);
  if (!existingQuestion) {
    return errorResponse("Question not found");
  }

  // Authorization: verify the responder has access to the chat
  const chat = store.getChat(existingQuestion.chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }

  // Note: In production, add role-based check here (e.g., user vs agent)
  // For now, we verify the session is valid and log the action
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  const question = store.answerQuestion(questionId, answer);
  if (!question) {
    return errorResponse("Question not pending or already answered");
  }
  return successResponse(question);
};

const handleQuestionStatus: ToolHandler = (data, store, session) => {
  const { questionId } = data as { questionId: string };

  // Require valid session for data access
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  const question = store.getQuestion(questionId);
  if (!question) {
    return errorResponse("Question not found");
  }
  return successResponse(question);
};

const handleQuestionList: ToolHandler = (data, store, session) => {
  const { chatId, limit, offset } = data as {
    chatId: string;
    limit?: number;
    offset?: number;
  };

  // Require valid session for data access
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  // Verify chat exists
  const chat = store.getChat(chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }

  const questions = store.listQuestions(
    chatId,
    limit ?? DEFAULT_LIST_LIMIT,
    offset ?? 0
  );
  return successResponse(questions);
};

const handleQuestionCancel: ToolHandler = (data, store, session) => {
  const { questionId } = data as { questionId: string };

  // Require valid session
  if (!session.sessionId || session.sessionId === "unknown") {
    return errorResponse("Invalid session - authentication required");
  }

  // Verify question exists and get chat for authorization
  const existingQuestion = store.getQuestion(questionId);
  if (!existingQuestion) {
    return errorResponse("Question not found");
  }

  const chat = store.getChat(existingQuestion.chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }

  const question = store.cancelQuestion(questionId);
  if (!question) {
    return errorResponse("Question not pending or already answered");
  }
  return successResponse(question);
};

const handleTaskCreate: ToolHandler = (data, store, _session) => {
  const { chatId, description, planId } = data as {
    chatId: string;
    description: string;
    planId?: string;
  };
  const chat = store.getChat(chatId);
  if (!chat) {
    return errorResponse("Chat not found");
  }
  // Validate planId if provided
  if (planId) {
    const plan = store.getPlan(planId);
    if (!plan) {
      return errorResponse("Plan not found");
    }
    if (plan.chatId !== chatId) {
      return errorResponse("Plan chatId does not match task chatId");
    }
    if (plan.status !== "pending") {
      return errorResponse("Cannot add tasks to a plan that is not pending");
    }
  }
  const task = store.createTask(chatId, description, planId);
  return successResponse(task);
};

const handleTaskClaim: ToolHandler = (data, store, session) => {
  const { taskId } = data as { taskId: string };
  const task = store.claimTask(taskId, session.agentId);
  if (!task) {
    return errorResponse("Task not found or already claimed");
  }
  return successResponse(task);
};

const handleTaskComplete: ToolHandler = (data, store, session) => {
  const { taskId, result } = data as { taskId: string; result: string };
  const existingTask = store.getTask(taskId);
  if (!existingTask) {
    return errorResponse("Task not found");
  }
  if (existingTask.claimedBy !== session.agentId) {
    return errorResponse("Task not claimed by this agent");
  }
  const task = store.completeTask(taskId, result, session.agentId);
  if (!task) {
    return errorResponse("Failed to complete task");
  }
  return successResponse(task);
};

const handleTaskFail: ToolHandler = (data, store, session) => {
  const { taskId, result } = data as { taskId: string; result?: string };
  const existingTask = store.getTask(taskId);
  if (!existingTask) {
    return errorResponse("Task not found");
  }
  if (existingTask.claimedBy !== session.agentId) {
    return errorResponse("Task not claimed by this agent");
  }
  const task = store.failTask(taskId, result, session.agentId);
  if (!task) {
    return errorResponse("Failed to fail task");
  }
  return successResponse(task);
};

const handleTaskUnclaim: ToolHandler = (data, store, session) => {
  const { taskId, reason } = data as { taskId: string; reason?: string };
  const task = store.getTask(taskId);
  if (!task) {
    return errorResponse("Task not found");
  }
  if (task.claimedBy !== session.agentId) {
    return errorResponse("Task not claimed by this agent");
  }
  // DESIGN: reason is stored in the task's `result` field (dual-purpose field).
  // When status='pending' and result is non-null, it indicates handoff context from
  // a previous agent. A dedicated `unclaimReason` column was considered but adds
  // schema complexity for a rarely-queried field. The status provides disambiguation.
  const unclaimed = store.unclaimTask(taskId, reason, session.agentId);
  if (!unclaimed) {
    return errorResponse("Failed to unclaim task");
  }
  return successResponse(unclaimed);
};

const handleTaskUpdate: ToolHandler = (data, store, session) => {
  const { taskId, description } = data as {
    taskId: string;
    description?: string;
  };
  if (!description) {
    return errorResponse("At least one update field is required");
  }
  const existingTask = store.getTask(taskId);
  if (!existingTask) {
    return errorResponse("Task not found");
  }
  // Authorization: only the agent that claimed the task can update it
  // Unclaimed tasks (pending) can be updated by anyone (task creator is not tracked)
  // TODO: track createdBy to enforce creator-only updates for pending tasks
  if (existingTask.claimedBy && existingTask.claimedBy !== session.agentId) {
    return errorResponse("Task claimed by another agent");
  }
  const updated = store.updateTask(taskId, { description });
  if (!updated) {
    return errorResponse("Failed to update task");
  }
  return successResponse(updated);
};

const handleTaskDelete: ToolHandler = (data, store, session) => {
  const { taskId } = data as { taskId: string };
  const task = store.getTask(taskId);
  if (!task) {
    return errorResponse("Task not found");
  }
  // Authorization: only allow deletion of unclaimed tasks or tasks claimed by this agent
  // Completed/failed tasks should generally not be deleted (audit trail)
  if (task.claimedBy && task.claimedBy !== session.agentId) {
    return errorResponse("Task claimed by another agent");
  }
  if (task.status === "completed" || task.status === "failed") {
    return errorResponse("Cannot delete completed or failed tasks");
  }
  store.deleteTask(taskId);
  return successResponse({ deleted: true, taskId });
};

const handleTaskList: ToolHandler = (data, store, _session) => {
  const { chatId, planId } = data as { chatId?: string; planId?: string };
  if (!(chatId || planId)) {
    return errorResponse("Either chatId or planId is required");
  }
  if (planId) {
    // Verify plan exists to prevent enumeration of non-existent plans
    const plan = store.getPlan(planId);
    if (!plan) {
      return errorResponse("Plan not found");
    }
    const tasks = store.listTasksByPlan(planId, DEFAULT_LIST_LIMIT);
    return successResponse(tasks);
  }
  // Verify chat exists to prevent enumeration
  const chat = store.getChat(chatId as string);
  if (!chat) {
    return errorResponse("Chat not found");
  }
  const tasks = store.listTasks(chatId as string, DEFAULT_LIST_LIMIT);
  return successResponse(tasks);
};

const toolHandlers: Record<ToolName, ToolHandler> = {
  attempt_spawn: handleAttemptSpawn,
  attempt_pick: handleAttemptPick,
  attempt_status: handleAttemptStatus,
  subagent_spawn: handleSubagentSpawn,
  subagent_status: handleSubagentStatus,
  subagent_cancel: handleSubagentCancel,
  plan_propose: handlePlanPropose,
  plan_respond: handlePlanRespond,
  plan_status: handlePlanStatus,
  plan_list: handlePlanList,
  plan_cancel: handlePlanCancel,
  ask_question: handleAskQuestion,
  ask_respond: handleAskRespond,
  question_status: handleQuestionStatus,
  question_list: handleQuestionList,
  question_cancel: handleQuestionCancel,
  task_create: handleTaskCreate,
  task_claim: handleTaskClaim,
  task_unclaim: handleTaskUnclaim,
  task_complete: handleTaskComplete,
  task_fail: handleTaskFail,
  task_update: handleTaskUpdate,
  task_delete: handleTaskDelete,
  task_list: handleTaskList,
};

/**
 * Extract session context from MCP request extra.
 *
 * The MCP SDK passes sessionId directly on the extra object via RequestHandlerExtra.
 * StreamableHTTPServerTransport sets this from the transport's sessionId property.
 */
const getSessionContext = (
  extra: Record<string, unknown> | undefined
): SessionContext => {
  const rawSessionId = extra?.sessionId;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : "unknown";

  // Log when session extraction fails - helps debug MCP SDK integration issues
  if (sessionId === "unknown" && extra !== undefined) {
    console.warn(
      "[MCP] Session ID not found in request extra. Keys present:",
      Object.keys(extra)
    );
  }

  return {
    sessionId,
    agentId: `agent-${sessionId}`,
  };
};

/** Handle terminal tool calls */
const handleTerminalTool = (
  name: string,
  args: Record<string, unknown> | undefined,
  ptyManager: PtyManager,
  handlers: ReturnType<typeof createTerminalToolHandlers>
): ToolResponse => {
  const schema = terminalToolSchemas[name as TerminalToolName];
  const validation = schema.safeParse(args);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for ${name}: ${issues}`
    );
  }

  const handler = handlers[name as TerminalToolName];
  try {
    return handler(validation.data, ptyManager);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message);
  }
};

/** Handle regular tool calls */
const handleRegularTool = async (
  name: string,
  args: Record<string, unknown> | undefined,
  store: Store,
  session: SessionContext
): Promise<ToolResponse> => {
  const handler = toolHandlers[name as ToolName];
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  const schema = toolSchemas[name as ToolName];
  const validation = schema.safeParse(args);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for ${name}: ${issues}`
    );
  }

  try {
    return await handler(validation.data, store, session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(message);
  }
};

export const registerTools = (
  server: Server,
  store: Store,
  ptyManager?: PtyManager,
  emitter?: StoreEventEmitter
) => {
  const allTools = ptyManager
    ? [
        ...TOOL_DEFINITIONS,
        ...TERMINAL_TOOL_DEFINITIONS,
        ...GRAPHITE_TOOL_DEFINITIONS,
      ]
    : [...TOOL_DEFINITIONS, ...GRAPHITE_TOOL_DEFINITIONS];

  // Create terminal handlers with emitter for event emission
  const terminalHandlers = ptyManager
    ? createTerminalToolHandlers(emitter)
    : null;

  // Create graphite handlers
  const graphiteHandlers = createGraphiteToolHandlers();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const session = getSessionContext(extra as Record<string, unknown>);

    if (ptyManager && terminalHandlers && name in terminalToolSchemas) {
      return handleTerminalTool(name, args, ptyManager, terminalHandlers);
    }

    // Handle graphite tools
    if (name in graphiteToolSchemas) {
      const schema =
        graphiteToolSchemas[name as keyof typeof graphiteToolSchemas];
      const validation = schema.safeParse(args);
      if (!validation.success) {
        const issues = validation.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for ${name}: ${issues}`
        );
      }
      return await graphiteHandlers[name as keyof typeof graphiteToolSchemas](
        validation.data
      );
    }

    return await handleRegularTool(name, args, store, session);
  });
};
