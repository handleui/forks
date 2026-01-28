import type {
  Approval,
  Attempt,
  Chat,
  CreateWorkspaceOpts,
  Plan,
  Project,
  Question,
  Subagent,
  Task,
  Workspace,
} from "@forks-sh/protocol";
import { createDb, DEFAULT_DB_PATH } from "./db.js";
import type { StoreEventEmitter } from "./events.js";
import {
  type ApprovalCreateParams,
  createApprovalOps,
} from "./operations/approvals.js";
import { createAttemptOps } from "./operations/attempts.js";
import { createChatOps } from "./operations/chats.js";
import { createPlanOps } from "./operations/plans.js";
import { createProjectOps } from "./operations/projects.js";
import { createQuestionOps } from "./operations/questions.js";
import { createSubagentOps } from "./operations/subagents.js";
import { createTaskOps } from "./operations/tasks.js";
import { createWorkspaceOps } from "./operations/workspaces.js";

export interface StoreOptions {
  dbPath?: string;
  emitter?: StoreEventEmitter;
}

export interface Store {
  // Projects
  createProject(path: string, name: string, defaultBranch: string): Project;
  getProject(id: string): Project | null;
  getProjectByPath(path: string): Project | null;
  listProjects(): Project[];
  deleteProject(id: string): void;

  // Workspaces
  createWorkspace(
    projectId: string,
    opts: Required<CreateWorkspaceOpts> & { path: string }
  ): Workspace;
  getWorkspace(id: string): Workspace | null;
  listWorkspaces(projectId?: string, limit?: number): Workspace[];
  updateWorkspace(
    id: string,
    updates: Partial<Pick<Workspace, "name" | "status" | "lastAccessedAt">>
  ): void;
  deleteWorkspace(id: string): void;

  // Chats
  createChat(workspaceId: string, codexThreadId?: string): Chat;
  getChat(id: string): Chat | null;
  listChats(workspaceId: string, limit?: number, offset?: number): Chat[];
  updateChat(
    id: string,
    updates: Partial<Pick<Chat, "title" | "status" | "codexThreadId">>
  ): void;
  deleteChat(id: string): void;

  // Attempts
  createAttempt(chatId: string, codexThreadId?: string): Attempt;
  createAttemptBatch(
    chatId: string,
    count: number,
    codexThreadId?: string
  ): Attempt[];
  getAttempt(id: string): Attempt | null;
  listAttempts(chatId: string, limit?: number, offset?: number): Attempt[];
  updateAttempt(
    id: string,
    updates: Partial<
      Pick<
        Attempt,
        | "status"
        | "result"
        | "error"
        | "codexThreadId"
        | "worktreePath"
        | "branch"
      >
    >
  ): void;
  pickAttempt(id: string): Attempt | null;
  discardOtherAttempts(chatId: string, pickedAttemptId: string): void;
  deleteAttempt(id: string): void;
  pruneOldAttempts(olderThan: Date): number;

  // Subagents
  createSubagent(
    parentChatId: string,
    task: string,
    parentAttemptId?: string
  ): Subagent;
  getSubagent(id: string): Subagent | null;
  listSubagentsByChat(
    parentChatId: string,
    limit?: number,
    offset?: number
  ): Subagent[];
  listSubagentsByAttempt(
    parentAttemptId: string,
    limit?: number,
    offset?: number
  ): Subagent[];
  updateSubagent(
    id: string,
    updates: Partial<Pick<Subagent, "status" | "result" | "error">>
  ): void;
  deleteSubagent(id: string): void;

  // Tasks
  createTask(chatId: string, description: string, planId?: string): Task;
  getTask(id: string): Task | null;
  listTasks(chatId: string, limit?: number, offset?: number): Task[];
  listTasksByPlan(planId: string, limit?: number, offset?: number): Task[];
  countTasksByPlan(planId: string): number;
  claimTask(id: string, claimedBy: string): Task | null;
  unclaimTask(id: string, reason?: string, claimedBy?: string): Task | null;
  completeTask(id: string, result: string, claimedBy?: string): Task | null;
  failTask(id: string, result?: string, claimedBy?: string): Task | null;
  updateTask(
    id: string,
    updates: Partial<Pick<Task, "description" | "status" | "result">>
  ): Task | null;
  deleteTask(id: string): void;

  // Plans
  proposePlan(
    projectId: string,
    chatId: string,
    agentId: string,
    title: string,
    content: string
  ): Plan;
  getPlan(id: string): Plan | null;
  getPendingPlan(chatId: string): Plan | null;
  respondToPlan(id: string, approved: boolean, feedback?: string): Plan | null;
  cancelPlan(id: string): Plan | null;
  listPlans(
    projectId: string,
    status?: Plan["status"],
    limit?: number,
    offset?: number
  ): Plan[];
  deletePlan(id: string): void;

  // Questions
  askQuestion(chatId: string, agentId: string, content: string): Question;
  getQuestion(id: string): Question | null;
  getPendingQuestion(chatId: string): Question | null;
  answerQuestion(id: string, answer: string): Question | null;
  cancelQuestion(id: string): Question | null;
  listQuestions(chatId: string, limit?: number, offset?: number): Question[];
  deleteQuestion(id: string): void;

