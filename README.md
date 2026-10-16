# Google Search Console MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives MCP clients read-only access to Google Search Console data: properties, Search Analytics performance, URL Inspection and sitemaps.

The server runs as a stateless Streamable HTTP endpoint on Vercel. MCP clients connect with nothing but its URL, `https://<your-domain>/mcp`: on first use the client opens a browser, you sign in with Google and approve the client, and every tool call then runs as **your** Google account. Nothing needs to run on your machine.

The repository also contains a stdio entry point for local debugging with the MCP Inspector.

> This project is not affiliated with, endorsed by or supported by Google. "Google" and "Search Console" are trademarks of Google LLC.

## Features

| Tool | What it does |
| --- | --- |
| `ping` | Checks that the server is running. |
| `list_sites` | Lists the properties the signed-in account can access, with its permission level. |
| `search_analytics` | Clicks, impressions, CTR and average position for a date range, optionally grouped by dimensions and filtered. |
| `inspect_url` | URL Inspection result for a page: index verdict, coverage, crawl, canonical, robots.txt, AMP, mobile usability and rich results. |
| `list_sitemaps` | Sitemaps submitted for a property, with dates, error/warning counts and submitted URL counts. |

All tools are read-only and use the `https://www.googleapis.com/auth/webmasters.readonly` scope. Tool failures are returned as MCP tool results with `isError: true` and a category prefix: `[invalid_input]`, `[auth]`, `[permission]`, `[quota]`, `[not_found]`, `[unavailable]`, `[network]` or `[unexpected]`.

### `search_analytics` parameters

