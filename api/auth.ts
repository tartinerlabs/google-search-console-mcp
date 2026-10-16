// Vercel Function for Better Auth.
import { auth } from "../src/lib/auth.ts";

export default { fetch: auth.handler };
