// Vercel Function for the OAuth consent page (`/consent` is rewritten here).
import { auth } from "../src/auth/index.ts";
import { createConsentHandler } from "../src/pages.ts";

export const GET = createConsentHandler(auth);
