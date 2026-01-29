import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull().unique(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    runInstall: integer("run_install", { mode: "boolean" }).default(false),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_projects_created_at").on(t.createdAt)]
);

export const envProfiles = sqliteTable(
  "env_profiles",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_env_profiles_project_id").on(t.projectId)]
);

export const envProfileFiles = sqliteTable(
  "env_profile_files",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => envProfiles.id, { onDelete: "cascade" }),
    sourcePath: text("source_path").notNull(),
    targetPath: text("target_path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.targetPath] })]
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    profileId: text("profile_id").references(() => envProfiles.id, {
      onDelete: "set null",
    }),
    path: text("path").notNull().unique(),
    branch: text("branch").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    lastAccessedAt: integer("last_accessed_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_workspaces_project_id").on(t.projectId),
    index("idx_workspaces_profile_id").on(t.profileId),
    index("idx_workspaces_status").on(t.status),
    index("idx_workspaces_last_accessed").on(t.lastAccessedAt),
  ]
);

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    codexThreadId: text("codex_thread_id"),
    title: text("title"),
    status: text("status", { enum: ["active", "completed", "archived"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_chats_workspace_id").on(t.workspaceId),
    index("idx_chats_status").on(t.status),
    index("idx_chats_updated_at").on(t.updatedAt),
  ]
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    codexThreadId: text("codex_thread_id"),
    status: text("status", {
      enum: ["running", "completed", "picked", "discarded"],
    })
      .notNull()
      .default("running"),
    result: text("result"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_attempts_chat_id").on(t.chatId),
    index("idx_attempts_status").on(t.status),
  ]
);

export const subagents = sqliteTable(
  "subagents",
  {
    id: text("id").primaryKey(),
    parentChatId: text("parent_chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    parentAttemptId: text("parent_attempt_id").references(() => attempts.id, {
      onDelete: "set null",
    }),
    task: text("task").notNull(),
    status: text("status", {
      enum: ["running", "completed", "cancelled", "failed"],
    })
      .notNull()
      .default("running"),
    result: text("result"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_subagents_parent_chat_id").on(t.parentChatId),
    index("idx_subagents_parent_attempt_id").on(t.parentAttemptId),
    index("idx_subagents_status").on(t.status),
  ]
);

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "cancelled"],
    })
      .notNull()
      .default("pending"),
    feedback: text("feedback"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    respondedAt: integer("responded_at", { mode: "number" }),
  },
  (t) => [
    index("idx_plans_project_id").on(t.projectId),
    index("idx_plans_chat_id").on(t.chatId),
    index("idx_plans_status").on(t.status),
    index("idx_plans_chat_status").on(t.chatId, t.status),
  ]
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    planId: text("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    claimedBy: text("claimed_by"),
    status: text("status", {
      enum: ["pending", "claimed", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    result: text("result"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_tasks_chat_id").on(t.chatId),
    index("idx_tasks_plan_id").on(t.planId),
    index("idx_tasks_status").on(t.status),
    index("idx_tasks_claimed_by").on(t.claimedBy),
  ]
);

export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    content: text("content").notNull(),
    status: text("status", { enum: ["pending", "answered", "cancelled"] })
      .notNull()
      .default("pending"),
    answer: text("answer"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    respondedAt: integer("responded_at", { mode: "number" }),
  },
  (t) => [
    index("idx_questions_chat_id").on(t.chatId),
    index("idx_questions_status").on(t.status),
    index("idx_questions_chat_status").on(t.chatId, t.status),
  ]
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    approvalType: text("approval_type", {
      enum: ["commandExecution", "fileChange"],
    }).notNull(),
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id").notNull(),
    itemId: text("item_id").notNull(),
    command: text("command"),
    cwd: text("cwd"),
    reason: text("reason"),
    status: text("status", {
      enum: ["pending", "accepted", "declined", "cancelled"],
    })
      .notNull()
      .default("pending"),
    data: text("data"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    respondedAt: integer("responded_at", { mode: "number" }),
  },
  (t) => [
    index("idx_approvals_chat_id").on(t.chatId),
    index("idx_approvals_chat_status").on(t.chatId, t.status),
  ]
);

// Inferred types for database rows
export type ProjectRow = typeof projects.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;
export type SubagentRow = typeof subagents.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type EnvProfileRow = typeof envProfiles.$inferSelect;
export type EnvProfileFileRow = typeof envProfileFiles.$inferSelect;
