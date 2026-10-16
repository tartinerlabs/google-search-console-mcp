#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, SERVER_VERSION } from "./server.ts";
import { logger } from "./utils/logger.ts";

function startStdio(): void {
  const handle = serveStdio(() => createServer(), {
    onerror: (error) =>
      logger.error(
        { errorName: error.name, errorMessage: error.message },
        "stdio error",
      ),
  });
  logger.info(
    { version: SERVER_VERSION },
    "Google Search Console MCP server listening on stdio",
  );

  let closing = false;
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    logger.info({ reason }, "shutting down");
    handle
      .close()
      .catch((error: unknown) =>
        logger.error(
          { errorName: error instanceof Error ? error.name : typeof error },
          "close failed",
        ),
      )
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("close", () => shutdown("stdin closed"));
}

startStdio();
