import { createHash } from "node:crypto";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { auth } from "./lib/auth.ts";
import { logger } from "./utils/logger.ts";

/**
 * The two pages the OAuth flow redirects to. Better Auth signs the query it
 * appends (`sig`, `exp`), so both pages verify it before acting on it.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

// Posts the decision with the signed query, then follows the redirect Better Auth returns.
const CONSENT_SCRIPT = `
for (const button of document.querySelectorAll("button[data-accept]")) {
  button.addEventListener("click", async () => {
    for (const b of document.querySelectorAll("button")) b.disabled = true;
    const response = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accept: button.dataset.accept === "true",
        oauth_query: location.search.slice(1),
      }),
    });
    const data = await response.json().catch(() => ({}));
    const target = data.url ?? data.redirect_uri;
    if (response.ok && typeof target === "string") location.href = target;
    else document.getElementById("error").hidden = false;
  });
}
`;
const CONSENT_SCRIPT_HASH = createHash("sha256")
  .update(CONSENT_SCRIPT)
  .digest("base64");

function page(
  status: number,
  title: string,
  body: string,
  scriptHash?: string,
): Response {
  const scriptSrc = scriptHash ? `'sha256-${scriptHash}'` : "'none'";
  return new Response(
    `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
button { font: inherit; padding: 0.5rem 1.25rem; margin-right: 0.5rem; cursor: pointer; }
code { word-break: break-all; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

const INVALID_LINK =
  "<p>This link is invalid or has expired. Start again from your MCP client.</p>";

async function signedQuery(request: Request): Promise<string | undefined> {
  const query = new URL(request.url).search.slice(1);
  const { secret } = await auth.$context;
  return (await verifyOAuthQueryParams(query, secret)) ? query : undefined;
}

/**
 * GET /sign-in: there is nothing to choose, so start "Sign in with Google"
 * straight away. Better Auth keeps the signed authorisation request in the
 * Google OAuth state and resumes it after the Google callback.
 */
export async function signInPage(request: Request): Promise<Response> {
  const oauthQuery = await signedQuery(request);
  if (!oauthQuery) return page(400, "Sign-in link expired", INVALID_LINK);

  // `oauth_query` is read by the OAuth provider plugin's before-hook, which
  // stores the signed authorisation request in the Google OAuth state; the
  // core sign-in body type does not declare it, hence the separate object.
  const body = { provider: "google", oauth_query: oauthQuery };
  const response = await auth.api.signInSocial({
    body,
    headers: request.headers,
    asResponse: true,
  });
  const data: unknown = await response.json().catch(() => undefined);
  const url =
    typeof data === "object" && data !== null && "url" in data
      ? data.url
      : undefined;
  if (!response.ok || typeof url !== "string") {
    logger.warn({ status: response.status }, "Google sign-in could not start");
    return page(
      502,
      "Sign-in failed",
      "<p>Google sign-in could not be started. Try again later.</p>",
    );
  }

  const headers = new Headers({ location: url, "cache-control": "no-store" });
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

/**
 * GET /consent: show which client is asking and where it will be sent, and
 * post the user's decision to Better Auth's consent endpoint.
 */
export async function consentPage(request: Request): Promise<Response> {
  const oauthQuery = await signedQuery(request);
  if (!oauthQuery) return page(400, "Consent link expired", INVALID_LINK);

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return page(
      401,
      "Not signed in",
      "<p>Your session has ended. Start again from your MCP client.</p>",
    );
  }

  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id") ?? "";
  let redirectTarget = "";
  try {
    const redirect = new URL(params.get("redirect_uri") ?? "");
    // Private-use schemes (com.example.app:/cb) have no host: show the whole URI.
    redirectTarget = redirect.host || redirect.href;
  } catch {
    return page(400, "Invalid request", INVALID_LINK);
  }
  const client = await auth.api
    .getOAuthClientPublic({
      query: { client_id: clientId },
      headers: request.headers,
    })
    .catch(() => undefined);
  const clientName = client?.client_name ?? clientId;

  return page(
    200,
    "Allow access?",
    `<p><strong>${escapeHtml(clientName)}</strong> wants to use this Google Search Console MCP server as <strong>${escapeHtml(session.user.email)}</strong>, with read-only access to your Search Console data.</p>
<p>After you allow it, you will be sent to <code>${escapeHtml(redirectTarget)}</code>.</p>
<p>Client ID: <code>${escapeHtml(clientId)}</code></p>
<p><button type="button" data-accept="true">Allow</button><button type="button" data-accept="false">Deny</button></p>
<p id="error" hidden>Something went wrong. Start again from your MCP client.</p>
<script>${CONSENT_SCRIPT}</script>`,
    CONSENT_SCRIPT_HASH,
  );
}
