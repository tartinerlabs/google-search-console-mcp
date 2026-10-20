# Google Search Console MCP

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives MCP clients read-only access to Google Search Console data: properties, Search Analytics performance, URL Inspection and sitemaps.

The server runs as a stateless Streamable HTTP endpoint on Vercel. MCP clients connect with nothing but its URL, `https://<your-domain>/mcp`: on first use the client opens a browser, you sign in with Google and approve the client, and every tool call then runs as **your** Google account. Nothing needs to run on your machine.

> This project is not affiliated with, endorsed by or supported by Google. "Google" and "Search Console" are trademarks of Google LLC.

## Features

| Tool | What it does |
| --- | --- |
| `ping` | Checks that the server is running. |
| `list_sites` | Lists the properties the signed-in account can access, with its permission level. |
| `search_analytics` | Clicks, impressions, CTR and average position for a date range, optionally grouped by dimensions and filtered. |
| `compare_periods` | Compares a period with the previous period or the same dates a year earlier, by query, page, country, device or search appearance: total changes, biggest click gainers and losers, and new or lost rows. |
| `find_opportunities` | Queries or pages with the most upside, measured against the property's own CTR-by-position curve: striking-distance rows (positions 4–20 by default) ranked by extra clicks at a top-3 position, and first-page rows whose CTR is below the curve, ranked by missed clicks. |
| `inspect_url` | URL Inspection result for a page: index verdict, coverage, crawl, canonical, robots.txt, AMP, mobile usability and rich results. |
| `list_sitemaps` | Sitemaps submitted for a property, with dates, error/warning counts and submitted URL counts. |
| `submit_sitemap` | Only when `GSC_ENABLE_WRITE=true`: submits or resubmits a sitemap URL under the property. |

By default all tools are read-only and use the `https://www.googleapis.com/auth/webmasters.readonly` scope. Setting `GSC_ENABLE_WRITE=true` requests `https://www.googleapis.com/auth/webmasters` instead and registers `submit_sitemap`; the read tools keep working for users who signed in before the change, and `submit_sitemap` asks them to reconnect. Tool failures are returned as MCP tool results with `isError: true` and a category prefix: `[invalid_input]`, `[auth]`, `[permission]`, `[quota]`, `[not_found]`, `[unavailable]`, `[network]` or `[unexpected]`.

### `search_analytics` parameters

