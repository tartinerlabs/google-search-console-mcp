# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Commands

pnpm only (`pnpm-lock.yaml`, pnpm 12 and Node declared in `devEngines`). pnpm workspace with Turborepo (`turbo.json`): the Google Search Console server lives in `apps/gsc`, the PageSpeed Insights + Chrome UX Report server in `apps/pagespeed` (same structure, tools call Google with the server's `GOOGLE_API_KEY`), the IndexNow server in `apps/index-now` (no sign-in, database or Google API: `src/http.ts` serves the MCP SDK handler directly, and `submit_urls` checks the site's `<key>.txt` before submitting), provider-neutral auth/HTTP code shared by apps lives in `packages/core` (`@repo/core`, compiled to `dist/` because Vercel does not compile workspace TypeScript; types resolve to `src/`), and Biome and semantic-release run from the root. Each app's `biome.json` and `turbo.json` extend the root ones (`"extends": "//"` / `["//"]`); declare an app's env vars in its own `turbo.json` (Turborepo runs in strict env mode). Paths and app commands below are relative to `apps/gsc` unless noted.

```sh
pnpm check                          # root: biome lint + turbo typecheck/test — what CI runs, plus `pnpm build`
pnpm test                           # root: turbo run test
pnpm format                         # root: biome format --write
pnpm build                          # root: turbo run build → apps/*/dist/
pnpm vitest run tests/tools.test.ts # single file
pnpm vitest run -t "search_analytics"  # single describe/test by name
pnpm db:push                        # sync schema to the Neon development branch
pnpm db:migrate                     # apply committed migrations (also runs as `vercel-build`)
```

Tests need no database, network or Google credentials: they drive `createServer` with a mocked `GscClient` (`tests/helpers.ts` → `mockClient`, `mcpRequest`, `createTestClient`) and never import `src/lib/auth.ts`.

## Architecture

A stateless Streamable HTTP MCP server for read-only Google Search Console access, deployed to Vercel as a single Hono function (`vercel.ts`: region `sin1`). TypeScript runs as native ESM with `.ts` import extensions (`rewriteRelativeImportExtensions`, `erasableSyntaxOnly` — no enums/namespaces/parameter properties).

Request flow:

1. `src/index.ts` — Hono app routing `/api/auth/*` and `/.well-known/*` to Better Auth, `POST /mcp` to `handleMcp`, and `/sign-in` + `/consent` to `src/pages.ts`.
2. `src/http.ts` — `createMcpEndpoint` from `packages/core/src/http.ts`: Host/Origin validation (`MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, Vercel system URLs), then `requireMcpAuth` from `@better-auth/mcp` verifies the JWT access token and maps claims to `AuthInfo` with `extra.userId = sub`, then `createMcpHandler` builds a fresh `McpServer` per request.
3. `src/server.ts` — `createServer(getClient)` registers `ping` plus one tool per file in `src/tools/`. Each `register*Tool(server, getClient)` takes a lazy `GscClientProvider` so credentials are resolved inside the tool call and auth failures surface as tool errors, not HTTP errors.
4. `src/google/client.ts` — `getUserGscClient(userId)` loads the user's Google account via Better Auth's internal adapter, checks the `webmasters.readonly` scope was actually granted, gets/refreshes the Google access token via `auth.api.getAccessToken`, and wraps `@googleapis/searchconsole` behind the narrow `GscClient` interface (the seam tests mock).

Auth (`src/lib/auth.ts` calls `createAuth` from `packages/core/src/auth.ts` with the app's scopes): Better Auth is the OAuth 2.1 authorisation server for MCP clients — Google as the only social provider (offline access, encrypted tokens), JWT plugin, `mcp` plugin (resource = `${BETTER_AUTH_URL}/mcp`), and CIMD (client ID metadata documents; dynamic client registration is off). `/sign-in` and `/consent` (`createPages` in `packages/core/src/pages.ts`) verify Better Auth's signed query and render minimal HTML with strict CSP.

Tool conventions (follow when adding a tool):
- Zod 4 input schemas (`import * as z from "zod"`); shared ones such as `siteUrlSchema` live in `src/schemas/common.ts`.
- Annotate `readOnlyHint: true`; `tests/server.test.ts` asserts the exact tool list and that every tool is read-only. The one exception is `submit_sitemap`, registered only with `createServer(getClient, { allowWrite: true })` (`GSC_ENABLE_WRITE=true`, which also swaps the Google scope to `webmasters`).
- Return JSON as a text content block; wrap the body in `try/catch` and return `toToolError(toolName, error)`. `src/utils/errors.ts` classifies Google/Gaxios/network errors into `[invalid_input|auth|permission|quota|not_found|unavailable|network|unexpected]` messages. Throw `CredentialsError` for sign-in problems.
- Log only through `src/utils/logger.ts` (`createLogger` from `packages/core`: Pino with redaction of tokens/secrets/headers); never log tokens or put them in tool results.

## Database

Drizzle ORM 1.0 RC on Neon Postgres (`src/db/index.ts`, node-postgres, relations v2). `drizzle.config.ts` uses `DATABASE_URL_UNPOOLED` and `schemaFilter: ["public"]` (Neon Auth owns `neon_auth`).

- `src/db/schema/auth.ts` is generated by the Better Auth CLI (`pnpm auth:generate`, needs `BETTER_AUTH_URL`) and `drizzle/` is generated by Drizzle Kit. Never hand-edit either; both are excluded from Biome.
- Neon `development` branch: iterate with `pnpm db:push`. `production` branch: schema changes only via committed migrations. Do not run `pnpm db:generate` unless explicitly asked.

## Environment

Required: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (must exactly match the URL clients use for `/mcp`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Optional: `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `CIMD_ALLOWED_HOSTS` (hostnames allowed to host client metadata documents; unset allows any), `GSC_ENABLE_WRITE` (`apps/gsc` only), `LOG_LEVEL`. `apps/pagespeed` also requires `GOOGLE_API_KEY` (PageSpeed Insights API and Chrome UX Report API enabled), sent as the `x-goog-api-key` header. See README for Google Cloud and Vercel setup. Vercel Deployment Protection blocks the self-hosted JWKS fetch and OAuth flow on preview deployments.
