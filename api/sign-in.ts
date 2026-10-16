// Vercel Function for the OAuth login page (`/sign-in` is rewritten here).
import { auth } from "../src/auth/index.ts";
import { createSignInHandler } from "../src/pages.ts";

export const GET = createSignInHandler(auth);
