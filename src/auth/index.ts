import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuth } from "./create-auth.ts";
import * as schema from "./schema.ts";

/** Drizzle over a `pg` Pool (e.g. Neon's pooled connection string). */
const db = drizzle({
  connection: { connectionString: process.env.DATABASE_URL },
  relations: { ...defineRelations(schema), ...schema.authRelations },
});

/**
 * The deployed Better Auth instance. Also the module the Better Auth CLI loads
 * for `generate` (see README).
 */
export const auth = createAuth(
  process.env,
  // transaction: multi-row writes (user + account, client + resources) are atomic.
  drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
);
