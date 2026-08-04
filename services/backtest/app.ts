import Fastify, { type FastifyInstance } from "fastify";

import { CodedServiceError, type ServiceErrorEnvelope } from "./lib/errors.js";
import { registerBacktestRoutes } from "./routes/backtest.js";
import { registerVerifyRoutes } from "./routes/verify.js";

export const SERVICE_VERSION = "0.1.0";

/**
 * Builds the Fastify app so tests can inject it without binding a port.
 * A single large backtest transports up to 10,000 bars in the body, so the
 * default 1 MiB body limit is raised to fit the wire payload.
 */
export function buildServer(options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });

  app.get("/healthz", async () => ({ ok: true, engine: "quickjs-cli", version: SERVICE_VERSION }));

  registerBacktestRoutes(app);
  registerVerifyRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    const coded = error instanceof CodedServiceError ? error : null;
    const envelope: ServiceErrorEnvelope = {
      schemaVersion: "error-1.0",
      code: coded?.code ?? "INTERNAL_ERROR",
      message: coded?.message ?? (error instanceof Error ? error.message : "Unexpected error"),
      ...(coded?.diagnostics !== undefined ? { diagnostics: coded.diagnostics } : {}),
    };
    reply.status(coded?.statusCode ?? 500).send(envelope);
  });

  return app;
}
