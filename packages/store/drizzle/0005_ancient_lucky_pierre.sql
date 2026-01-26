-- SQLite limitation: ALTER TABLE ADD COLUMN does not support ON DELETE CASCADE
-- Must recreate table to add proper foreign key constraint
-- See: https://www.sqlite.org/lang_altertable.html

PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `tasks_new` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`plan_id` text,
	`description` text NOT NULL,
	`claimed_by` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

INSERT INTO `tasks_new` (`id`, `chat_id`, `description`, `claimed_by`, `status`, `result`, `created_at`, `updated_at`)
SELECT `id`, `chat_id`, `description`, `claimed_by`, `status`, `result`, `created_at`, `updated_at` FROM `tasks`;--> statement-breakpoint

DROP TABLE `tasks`;--> statement-breakpoint

ALTER TABLE `tasks_new` RENAME TO `tasks`;--> statement-breakpoint

CREATE INDEX `idx_tasks_chat_id` ON `tasks` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_plan_id` ON `tasks` (`plan_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_claimed_by` ON `tasks` (`claimed_by`);--> statement-breakpoint

PRAGMA foreign_keys=ON;

