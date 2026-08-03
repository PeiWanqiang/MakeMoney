CREATE TABLE `strategy_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`intent` text NOT NULL,
	`market` text NOT NULL,
	`asset` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`result_json` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`feedback` text,
	`feedback_note` text,
	`feedback_at` text
);
