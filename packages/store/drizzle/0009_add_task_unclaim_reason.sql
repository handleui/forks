-- Add unclaim_reason column to tasks table
-- Separates unclaim context from completion result for cleaner semantics
ALTER TABLE `tasks` ADD `unclaim_reason` text;
