import { Hono } from "hono";
import { handleMcp } from "./http.ts";
import type { SubmissionQueue } from "./indexnow/client.ts";
import { handleQueue, type QueueBatch } from "./queue.ts";

interface Env {
  INDEXNOW_QUEUE: SubmissionQueue;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({ name: "index-now-mcp", status: "ok", mcp: "/mcp" }),
);

app.post("/mcp", (c) => handleMcp(c.req.raw, c.env.INDEXNOW_QUEUE));

export default {
  fetch: app.fetch,
  queue: (batch: QueueBatch) => handleQueue(batch),
};
