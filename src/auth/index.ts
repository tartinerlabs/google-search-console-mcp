import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuth } from "./create-auth.ts";
import * as schema from "./schema.ts";

if (!process.env.DATABASE_URL) {
  throw new Error("Missing required environment variable: DATABASE_URL");
}

/** Drizzle over a `pg` Pool (e.g. Neon's pooled connection string). */
const db = drizzle({
  connection: process.env.DATABASE_URL,
  relations: { ...defineRelations(schema), ...schema.authRelations },
});

/**
 * The deployed Better Auth instance. Also the module the Better Auth CLI loads
 * for `generate` (see src/auth/schema.ts).
 */
export const auth = createAuth(
  process.env,
  // camelCase: table and column names match Better Auth's field names.
  // transaction: multi-row writes (user + account, client + resources) are atomic.
  drizzleAdapter(db, {
    provider: "pg",
    schema,
    camelCase: true,
    transaction: true,
  }),
);
