-- Add codex_thread_id to subagents table
ALTER TABLE `subagents` ADD `codex_thread_id` text;--> statement-breakpoint
-- Add composite index for listRunningByChat queries
CREATE INDEX `idx_subagents_chat_status` ON `subagents` (`parent_chat_id`,`status`);