Values follow the [Search Analytics API reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

| Parameter | Values |
| --- | --- |
| `siteUrl` | Property exactly as returned by `list_sites`: `https://www.example.com/` (trailing slash) or `sc-domain:example.com` |
| `startDate`, `endDate` | `YYYY-MM-DD`, Pacific Time, inclusive, `startDate` ≤ `endDate` |
| `dimensions` | Any of `date`, `hour`, `query`, `page`, `country`, `device`, `searchAppearance` (each at most once) |
| `type` | `web` (default), `image`, `video`, `news`, `discover`, `googleNews` |
| `filters` | `{ dimension, operator, expression }` where `dimension` is `country`, `device`, `page`, `query` or `searchAppearance` and `operator` is `equals` (default), `notEquals`, `contains`, `notContains`, `includingRegex` or `excludingRegex` (RE2). All filters must match. |
| `aggregationType` | `auto` (default), `byPage`, `byProperty`, `byNewsShowcasePanel` |
| `dataState` | `final` (default), `all`, `hourly_all` (use with the `hour` dimension) |
| `rowLimit` | 1–25,000 (default 1,000) |
| `startRow` | 0 or more, for paging |

## How it works

- [Better Auth](https://www.better-auth.com) 1.7 acts as the OAuth 2.1 authorisation server for MCP clients, using its [MCP plugin](https://www.better-auth.com/docs/plugins/mcp) (`@better-auth/mcp`), the JWT plugin and [Client ID Metadata Documents](https://www.better-auth.com/docs/plugins/cimd) (`@better-auth/cimd`). Dynamic client registration is **off**; clients identify themselves with a metadata document URL (CIMD), and only the authorisation-code (PKCE S256) and refresh-token grants are enabled.
- The only way to sign in is **Sign in with Google**. Google is asked for the `webmasters.readonly` scope with offline access, and Better Auth stores the Google tokens per user in Postgres, encrypted (`account.encryptOAuthTokens`), and refreshes them when they expire.
- `POST /mcp` without a valid access token gets `401` with an RFC 9728 `WWW-Authenticate: Bearer resource_metadata="https://<your-domain>/api/auth/oauth-protected-resource/mcp"` challenge, which is how clients discover the authorisation server. The metadata is served under `/api/auth` rather than `/.well-known` because Vercel's documentation says `/.well-known` cannot be rewritten to a function. Access tokens are JWTs bound to the `https://<your-domain>/mcp` resource and verified against the server's JWKS.
- Only Google-verified email addresses in `ALLOWED_EMAILS` can create an account, and the allow-list is checked again on every MCP request.
- The MCP endpoint is stateless (the SDK's `createMcpHandler`): it serves MCP **2026-07-28** and, statelessly, 2025-era requests from clients on the earlier protocol.

| Path | Served by | Purpose |
| --- | --- | --- |
| `/mcp` | `api/mcp.ts` (`POST` only) | MCP endpoint |
| `/api/auth/*` | `api/auth.ts` | Better Auth: authorise, token, consent, JWKS, Google callback, metadata |
| `/api/auth/oauth-protected-resource/mcp` | `api/auth.ts` | Protected resource metadata (RFC 9728), the URL named in the 401 challenge |
| `/api/auth/.well-known/openid-configuration` | `api/auth.ts` | Authorisation server metadata |
| `/.well-known/*` | `api/auth.ts` (rewrite, if Vercel honours it) | The same metadata at the RFC 8414 / RFC 9728 well-known paths; not relied on |
| `/sign-in` | `api/sign-in.ts` | Starts Google sign-in straight away (no UI) |
| `/consent` | `api/consent.ts` | Shows the client name, the account and the redirect host, with Allow / Deny |

## Prerequisites

- Node.js and pnpm as declared in `devEngines` in `package.json` (pnpm 12 downloads the declared Node.js version automatically).
- A Google account with access to at least one Search Console property.
- A Google Cloud project you control.
- A Vercel account and, optionally, the [Vercel CLI](https://vercel.com/docs/cli).
- A Postgres database. [Neon](https://neon.com) through the Vercel Marketplace is the documented option.

## Installation

```sh
# Replace <repository-url> with this repository's clone URL.
git clone <repository-url> google-search-console-mcp
cd google-search-console-mcp
pnpm install
```

## Google Cloud Console setup

1. Create or select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Search Console API**: *APIs & Services → Library → Google Search Console API → Enable*.
3. Configure the OAuth consent screen (*Google Auth Platform → Branding / Audience / Data Access*):
   - User type **External**.
   - Under *Data Access*, add the scope `https://www.googleapis.com/auth/webmasters.readonly` (plus the default `openid`, `email` and `profile`).
4. Create the OAuth client: *Google Auth Platform → Clients → Create client*:
   - Application type: **Web application**.
   - Authorised redirect URI: `https://<your-domain>/api/auth/callback/google` (Better Auth's callback path for the Google provider).
   - Copy the client ID and client secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Publishing status: Google expires refresh tokens after **7 days** for External apps in **Testing** status, so you would have to reconnect weekly. Set the app to **In production** (*Audience → Publish app*). Until Google has verified the app you will see an "unverified app" warning when signing in, and `webmasters.readonly` is a sensitive scope: complete Google's verification before letting anyone else use your deployment.

Expired or revoked Google access is reported to the client as an `[auth]` tool error asking you to reconnect.

## Database (Neon)

1. In the Vercel dashboard, open your project → *Storage* → add **Neon** from the Marketplace and connect it to the project. This adds the connection strings to the project's environment variables. Use the **pooled** connection string as `DATABASE_URL`.
2. Create the tables. The schema in `migrations/0001_better_auth.sql` was generated with Better Auth's CLI (`auth generate`) for this configuration. Either run it in the Neon SQL Editor, or from your machine:

   ```sh
   psql "<your Neon connection string>" -f migrations/0001_better_auth.sql
   ```

   Alternatively, let the Better Auth CLI create or update the tables. It loads `src/auth/index.ts`, so every variable in the table below (except `ALLOWED_EMAILS` and the optional ones) must be set in your shell:

   ```sh
   pnpm dlx auth@1.7.10 migrate --config src/auth/index.ts
   ```

   Re-run `generate`/`migrate` after upgrading Better Auth or changing plugins: Better Auth logs a "Database schema mismatch" error at start-up when tables or columns are missing.

## Deploying to Vercel

`vercel.json` uses the *Other* framework preset, rewrites the public paths to the functions above, and publishes only `public/` (a `robots.txt` that disallows crawling) as static files, so neither the repository nor `dist/` is served. Each function in `api/` is a Vercel Function on the Node.js runtime, compiled by Vercel from TypeScript.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string (Neon pooled URL). |
| `BETTER_AUTH_SECRET` | Yes | Secret for signing and encryption, at least 32 random bytes: `openssl rand -base64 32`. Changing it invalidates sessions and stored Google tokens. |
| `BETTER_AUTH_URL` | Yes | Public origin of the deployment, e.g. `https://gsc.example.com`. The MCP resource is `<BETTER_AUTH_URL>/mcp` and must be exactly the URL clients use. |
| `GOOGLE_CLIENT_ID` | Yes | Web application OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Yes | Web application OAuth client secret. |
| `ALLOWED_EMAILS` | Yes | Comma-separated Google account emails allowed to sign in (case-insensitive). Empty or unset means nobody can. |
| `MCP_ALLOWED_HOSTS` | No | Comma-separated extra hostnames accepted in the `Host` header of `/mcp`. The `BETTER_AUTH_URL` host and Vercel's `VERCEL_URL`, `VERCEL_BRANCH_URL` and `VERCEL_PROJECT_PRODUCTION_URL` are always accepted. |
| `MCP_ALLOWED_ORIGINS` | No | Comma-separated hostnames allowed in a browser `Origin` header on `/mcp` (requests without `Origin`, as sent by non-browser clients, pass). |
| `LOG_LEVEL` | No | Pino level (`info` by default). Logs go to stderr; tokens, secrets, cookies and `Authorization` headers are redacted. |

### Deploy

1. Create the Vercel project (Git integration via the dashboard, or `vercel link`).
2. Add Neon and create the tables (see [Database](#database-neon)).
3. Add the variables (each command prompts for the value, so secrets stay out of your shell history):

   ```sh
   vercel env add BETTER_AUTH_SECRET production
   vercel env add BETTER_AUTH_URL production
   vercel env add GOOGLE_CLIENT_ID production
   vercel env add GOOGLE_CLIENT_SECRET production
   vercel env add ALLOWED_EMAILS production
   ```

4. Deploy with `vercel deploy --prod`, or push to the branch connected through the Git integration.
5. Add `https://<your-domain>/api/auth/callback/google` to the Google OAuth client if you have not already.

If you use a custom domain, set `BETTER_AUTH_URL` to it.

## Connecting a client

Use only the URL; the client discovers the rest and opens your browser for Google sign-in and consent.

Claude Code (untested against a live deployment):

```sh
claude mcp add --transport http google-search-console https://<your-domain>/mcp
```

Generic client configuration (untested; key names vary between clients):

```json
{
  "mcpServers": {
    "google-search-console": {
      "type": "http",
      "url": "https://<your-domain>/mcp"
    }
  }
}
```

The client must support OAuth with Client ID Metadata Documents.

## Local development

```sh
pnpm dev          # stdio server with Node's native type stripping and --watch
pnpm check        # typecheck + lint + test
pnpm format       # Biome formatter
pnpm test:watch   # Vitest in watch mode
```

The tests need no database, network or Google credentials. The OAuth tests run a real Better Auth instance on its in-memory adapter: they cover the discovery metadata, the 401 challenge, the allow-list at sign-up and on every MCP request, the `/sign-in` and `/consent` pages, a full authorisation-code + PKCE flow ending in an MCP tool call, and Google token retrieval and refresh (with Google's token endpoint mocked).

The stdio entry is for debugging only. It reads Google credentials from `GSC_CREDENTIALS_PATH` (an `authorized_user` or service-account JSON file) or from [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) (`GOOGLE_APPLICATION_CREDENTIALS`, or gcloud ADC created with `--client-id-file` pointing at your own OAuth client, because gcloud's built-in client cannot request Search Console scopes). A service account only sees properties it has been added to in Search Console. Without credentials the server still starts and Google tools return an `[auth]` error.

## Production build

```sh
pnpm build        # tsc emits dist/ (Vercel runs this too)
pnpm start        # node dist/index.js (stdio, for debugging only)
```

## Testing with the MCP Inspector

Stdio (verified):

```sh
pnpm dlx @modelcontextprotocol/inspector node dist/index.js
pnpm dlx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
pnpm dlx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name ping
```

Remote HTTP (not verified): start the web UI with `pnpm dlx @modelcontextprotocol/inspector`, choose the *Streamable HTTP* transport and enter `https://<your-domain>/mcp`. The Inspector must support the OAuth flow described above.

## Security considerations

- Anyone in `ALLOWED_EMAILS` who signs in can read the Search Console properties **their own** Google account has access to; nobody else can create an account. Removing an email blocks that user's next MCP request, even with an unexpired access token.
- Each MCP client must be approved on the consent page, which shows the client's name, the signed-in account and the host it will redirect to. Only approve clients you started yourself.
- Only the read-only Search Console scope is requested from Google. MCP access tokens are short-lived JWTs (1 hour) bound to the `/mcp` resource; refresh tokens rotate.
- Google access and refresh tokens are encrypted at rest with a key derived from `BETTER_AUTH_SECRET`. Keep that secret and `DATABASE_URL` private; rotating the secret means everyone signs in again.
- Tokens, secrets, cookies and `Authorization` headers are never logged or returned in tool results. Better Auth's own logger is set to `warn` and routed to Pino on stderr without its extra arguments.
- The `/sign-in` and `/consent` pages verify Better Auth's signature on the query before acting on it, escape every reflected value, and send a strict Content Security Policy, `X-Frame-Options: DENY` and `Cache-Control: no-store`.
- Revoke Google access at any time from <https://myaccount.google.com/permissions>; the server then reports an `[auth]` error until you reconnect.

## Known limitations

- Not yet verified end to end: a real deployment on Vercel and Neon, a real Google sign-in, real Search Console API calls, and a connection from Claude Code or another client (including fetching a real client metadata document). The rewrites rely on Vercel passing the original path in `request.url` to the function, as Vercel's documentation describes. After deploying, check discovery with `curl -i -X POST https://<your-domain>/mcp` (expect `401` and the `resource_metadata` URL), `curl https://<your-domain>/api/auth/oauth-protected-resource/mcp` and `curl https://<your-domain>/api/auth/.well-known/openid-configuration`.
- Whether Vercel serves the `/.well-known/*` rewrite is unverified (its documentation says that path is reserved); clients that ignore `resource_metadata` and only try the root well-known paths may fail discovery.
- `requireMcpAuth` downloads the JWKS from the deployment's own public URL. With Vercel Deployment Protection enabled (the default for preview deployments), that request and the OAuth flow are blocked; use the production deployment or turn protection off for previews.
- The JWKS is fetched over HTTPS from the deployment itself on a cold start, which adds latency to the first request.
- URL Inspection is limited by Google to 2,000 inspections per property per day; Search Analytics has load-based quotas. Quota errors are reported as `[quota]`.
- The Search Analytics API returns top rows only and does not guarantee every row.
- Vercel's handling of pnpm 12 (`devEngines`) and of the Node.js version declared in `devEngines` is unverified; set the Node.js version in the Vercel project settings if needed.

## Roadmap

- Optional write scope (`webmasters`) for sitemap submission.
- Restricting CIMD clients to known metadata hosts (Better Auth's `isMetadataDocumentUrlAllowed`).
- Opening the deployment to more users after Google's sensitive-scope verification.

## Licence

[MIT](LICENSE) © 2026 Tartiner Labs
