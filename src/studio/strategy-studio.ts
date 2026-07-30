import { createHash, randomUUID } from "node:crypto";

import {
  compileStrategySource,
  StrategyCompilationError,
} from "../compiler/compile-strategy-source.js";
import { diffStrategySource } from "./source-diff.js";
import type { SemanticVerificationReport } from "../semantics/contract.js";
import { verifyStrategySemantics } from "../semantics/verify-semantics.js";
import { FileStrategySessionStore } from "./session-store.js";
import type {
  CompilationAttempt,
  StrategyEvaluator,
  StrategyGenerationMode,
  StrategyProgramProvider,
  StrategyProviderResponse,
  StrategySession,
  StrategyVersionArtifact,
} from "./types.js";

export class StrategyGenerationError extends Error {
  readonly attempts: CompilationAttempt[];

  constructor(attempts: CompilationAttempt[]) {
    super(`The generated strategy did not compile after ${attempts.length} attempt(s).`);
    this.name = "StrategyGenerationError";
    this.attempts = attempts;
  }
}

export class StrategyNeedsClarificationError extends Error {
  readonly response: StrategyProviderResponse;

  constructor(response: StrategyProviderResponse) {
    super(`Strategy needs clarification: ${response.artifact.contract.unsupportedCapabilities.join(", ")}`);
    this.name = "StrategyNeedsClarificationError";
    this.response = response;
  }
}

export interface StrategyStudioOptions {
  provider: StrategyProgramProvider;
  store?: FileStrategySessionStore;
  evaluator?: StrategyEvaluator;
  maxRepairAttempts?: number;
}

export interface CreateStrategyInput {
  intent: string;
  sessionId?: string;
}

export interface ReviseStrategyInput {
  sessionId: string;
  intent: string;
  parentVersionId?: string;
}

function versionIdentifier(value: Omit<StrategyVersionArtifact, "versionId">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sessionId: value.sessionId,
      ordinal: value.ordinal,
      parentVersionId: value.parentVersionId,
      userIntent: value.userIntent,
      sourceHash: value.sourceHash,
      contract: value.contract,
      evaluationId: value.evaluation?.evaluationId ?? null,
    }))
    .digest("hex");
}

export class StrategyStudio {
  private readonly provider: StrategyProgramProvider;
  private readonly store: FileStrategySessionStore;
  private readonly evaluator: StrategyEvaluator | undefined;
  private readonly maxRepairAttempts: number;

  constructor(options: StrategyStudioOptions) {
    this.provider = options.provider;
    this.store = options.store ?? new FileStrategySessionStore();
    this.evaluator = options.evaluator;
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
    if (!Number.isInteger(this.maxRepairAttempts) || this.maxRepairAttempts < 0) {
      throw new Error("maxRepairAttempts must be a non-negative integer.");
    }
  }

