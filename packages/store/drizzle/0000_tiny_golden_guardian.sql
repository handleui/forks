CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`codex_thread_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_attempts_chat_id` ON `attempts` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_attempts_status` ON `attempts` (`status`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`codex_thread_id` text,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chats_workspace_id` ON `chats` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_chats_status` ON `chats` (`status`);--> statement-breakpoint
CREATE INDEX `idx_chats_updated_at` ON `chats` (`updated_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `subagents` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_chat_id` text NOT NULL,
	`parent_attempt_id` text,
	`task` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_subagents_parent_chat_id` ON `subagents` (`parent_chat_id`);--> statement-breakpoint
CREATE INDEX `idx_subagents_parent_attempt_id` ON `subagents` (`parent_attempt_id`);--> statement-breakpoint
CREATE INDEX `idx_subagents_status` ON `subagents` (`status`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`description` text NOT NULL,
	`claimed_by` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_chat_id` ON `tasks` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_claimed_by` ON `tasks` (`claimed_by`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_path_unique` ON `workspaces` (`path`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_project_id` ON `workspaces` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_status` ON `workspaces` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_last_accessed` ON `workspaces` (`last_accessed_at`);