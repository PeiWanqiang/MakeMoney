ALTER TABLE `optimization_runs` ADD `blind_status` text DEFAULT 'reserved' NOT NULL;--> statement-breakpoint
ALTER TABLE `optimization_runs` ADD `blind_consumed_at` text;--> statement-breakpoint
ALTER TABLE `optimization_runs` ADD `blind_result_json` text;--> statement-breakpoint
ALTER TABLE `optimization_runs` ADD `adopted_strategy_id` text;--> statement-breakpoint
CREATE INDEX `idx_optimization_runs_blind_status` ON `optimization_runs` (`session_id`,`blind_status`);