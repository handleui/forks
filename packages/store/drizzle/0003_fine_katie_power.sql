CREATE INDEX `idx_plans_chat_status` ON `plans` (`chat_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_questions_chat_status` ON `questions` (`chat_id`,`status`);