  private async generateCompilable(input: {
    mode: Exclude<StrategyGenerationMode, "repair">;
    sessionId: string;
    originalIntent: string;
    userIntent: string;
    currentSource?: string;
  }): Promise<{
    response: StrategyProviderResponse;
    sourceHash: string;
    failedAttempts: CompilationAttempt[];
    semanticVerification: SemanticVerificationReport;
  }> {
    const failedAttempts: CompilationAttempt[] = [];
    let mode: StrategyGenerationMode = input.mode;
    let currentSource = input.currentSource;
    let diagnostics = undefined;

    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt += 1) {
      const response = await this.provider.generate({
        mode,
        sessionId: input.sessionId,
        userIntent: input.userIntent,
        originalIntent: input.originalIntent,
        attempt,
        ...(currentSource === undefined ? {} : { currentSource }),
        ...(diagnostics === undefined ? {} : { compilerDiagnostics: diagnostics }),
      });
      if (response.artifact.status === "needs_clarification") throw new StrategyNeedsClarificationError(response);
      try {
        const compiled = compileStrategySource(response.artifact.source);
        const semanticVerification = await verifyStrategySemantics(response.artifact.source, response.artifact.contract);
        if (!semanticVerification.ok) {
          const semanticDiagnostics = semanticVerification.diagnostics.map((item) => ({
            code: item.code,
            message: [
              item.message,
              item.expected === undefined ? undefined : `Expected: ${item.expected}`,
              item.actual === undefined ? undefined : `Actual: ${item.actual}`,
            ].filter((value): value is string => value !== undefined).join(" "),
          }));
          failedAttempts.push({
            attempt,
            mode,
            provider: response.provider,
            model: response.model,
            ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
            source: response.artifact.source,
            diagnostics: semanticDiagnostics,
          });
          currentSource = response.artifact.source;
          diagnostics = semanticDiagnostics;
          mode = "repair";
          continue;
        }
        return { response, sourceHash: compiled.sourceHash, failedAttempts, semanticVerification };
      } catch (error) {
        if (!(error instanceof StrategyCompilationError)) throw error;
        failedAttempts.push({
          attempt,
          mode,
          provider: response.provider,
          model: response.model,
          ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
          source: response.artifact.source,
          diagnostics: error.diagnostics,
        });
        currentSource = response.artifact.source;
        diagnostics = error.diagnostics;
        mode = "repair";
      }
    }
    throw new StrategyGenerationError(failedAttempts);
  }

  async create(input: CreateStrategyInput): Promise<{ session: StrategySession; version: StrategyVersionArtifact }> {
    if (!input.intent.trim()) throw new Error("Strategy intent cannot be empty.");
    const sessionId = input.sessionId ?? randomUUID().replaceAll("-", "");
    const generated = await this.generateCompilable({
      mode: "create",
      sessionId,
      originalIntent: input.intent,
      userIntent: input.intent,
    });
    const evaluation = await this.evaluator?.evaluate(generated.response.artifact.source);
    const createdAt = new Date().toISOString();
    const withoutId: Omit<StrategyVersionArtifact, "versionId"> = {
      schemaVersion: "1.0",
      sessionId,
      ordinal: 1,
      parentVersionId: null,
      createdAt,
      originalIntent: input.intent,
      userIntent: input.intent,
      source: generated.response.artifact.source,
      sourceHash: generated.sourceHash,
      contract: generated.response.artifact.contract,
      semanticVerification: generated.semanticVerification,
      explanation: generated.response.artifact.explanation,
      assumptions: generated.response.artifact.assumptions,
      warnings: generated.response.artifact.warnings,
      changeSummary: generated.response.artifact.changeSummary,
      sourceDiff: diffStrategySource(undefined, generated.response.artifact.source),
      generation: {
        provider: generated.response.provider,
        model: generated.response.model,
        ...(generated.response.responseId === undefined ? {} : { responseId: generated.response.responseId }),
        repairCount: generated.failedAttempts.length,
        ...(generated.response.usage === undefined ? {} : { usage: generated.response.usage }),
      },
      failedCompilationAttempts: generated.failedAttempts,
      ...(evaluation === undefined ? {} : { evaluation }),
    };
    const version: StrategyVersionArtifact = { ...withoutId, versionId: versionIdentifier(withoutId) };
    const session: StrategySession = {
      schemaVersion: "1.0",
      sessionId,
      createdAt,
      updatedAt: createdAt,
      originalIntent: input.intent,
      versionIds: [version.versionId],
    };
    await this.store.saveNewSession(session, version);
    return { session, version };
  }

  async revise(input: ReviseStrategyInput): Promise<{ session: StrategySession; version: StrategyVersionArtifact }> {
    if (!input.intent.trim()) throw new Error("Revision intent cannot be empty.");
    const session = await this.store.loadSession(input.sessionId);
    const parent = input.parentVersionId
      ? await this.store.loadVersion(input.sessionId, input.parentVersionId)
      : await this.store.loadLatestVersion(input.sessionId);
    const generated = await this.generateCompilable({
      mode: "revise",
      sessionId: input.sessionId,
      originalIntent: session.originalIntent,
      userIntent: input.intent,
      currentSource: parent.source,
    });
    const evaluation = await this.evaluator?.evaluate(generated.response.artifact.source);
    const createdAt = new Date().toISOString();
    const withoutId: Omit<StrategyVersionArtifact, "versionId"> = {
      schemaVersion: "1.0",
      sessionId: input.sessionId,
      ordinal: session.versionIds.length + 1,
      parentVersionId: parent.versionId,
      createdAt,
      originalIntent: session.originalIntent,
      userIntent: input.intent,
      source: generated.response.artifact.source,
      sourceHash: generated.sourceHash,
      contract: generated.response.artifact.contract,
      semanticVerification: generated.semanticVerification,
      explanation: generated.response.artifact.explanation,
      assumptions: generated.response.artifact.assumptions,
      warnings: generated.response.artifact.warnings,
      changeSummary: generated.response.artifact.changeSummary,
      sourceDiff: diffStrategySource(parent.source, generated.response.artifact.source),
      generation: {
        provider: generated.response.provider,
        model: generated.response.model,
        ...(generated.response.responseId === undefined ? {} : { responseId: generated.response.responseId }),
        repairCount: generated.failedAttempts.length,
        ...(generated.response.usage === undefined ? {} : { usage: generated.response.usage }),
      },
      failedCompilationAttempts: generated.failedAttempts,
      ...(evaluation === undefined ? {} : { evaluation }),
    };
    const version: StrategyVersionArtifact = { ...withoutId, versionId: versionIdentifier(withoutId) };
    const updatedSession = await this.store.appendVersion(version);
    return { session: updatedSession, version };
  }
}
