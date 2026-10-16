import { existsSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { CredentialsError } from "../utils/errors.ts";

/**
 * OAuth scopes requested from Google. Read-only by default; add
 * "https://www.googleapis.com/auth/webmasters" here when write tools are introduced.
 */
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

export type Env = Record<string, string | undefined>;

/**
 * Credentials for the local stdio entry (debugging only): the file named by
 * GSC_CREDENTIALS_PATH, otherwise Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS, gcloud ADC). The remote server uses each
 * signed-in user's own Google token instead (see src/auth/google-token.ts).
 */
export function createGoogleAuth(env: Env = process.env): GoogleAuth {
  const keyFilename = env.GSC_CREDENTIALS_PATH;
  if (!keyFilename) return new GoogleAuth({ scopes: SCOPES });
  if (!existsSync(keyFilename)) {
    throw new CredentialsError(
      "GSC_CREDENTIALS_PATH points to a file that does not exist.",
    );
  }
  return new GoogleAuth({ scopes: SCOPES, keyFilename });
}
