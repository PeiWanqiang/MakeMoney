CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`locale` text DEFAULT 'zh' NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_idx` ON `users` (`google_sub`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_user` ON `backtest_runs` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `optimization_runs` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `idx_optimization_runs_user` ON `optimization_runs` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `strategy_submissions` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `strategy_submissions` ADD `title` text;--> statement-breakpoint
ALTER TABLE `strategy_submissions` ADD `confirmed_at` text;--> statement-breakpoint
ALTER TABLE `strategy_submissions` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `idx_strategy_submissions_user` ON `strategy_submissions` (`user_id`,`created_at`);