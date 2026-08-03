import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    googleSub: text("google_sub").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified").notNull().default(0),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    locale: text("locale").notNull().default("zh"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("users_google_sub_idx").on(table.googleSub),
    index("users_email_idx").on(table.email),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [index("auth_sessions_user_idx").on(table.userId, table.expiresAt)],
);

export const strategySubmissions = sqliteTable(
  "strategy_submissions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    sessionId: text("session_id").notNull(),
    createdAt: text("created_at").notNull(),
    title: text("title"),
    confirmedAt: text("confirmed_at"),
    archivedAt: text("archived_at"),
    intent: text("intent").notNull(),
    market: text("market").notNull(),
    asset: text("asset").notNull(),
    status: text("status").notNull(),
    model: text("model").notNull(),
    resultJson: text("result_json").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    feedback: text("feedback"),
    feedbackNote: text("feedback_note"),
    feedbackAt: text("feedback_at"),
  },
  (table) => [
    index("strategy_submissions_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("idx_strategy_submissions_user").on(table.userId, table.createdAt),
  ],
);

export const backtestRuns = sqliteTable(
  "backtest_runs",
  {
    id: text("id").primaryKey(),
    strategySubmissionId: text("strategy_submission_id").notNull(),
    userId: text("user_id"),
    sessionId: text("session_id").notNull(),
    createdAt: text("created_at").notNull(),
    asset: text("asset").notNull(),
    market: text("market").notNull(),
    timeframe: text("timeframe").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    initialCapital: real("initial_capital").notNull(),
    barCount: integer("bar_count").notNull(),
    tradeCount: integer("trade_count").notNull(),
    resultJson: text("result_json").notNull(),
  },
  (table) => [
    index("idx_backtest_runs_session_created").on(table.sessionId, table.createdAt),
    index("idx_backtest_runs_strategy").on(table.strategySubmissionId),
    index("idx_backtest_runs_user").on(table.userId, table.createdAt),
  ],
);

export const strategyArtifactCache = sqliteTable(
  "strategy_artifact_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    createdAt: text("created_at").notNull(),
    lastHitAt: text("last_hit_at").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    resultJson: text("result_json").notNull(),
  },
);

export const optimizationRuns = sqliteTable(
  "optimization_runs",
  {
    id: text("id").primaryKey(),
    strategySubmissionId: text("strategy_submission_id").notNull(),
    userId: text("user_id"),
    sessionId: text("session_id").notNull(),
    createdAt: text("created_at").notNull(),
    semanticLockHash: text("semantic_lock_hash").notNull(),
    objective: text("objective").notNull(),
    trialCount: integer("trial_count").notNull(),
    resultJson: text("result_json").notNull(),
    blindStatus: text("blind_status").notNull().default("reserved"),
    blindConsumedAt: text("blind_consumed_at"),
    blindResultJson: text("blind_result_json"),
    adoptedStrategyId: text("adopted_strategy_id"),
  },
  (table) => [
    index("idx_optimization_runs_session_created").on(table.sessionId, table.createdAt),
    index("idx_optimization_runs_strategy").on(table.strategySubmissionId),
    index("idx_optimization_runs_blind_status").on(table.sessionId, table.blindStatus),
    index("idx_optimization_runs_user").on(table.userId, table.createdAt),
  ],
);
