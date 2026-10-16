/**
 * OAuth scopes requested from Google. Read-only by default; add
 * "https://www.googleapis.com/auth/webmasters" here when write tools are introduced.
 */
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

export type Env = Record<string, string | undefined>;
