import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createContainer } from "./container.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const container = createContainer(config);
const { logger, pool } = container;
const server = createApp(container).listen(config.port, () => logger.info("api listening", { port: config.port, env: config.nodeEnv }));

async function shutdown(signal) {
  logger.info("shutting down", { signal });
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", { reason: String(reason) }));
