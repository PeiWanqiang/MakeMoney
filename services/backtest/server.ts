import { pathToFileURL } from "node:url";

import { buildServer } from "./app.js";

const PORT = Number(process.env.BACKTEST_SERVICE_PORT ?? 8_780);
const HOST = process.env.BACKTEST_SERVICE_HOST ?? "127.0.0.1";

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = buildServer({ logger: true });
  app.listen({ port: PORT, host: HOST }, (error, address) => {
    if (error) {
      console.error("Failed to start backtest service", error);
      process.exit(1);
    }
    console.log(`Backtest service listening at ${address}`);
  });

  const shutdown = (): void => {
    app.close().then(() => process.exit(0)).catch((error) => {
      console.error("Failed to close backtest service", error);
      process.exit(1);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
