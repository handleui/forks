CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`token` text NOT NULL,
	`approval_type` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`item_id` text NOT NULL,
	`command` text,
	`cwd` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`data` text,
	`created_at` integer NOT NULL,
	`responded_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_token_unique` ON `approvals` (`token`);--> statement-breakpoint
CREATE INDEX `idx_approvals_chat_id` ON `approvals` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_approvals_chat_status` ON `approvals` (`chat_id`,`status`);--> statement-breakpoint
ALTER TABLE `attempts` ADD `worktree_path` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `branch` text;--> statement-breakpoint
CREATE INDEX `idx_attempts_status_created` ON `attempts` (`status`,`created_at`);