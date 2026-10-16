import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { attachDatabasePool } from "@vercel/functions";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createAuth } from "./create-auth.ts";
import * as schema from "./schema.ts";

/** A `pg` Pool over Neon's pooled connection string. */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Lets Vercel Fluid compute close idle connections before suspending the instance.
attachDatabasePool(pool);

const db = drizzle({
  client: pool,
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
