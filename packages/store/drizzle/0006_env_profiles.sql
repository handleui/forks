-- Add run_install column to projects table
ALTER TABLE `projects` ADD `run_install` integer DEFAULT false;--> statement-breakpoint

-- Create env_profiles table
CREATE TABLE `env_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE INDEX `idx_env_profiles_project_id` ON `env_profiles` (`project_id`);--> statement-breakpoint

-- Create env_profile_files table with composite primary key
CREATE TABLE `env_profile_files` (
	`profile_id` text NOT NULL,
	`source_path` text NOT NULL,
	`target_path` text NOT NULL,
	PRIMARY KEY(`profile_id`, `target_path`),
	FOREIGN KEY (`profile_id`) REFERENCES `env_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

-- Add profile_id to workspaces table
-- SQLite limitation: ALTER TABLE ADD COLUMN does not support ON DELETE SET NULL
-- Must recreate table to add proper foreign key constraint
PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `workspaces_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`profile_id` text,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `env_profiles`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

INSERT INTO `workspaces_new` (`id`, `project_id`, `path`, `branch`, `name`, `status`, `created_at`, `last_accessed_at`)
SELECT `id`, `project_id`, `path`, `branch`, `name`, `status`, `created_at`, `last_accessed_at` FROM `workspaces`;--> statement-breakpoint

DROP TABLE `workspaces`;--> statement-breakpoint

ALTER TABLE `workspaces_new` RENAME TO `workspaces`;--> statement-breakpoint

CREATE UNIQUE INDEX `workspaces_path_unique` ON `workspaces` (`path`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_project_id` ON `workspaces` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_profile_id` ON `workspaces` (`profile_id`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_status` ON `workspaces` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_last_accessed` ON `workspaces` (`last_accessed_at`);--> statement-breakpoint

PRAGMA foreign_keys=ON;
