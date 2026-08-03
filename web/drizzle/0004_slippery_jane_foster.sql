CREATE TABLE `optimization_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_submission_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`semantic_lock_hash` text NOT NULL,
	`objective` text NOT NULL,
	`trial_count` integer NOT NULL,
	`result_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_optimization_runs_session_created` ON `optimization_runs` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_optimization_runs_strategy` ON `optimization_runs` (`strategy_submission_id`);