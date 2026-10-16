import { Pool } from "pg";
import { createAuth } from "./create-auth.ts";

if (!process.env.DATABASE_URL) {
  throw new Error("Missing required environment variable: DATABASE_URL");
}

/**
 * The deployed Better Auth instance (Postgres via `pg`, e.g. Neon's pooled
 * connection string). Also the module the Better Auth CLI loads for
 * `generate` and `migrate`.
 */
export const auth = createAuth(
  process.env,
  new Pool({ connectionString: process.env.DATABASE_URL }),
);
