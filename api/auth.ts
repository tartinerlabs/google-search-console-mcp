// Vercel Function for Better Auth: `/api/auth/*` (and `/.well-known/*`, where
// Vercel allows it) is rewritten here. Vercel passes the original path in
// `request.url`, which is what `auth.handler` routes on.

import { createAuthHandler } from "../src/auth/create-auth.ts";
import { auth } from "../src/auth/index.ts";

export default { fetch: createAuthHandler(auth) };
