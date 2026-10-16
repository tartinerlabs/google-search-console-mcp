import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/auth/schema.ts",
  out: "./migrations",
  // Only `drizzle-kit migrate` connects; `generate` works without a database.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