Values follow the [Search Analytics API reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

| Parameter | Values |
| --- | --- |
| `siteUrl` | Property exactly as returned by `list_sites`: `https://www.example.com/` (trailing slash) or `sc-domain:example.com` |
| `dateRange` | `last7Days`, `last28Days`, `last3Months`, `last6Months`, `last12Months`, `last16Months`. Ends on the latest day with final data (one extra small query finds it), like the Search Console UI. Use instead of `startDate`/`endDate`; the response echoes the resolved dates. |
| `startDate`, `endDate` | `YYYY-MM-DD`, Pacific Time, inclusive, `startDate` ≤ `endDate`. Use both, instead of `dateRange`. |
| `dimensions` | Any of `date`, `hour`, `query`, `page`, `country`, `device`, `searchAppearance` (each at most once) |
| `type` | `web` (default), `image`, `video`, `news`, `discover`, `googleNews` |
| `filters` | `{ dimension, operator, expression }` where `dimension` is `country`, `device`, `page`, `query` or `searchAppearance` and `operator` is `equals` (default), `notEquals`, `contains`, `notContains`, `includingRegex` or `excludingRegex` (RE2). All filters must match. |
| `aggregationType` | `auto` (default), `byPage`, `byProperty`, `byNewsShowcasePanel` |
| `dataState` | `final` (default), `all`, `hourly_all` (use with the `hour` dimension) |
| `rowLimit` | 1–25,000 (default 1,000) |
| `startRow` | 0 or more, for paging |

### `compare_periods` parameters

| Parameter | Values |
| --- | --- |
| `siteUrl`, `dateRange` or `startDate` + `endDate`, `type`, `filters` | As for `search_analytics`; the dates set the current period and the filters apply to both periods |
| `comparison` | `previousPeriod` (default, the same number of days just before) or `previousYear` (the same dates 12 months earlier) |
| `dimension` | `query` (default), `page`, `country`, `device` or `searchAppearance` |
| `limit` | Rows per list (`gainers`, `losers`, `new`, `lost`), 1–100 (default 25) |

Totals come from separate ungrouped queries, so they include anonymised queries that grouped rows leave out. Each period fetches at most 25,000 grouped rows; the response says when a list was truncated.

### `find_opportunities` parameters

| Parameter | Values |
| --- | --- |
| `siteUrl`, `dateRange` or `startDate` + `endDate`, `type`, `filters` | As for `search_analytics` |
| `dimension` | `query` (default) or `page` |
| `minPosition`, `maxPosition` | Striking-distance window, default 4–20 |
| `minImpressions` | Ignore rows with fewer impressions, default 50 |
| `limit` | Rows per list, 1–100 (default 25) |

The expected CTR at each rounded position is the impression-weighted CTR of all the property's rows at that position in the same period, so it reflects the niche and SERP features such as AI Overviews rather than a generic industry curve. The response includes this `ctrCurve` and the combined `top3Ctr` used for striking-distance potential.

## How it works

- [Better Auth](https://www.better-auth.com) 1.7 acts as the OAuth 2.1 authorisation server for MCP clients, using its [MCP plugin](https://www.better-auth.com/docs/plugins/mcp) (`@better-auth/mcp`), the JWT plugin and [Client ID Metadata Documents](https://www.better-auth.com/docs/plugins/cimd) (`@better-auth/cimd`). Dynamic client registration is **off**; clients identify themselves with a metadata document URL (CIMD).
- The only way to sign in is **Sign in with Google**. Google is asked for the `webmasters.readonly` scope with offline access, and Better Auth stores the Google tokens per user in Postgres, encrypted (`account.encryptOAuthTokens`), and refreshes them when they expire.
- `POST /mcp` without a valid access token gets `401` with an RFC 9728 `WWW-Authenticate: Bearer resource_metadata="https://<your-domain>/.well-known/oauth-protected-resource/mcp"` challenge, which is how clients discover the authorisation server. Access tokens are JWTs bound to the `https://<your-domain>/mcp` resource and verified against the server's JWKS.
- The MCP endpoint is stateless (the SDK's `createMcpHandler`): it serves MCP **2026-07-28** and, statelessly, 2025-era requests from clients on the earlier protocol.

All routes are served by one [Hono](https://hono.dev) app, `src/index.ts`:

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP endpoint |
| `/api/auth/*` | Better Auth: authorise, token, consent, JWKS, Google callback |
| `/.well-known/*` | OAuth discovery metadata (RFC 8414, RFC 9728) from Better Auth |
| `/sign-in` | Starts Google sign-in straight away (no UI) |
| `/consent` | Shows the client name, the account and the redirect host, with Allow / Deny |

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
   - Under *Data Access*, add the scope `https://www.googleapis.com/auth/webmasters.readonly` (plus the default `openid`, `email` and `profile`), or `https://www.googleapis.com/auth/webmasters` if you set `GSC_ENABLE_WRITE=true`.
4. Create the OAuth client: *Google Auth Platform → Clients → Create client*:
   - Application type: **Web application**.
   - Authorised redirect URI: `https://<your-domain>/api/auth/callback/google` (Better Auth's callback path for the Google provider).
   - Copy the client ID and client secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Publishing status: Google expires refresh tokens after **7 days** for External apps in **Testing** status, so you would have to reconnect weekly. Set the app to **In production** (*Audience → Publish app*). Until Google has verified the app you will see an "unverified app" warning when signing in, and `webmasters.readonly` is a sensitive scope: complete Google's verification before letting anyone else use your deployment.

Expired or revoked Google access is reported to the client as an `[auth]` tool error asking you to reconnect.

## Database (Neon)

1. In the Vercel dashboard, open your project → *Storage* → add **Neon** from the Marketplace and connect it to the project. This adds the connection strings to the project's environment variables. Use the **pooled** connection string as `DATABASE_URL`.
2. Create the tables with Drizzle Kit. The Drizzle schema in `apps/gsc/src/db/schema/auth.ts` is generated by the Better Auth CLI and covers every table this configuration needs (Better Auth core plus the JWT, OAuth provider/MCP and CIMD plugins). Table and column names are plural and snake_case (for example `oauth_clients.redirect_uris`) and every `id` is a native Postgres `uuid` generated by the database. The SQL migrations generated from the schema live in `apps/gsc/drizzle/` (Drizzle Kit's default folder). Apply them from your machine, preferably with Neon's direct (non-pooled) connection string:

   ```sh
   DATABASE_URL="<your Neon connection string>" pnpm -C apps/gsc db:migrate
   ```

   Drizzle Kit records applied migrations in the `drizzle.__drizzle_migrations` table, so re-running the command only applies new ones.

3. After upgrading Better Auth or changing plugins, regenerate the schema and a new migration, then apply it as above. Both are generated: do not edit `apps/gsc/src/db/schema/auth.ts` or anything in `apps/gsc/drizzle/` by hand. The Better Auth CLI loads `src/lib/auth.ts`, which needs `BETTER_AUTH_URL` to build the MCP resource URL (`generate` does not connect to the database). Run these from `apps/gsc`:

   ```sh
   BETTER_AUTH_URL="https://<your-domain>" pnpm dlx auth@1.7.10 generate --output src/db/schema/auth.ts
   pnpm db:generate
   ```

   Better Auth logs a "Drizzle schema mismatch" error when the Drizzle schema is missing tables or columns.

## Deploying to Vercel

Vercel runs the Hono app in `apps/gsc/src/index.ts` as a single function ([Hono on Vercel](https://vercel.com/docs/frameworks/backend/hono)); `apps/gsc/vercel.ts` sets the `hono` framework and the region. Every build runs `pnpm db:migrate` (the `vercel-build` script).

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string (Neon pooled URL). |
| `BETTER_AUTH_SECRET` | Yes | Secret for signing and encryption, at least 32 random bytes: `openssl rand -base64 32`. Changing it invalidates sessions and stored Google tokens. |
| `BETTER_AUTH_URL` | Yes | Public origin of the deployment, e.g. `https://gsc.example.com`. The MCP resource is `<BETTER_AUTH_URL>/mcp` and must be exactly the URL clients use. |
| `GOOGLE_CLIENT_ID` | Yes | Web application OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Yes | Web application OAuth client secret. |
| `MCP_ALLOWED_HOSTS` | No | Comma-separated extra hostnames accepted in the `Host` header of `/mcp`. The `BETTER_AUTH_URL` host and Vercel's `VERCEL_URL`, `VERCEL_BRANCH_URL` and `VERCEL_PROJECT_PRODUCTION_URL` are always accepted. |
| `MCP_ALLOWED_ORIGINS` | No | Comma-separated hostnames allowed in a browser `Origin` header on `/mcp` (requests without `Origin`, as sent by non-browser clients, pass). |
| `CIMD_ALLOWED_HOSTS` | No | Comma-separated hostnames allowed to host client metadata documents (the `client_id` URL). Unset allows any host; set it, for example to `claude.ai`, to accept only clients you know. |
| `GSC_ENABLE_WRITE` | No | `true` requests the `webmasters` write scope from Google and adds the `submit_sitemap` tool. Off by default. |
| `LOG_LEVEL` | No | Pino level (`info` by default). Logs go to stderr; tokens, secrets, cookies and `Authorization` headers are redacted. |

### Deploy

1. Create the Vercel project (Git integration via the dashboard, or `vercel link`) and set its *Root Directory* to `apps/gsc`.
2. Add Neon and create the tables (see [Database](#database-neon)).
3. Add the variables (each command prompts for the value, so secrets stay out of your shell history):

   ```sh
   vercel env add BETTER_AUTH_SECRET production
   vercel env add BETTER_AUTH_URL production
   vercel env add GOOGLE_CLIENT_ID production
   vercel env add GOOGLE_CLIENT_SECRET production
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
pnpm check        # typecheck + lint + test
pnpm format       # Biome formatter
pnpm -C apps/gsc test:watch   # Vitest in watch mode
```

The tests need no database, network or Google credentials. The OAuth tests run a real Better Auth instance on its in-memory adapter: they cover the discovery metadata, the 401 challenge, the allow-list at sign-up and on every MCP request, the `/sign-in` and `/consent` pages, a full authorisation-code + PKCE flow ending in an MCP tool call, and Google token retrieval and refresh (with Google's token endpoint mocked).

## Production build

```sh
pnpm build        # tsc emits apps/gsc/dist/
```

## Testing with the MCP Inspector

Not verified yet: start the web UI with `pnpm dlx @modelcontextprotocol/inspector`, choose the *Streamable HTTP* transport and enter `https://<your-domain>/mcp`. The Inspector must support the OAuth flow described above.

## Security considerations

- Anyone who can sign in with Google can use the server, and each user only reads the Search Console properties **their own** Google account has access to. While the Google OAuth app is in *Testing*, only its listed test users can sign in.
- Each MCP client must be approved on the consent page, which shows the client's name, the signed-in account and the host it will redirect to. Only approve clients you started yourself. Set `CIMD_ALLOWED_HOSTS` to refuse clients whose metadata document is hosted anywhere else.
- Only the read-only Search Console scope is requested from Google, unless you opt into `GSC_ENABLE_WRITE`; even then the only write tool is `submit_sitemap`. MCP access tokens are short-lived JWTs (1 hour) bound to the `/mcp` resource; refresh tokens rotate.
- Google access and refresh tokens are encrypted at rest with a key derived from `BETTER_AUTH_SECRET`. Keep that secret and `DATABASE_URL` private; rotating the secret means everyone signs in again.
- Tokens, secrets, cookies and `Authorization` headers are never logged or returned in tool results. Better Auth's own logger is set to `warn` and routed to Pino on stderr without its extra arguments.
- The `/sign-in` and `/consent` pages verify Better Auth's signature on the query before acting on it, escape every reflected value, and send a strict Content Security Policy, `X-Frame-Options: DENY` and `Cache-Control: no-store`.
- Revoke Google access at any time from <https://myaccount.google.com/permissions>; the server then reports an `[auth]` error until you reconnect.

## Known limitations

- Not yet verified end to end: a real deployment on Vercel and Neon, a real Google sign-in, real Search Console API calls, and a connection from Claude Code or another client (including fetching a real client metadata document). The rewrites rely on Vercel passing the original path in `request.url` to the function, as Vercel's documentation describes. After deploying, check discovery with `curl -i -X POST https://<your-domain>/mcp` (expect `401` and the `resource_metadata` URL), `curl https://<your-domain>/api/auth/oauth-protected-resource/mcp` and `curl https://<your-domain>/api/auth/.well-known/openid-configuration`.
- `requireMcpAuth` downloads the JWKS from the deployment's own public URL. With Vercel Deployment Protection enabled (the default for preview deployments), that request and the OAuth flow are blocked; use the production deployment or turn protection off for previews.
- The JWKS is fetched over HTTPS from the deployment itself on a cold start, which adds latency to the first request.
- URL Inspection is limited by Google to 2,000 inspections per property per day; Search Analytics has load-based quotas. Quota errors are reported as `[quota]`.
- The Search Analytics API returns top rows only and does not guarantee every row.
- Vercel's handling of pnpm 12 (`devEngines`) and of the Node.js version declared in `devEngines` is unverified; set the Node.js version in the Vercel project settings if needed.

## Roadmap

- Opening the deployment to more users after Google's sensitive-scope verification.

## Licence

[MIT](LICENSE) © 2026 Tartiner Labs
