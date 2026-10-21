import { Hono } from "hono";
import { handleMcp } from "./http.ts";

const app = new Hono();

app.get("/", (c) =>
  c.json({ name: "index-now-mcp", status: "ok", mcp: "/mcp" }),
);

app.post("/mcp", (c) => handleMcp(c.req.raw));

export default app;
