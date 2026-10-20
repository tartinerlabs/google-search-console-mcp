import { createAuth } from "@tartinerlabs/mcp-core/auth";
import { db } from "../db/index.ts";
import * as schema from "../db/schema/auth.ts";

export { resource } from "@tartinerlabs/mcp-core/auth";

/** Google scope for read-only Search Console access. */
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

export const auth = createAuth({ db, schema, scopes: SCOPES });
