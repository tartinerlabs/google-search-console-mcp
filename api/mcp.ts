// Vercel Function for the MCP endpoint. Only POST is exported: the stateless
// 2026-07-28 protocol needs no GET or DELETE.
import { handleMcp } from "../src/http.ts";

export const POST = handleMcp;
