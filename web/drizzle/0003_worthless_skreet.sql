CREATE TABLE `strategy_artifact_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`last_hit_at` text NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`result_json` text NOT NULL
);
--> statement-breakpoint
PRAGMA optimize;
