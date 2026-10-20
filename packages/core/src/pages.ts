import { createHash } from "node:crypto";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { Logger } from "pino";
import type { Auth } from "./auth.ts";

export interface PagesOptions {
  auth: Auth;
  logger: Logger;
  /** Shown on the consent page, e.g. "this Google Search Console MCP server". */
  serverName: string;
  /** Shown on the consent page, e.g. "read-only access to your Search Console data". */
  access: string;
}

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
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #f6f8fa; --card: #fff; --border: #d1d9e0; --accent: #1f6feb; --accent-fg: #fff; --danger: #d1242f; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --card: #151b23; --border: #3d444d; --accent: #2f81f7; --danger: #f85149; } }
* { box-sizing: border-box; }
body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem 1rem; color: var(--fg); background: var(--bg); }
main { width: 100%; max-width: 28rem; padding: 2rem; background: var(--card); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.08); }
h1 { font-size: 1.375rem; line-height: 1.3; margin: 0 0 1rem; }
p { margin: 0 0 1rem; }
p:last-child { margin-bottom: 0; }
dl { margin: 0 0 1.5rem; border: 1px solid var(--border); border-radius: 8px; }
dl div { padding: 0.625rem 0.875rem; }
dl div + div { border-top: 1px solid var(--border); }
dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
dd { margin: 0; }
code { font: 0.875rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.actions { display: flex; gap: 0.75rem; margin-bottom: 1.25rem; }
button { flex: 1; font: inherit; font-weight: 600; padding: 0.625rem 1rem; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
button[data-accept="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button:hover:not(:disabled) { filter: brightness(1.08); }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: 0.6; cursor: progress; }
a { color: var(--accent); }
.muted { font-size: 0.875rem; color: var(--muted); text-align: center; }
#error { color: var(--danger); text-align: center; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
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

/** The two OAuth pages, bound to one app's Better Auth instance. */
export function createPages({
  auth,
  logger,
  serverName,
  access,
}: PagesOptions) {
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
  async function signInPage(request: Request): Promise<Response> {
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
      logger.warn(
        { status: response.status },
        "Google sign-in could not start",
      );
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
  async function consentPage(request: Request): Promise<Response> {
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
      `<p><strong>${escapeHtml(clientName)}</strong> wants to use ${escapeHtml(serverName)} with ${escapeHtml(access)}.</p>
<dl>
<div><dt>Signed in as</dt><dd>${escapeHtml(session.user.email)}</dd></div>
<div><dt>Redirects to</dt><dd><code>${escapeHtml(redirectTarget)}</code></dd></div>
<div><dt>Client ID</dt><dd><code>${escapeHtml(clientId)}</code></dd></div>
</dl>
<div class="actions"><button type="button" data-accept="false">Deny</button><button type="button" data-accept="true">Allow</button></div>
<p id="error" hidden>Something went wrong. Start again from your MCP client.</p>
<p class="muted"><a href="/sign-in?${escapeHtml(oauthQuery)}">Use a different Google account</a></p>
<script>${CONSENT_SCRIPT}</script>`,
      CONSENT_SCRIPT_HASH,
    );
  }

  return { signInPage, consentPage };
}
