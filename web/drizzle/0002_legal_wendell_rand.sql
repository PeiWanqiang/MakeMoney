CREATE TABLE `backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_submission_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`asset` text NOT NULL,
	`market` text NOT NULL,
	`timeframe` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`initial_capital` real NOT NULL,
	`bar_count` integer NOT NULL,
	`trade_count` integer NOT NULL,
	`result_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_session_created` ON `backtest_runs` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_strategy` ON `backtest_runs` (`strategy_submission_id`);--> statement-breakpoint
PRAGMA optimize;