  // Approvals
  createApproval(
    chatId: string,
    token: string,
    approvalType: "commandExecution" | "fileChange",
    params: ApprovalCreateParams
  ): Approval;
  getApproval(id: string): Approval | null;
  getApprovalByToken(token: string): Approval | null;
  listApprovals(
    chatId: string,
    status?: Approval["status"],
    limit?: number,
    offset?: number
  ): Approval[];
  getPendingApprovals(chatId: string): Approval[];
  respondToApproval(id: string, accepted: boolean): Approval | null;
  cancelApproval(id: string): Approval | null;
  deleteApproval(id: string): void;

  close(): void;
}

export const createStore = (options: StoreOptions = {}): Store => {
  const { dbPath = DEFAULT_DB_PATH, emitter } = options;
  const { db, close } = createDb(dbPath);
  const projectOps = createProjectOps(db);
  const workspaceOps = createWorkspaceOps(db);
  const chatOps = createChatOps(db);
  const attemptOps = createAttemptOps(db);
  const subagentOps = createSubagentOps(db);
  const taskOps = createTaskOps(db);
  const planOps = createPlanOps(db);
  const questionOps = createQuestionOps(db);
  const approvalOps = createApprovalOps(db);

  return {
    // Projects
    createProject: projectOps.create,
    getProject: projectOps.get,
    getProjectByPath: projectOps.getByPath,
    listProjects: projectOps.list,
    deleteProject: projectOps.delete,

    // Workspaces
    createWorkspace: workspaceOps.create,
    getWorkspace: workspaceOps.get,
    listWorkspaces: workspaceOps.list,
    updateWorkspace: workspaceOps.update,
    deleteWorkspace: workspaceOps.delete,

    // Chats
    createChat: (workspaceId: string, codexThreadId?: string) => {
      const chat = chatOps.create(workspaceId, codexThreadId);
      emitter?.emit("agent", { type: "chat", event: "created", chat });
      return chat;
    },
    getChat: chatOps.get,
    listChats: chatOps.list,
    updateChat: chatOps.update,
    deleteChat: chatOps.delete,

    // Attempts
    createAttempt: (chatId: string, codexThreadId?: string) => {
      const attempt = attemptOps.create(chatId, codexThreadId);
      emitter?.emit("agent", { type: "attempt", event: "spawned", attempt });
      return attempt;
    },
    createAttemptBatch: (
      chatId: string,
      count: number,
      codexThreadId?: string
    ) => {
      const attempts = attemptOps.createBatch(chatId, count, codexThreadId);
      // Emit single batch event instead of N individual events to reduce WebSocket traffic
      if (attempts.length > 0) {
        emitter?.emit("agent", {
          type: "attempt_batch",
          event: "spawned",
          attempts,
        });
      }
      return attempts;
    },
    getAttempt: attemptOps.get,
    listAttempts: attemptOps.list,
    updateAttempt: (
      id: string,
      updates: Partial<
        Pick<
          Attempt,
          | "status"
          | "result"
          | "error"
          | "codexThreadId"
          | "worktreePath"
          | "branch"
        >
      >
    ) => {
      attemptOps.update(id, updates);
      // Only emit events for actual status transitions, not "running" (spawned is emitted at creation)
      if (updates.status && updates.status !== "running" && emitter) {
        const attempt = attemptOps.get(id);
        if (attempt) {
          emitter.emit("agent", {
            type: "attempt",
            event: updates.status as "completed" | "picked" | "discarded",
            attempt,
          });
        }
      }
    },
    deleteAttempt: attemptOps.delete,
    pruneOldAttempts: attemptOps.pruneOldAttempts,
    discardOtherAttempts: attemptOps.discardOthers,
    pickAttempt: (id: string) => {
      const attempt = attemptOps.pick(id);
      if (attempt && emitter) {
        emitter.emit("agent", {
          type: "attempt",
          event: "picked",
          attempt,
        });
      }
      return attempt;
    },

    // Subagents
    createSubagent: (
      parentChatId: string,
      task: string,
      parentAttemptId?: string
    ) => {
      const subagent = subagentOps.create(parentChatId, task, parentAttemptId);
      emitter?.emit("agent", { type: "subagent", event: "spawned", subagent });
      return subagent;
    },
    getSubagent: subagentOps.get,
    listSubagentsByChat: subagentOps.listByChat,
    listSubagentsByAttempt: subagentOps.listByAttempt,
    updateSubagent: (
      id: string,
      updates: Partial<Pick<Subagent, "status" | "result" | "error">>
    ) => {
      subagentOps.update(id, updates);
      // Only emit events for actual status transitions, not "running" (spawned is emitted at creation)
      if (updates.status && updates.status !== "running" && emitter) {
        const subagent = subagentOps.get(id);
        if (subagent) {
          emitter.emit("agent", {
            type: "subagent",
            event: updates.status as "completed" | "cancelled" | "failed",
            subagent,
          });
        }
      }
    },
    deleteSubagent: subagentOps.delete,

    // Tasks
    createTask: (chatId: string, description: string, planId?: string) => {
      const task = taskOps.create(chatId, description, planId);
      emitter?.emit("agent", { type: "task", event: "created", task });
      return task;
    },
    getTask: taskOps.get,
    listTasks: taskOps.list,
    listTasksByPlan: taskOps.listByPlan,
    countTasksByPlan: taskOps.countByPlan,
    claimTask: (id: string, claimedBy: string) => {
      const task = taskOps.claim(id, claimedBy);
      if (task) {
        emitter?.emit("agent", { type: "task", event: "claimed", task });
      }
      return task;
    },
    unclaimTask: (id: string, reason?: string, claimedBy?: string) => {
      const task = taskOps.unclaim(id, reason, claimedBy);
      if (task) {
        emitter?.emit("agent", { type: "task", event: "unclaimed", task });
      }
      return task;
    },
    completeTask: (id: string, result: string, claimedBy?: string) => {
      const task = taskOps.complete(id, result, claimedBy);
      if (task) {
        emitter?.emit("agent", { type: "task", event: "completed", task });
      }
      return task;
    },
    failTask: (id: string, result?: string, claimedBy?: string) => {
      const task = taskOps.fail(id, result, claimedBy);
      if (task) {
        emitter?.emit("agent", { type: "task", event: "failed", task });
      }
      return task;
    },
    updateTask: (
      id: string,
      updates: Partial<Pick<Task, "description" | "status" | "result">>
    ) => {
      // Only emit event if actual updates were made (not just a fetch)
      const hasUpdates = Object.keys(updates).length > 0;
      const task = taskOps.update(id, updates);
      if (task && hasUpdates && emitter) {
        emitter.emit("agent", { type: "task", event: "updated", task });
      }
      return task;
    },
    deleteTask: (id: string) => {
      const task = taskOps.get(id);
      taskOps.delete(id);
      if (task && emitter) {
        emitter.emit("agent", { type: "task", event: "deleted", task });
      }
    },

    // Plans
    proposePlan: (
      projectId: string,
      chatId: string,
      agentId: string,
      title: string,
      content: string
    ) => {
      const plan = planOps.propose(projectId, chatId, agentId, title, content);
      emitter?.emit("agent", { type: "plan", event: "proposed", plan });
      return plan;
    },
    getPlan: planOps.get,
    getPendingPlan: planOps.getPendingByChat,
    respondToPlan: (id: string, approved: boolean, feedback?: string) => {
      const plan = planOps.respond(id, approved, feedback);
      if (plan) {
        emitter?.emit("agent", {
          type: "plan",
          event: approved ? "approved" : "rejected",
          plan,
        });
      }
      return plan;
    },
    cancelPlan: (id: string) => {
      const plan = planOps.cancel(id);
      if (plan) {
        emitter?.emit("agent", { type: "plan", event: "cancelled", plan });
      }
      return plan;
    },
    listPlans: (
      projectId: string,
      status?: Plan["status"],
      limit?: number,
      offset?: number
    ) => planOps.list(projectId, status, limit, offset),
    deletePlan: planOps.delete,

    // Questions
    askQuestion: (chatId: string, agentId: string, content: string) => {
      const question = questionOps.ask(chatId, agentId, content);
      emitter?.emit("agent", { type: "question", event: "asked", question });
      return question;
    },
    getQuestion: questionOps.get,
    getPendingQuestion: questionOps.getPendingByChat,
    answerQuestion: (id: string, answer: string) => {
      const question = questionOps.answer(id, answer);
      if (question) {
        emitter?.emit("agent", {
          type: "question",
          event: "answered",
          question,
        });
      }
      return question;
    },
    cancelQuestion: (id: string) => {
      const question = questionOps.cancel(id);
      if (question) {
        emitter?.emit("agent", {
          type: "question",
          event: "cancelled",
          question,
        });
      }
      return question;
    },
    listQuestions: questionOps.list,
    deleteQuestion: questionOps.delete,

    // Approvals
    createApproval: (
      chatId: string,
      token: string,
      approvalType: "commandExecution" | "fileChange",
      params: ApprovalCreateParams
    ) => {
      const approval = approvalOps.create(chatId, token, approvalType, params);
      emitter?.emit("agent", {
        type: "approval",
        event: "requested",
        approval,
      });
      return approval;
    },
    getApproval: approvalOps.get,
    getApprovalByToken: approvalOps.getByToken,
    listApprovals: approvalOps.list,
    getPendingApprovals: approvalOps.getPendingByChat,
    respondToApproval: (id: string, accepted: boolean) => {
      const approval = approvalOps.respond(id, accepted);
      if (approval) {
        emitter?.emit("agent", {
          type: "approval",
          event: accepted ? "accepted" : "declined",
          approval,
        });
      }
      return approval;
    },
    cancelApproval: (id: string) => {
      const approval = approvalOps.cancel(id);
      if (approval) {
        emitter?.emit("agent", {
          type: "approval",
          event: "cancelled",
          approval,
        });
      }
      return approval;
    },
    deleteApproval: approvalOps.delete,

    close,
  };
};
