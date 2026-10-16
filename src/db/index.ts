import { drizzle } from "drizzle-orm/node-postgres";
import { authRelations } from "./schema/auth.ts";

export const db = drizzle(process.env.DATABASE_URL!, {
  relations: authRelations,
});
