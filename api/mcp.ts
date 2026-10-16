// Vercel Function (Node.js runtime) for the MCP endpoint; `/mcp` is rewritten here.
// Only POST is exported: the stateless 2026-07-28 protocol needs no GET or DELETE.
import { auth } from "../src/auth/index.ts";
import { createHttpHandler } from "../src/http.ts";

export const POST = createHttpHandler(auth, process.env);
