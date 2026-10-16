import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/auth/schema.ts",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED as string },
});
