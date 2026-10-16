import { afterEach, describe, expect, it, vi } from "vitest";
import type { GscClient } from "../src/google/client.ts";
import { createHttpHandler } from "../src/http.ts";
import {
  createTestAuth,
  issueAccessToken,
  routeFetchTo,
  signIn,
} from "./auth-setup.ts";
import { mcpRequest, mockClient, readMessage } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ping = { name: "ping", arguments: {} };

async function setup(envOverrides = {}) {
  const { auth, env, origin } = await createTestAuth(envOverrides);
  const clientForUser = vi.fn(
    async (_userId: string): Promise<GscClient> =>
      mockClient({
        listSites: async () => ({
          siteEntry: [
            { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          ],
        }),
      })(),
  );
  const fetch = createHttpHandler(auth, env, clientForUser);
  routeFetchTo(auth, origin);
  const request = (
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    mcpRequest(
      method,
      params,
      { host: new URL(origin).host, ...headers },
      `${origin}/mcp`,
    );
  return { auth, env, origin, fetch, clientForUser, request };
}

describe("unauthenticated MCP requests", () => {
  it("should get a 401 with an RFC 9728 resource_metadata challenge", async () => {
    const { fetch, request, origin } = await setup();
    const response = await fetch(request("tools/call", ping));
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      `resource_metadata="${origin}/api/auth/oauth-protected-resource/mcp"`,
    );
    expect((await response.json()).error.code).toBe(-32000);
  });

  it("should reject a token that was not issued by this server", async () => {
    const { fetch, request } = await setup();
    const forged =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlLWlzLW5vdC12YWxpZA";
    const response = await fetch(
      request("tools/call", ping, { authorization: `Bearer ${forged}` }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });
});

describe("authenticated MCP requests", () => {
  it("should serve tools as the signed-in user", async () => {
    const { auth, origin, fetch, request, clientForUser } = await setup();
    const { user, cookie } = await signIn(auth, "owner@example.com");
    const token = await issueAccessToken(auth, origin, cookie);
    const authorization = `Bearer ${token}`;

    const list = await fetch(request("tools/list", {}, { authorization }));
    expect(list.status).toBe(200);
    expect((await readMessage(list)).result.tools).toHaveLength(5);

    const pong = await fetch(request("tools/call", ping, { authorization }));
    expect((await readMessage(pong)).result.content[0].text).toBe(
      "Google Search Console MCP is running.",
    );
    expect(clientForUser).not.toHaveBeenCalled();

    const sites = await fetch(
      request(
        "tools/call",
        { name: "list_sites", arguments: {} },
        { authorization },
      ),
    );
    const message = await readMessage(sites);
    expect(message.result.isError).toBeUndefined();
    expect(JSON.parse(message.result.content[0].text).sites).toHaveLength(1);
    expect(clientForUser).toHaveBeenCalledWith(user.id);
  });

  it("should re-check the allow-list on every request", async () => {
    const { auth, env, origin, fetch, request } = await setup();
    const { cookie } = await signIn(auth, "owner@example.com");
    const token = await issueAccessToken(auth, origin, cookie);

    env.ALLOWED_EMAILS = "someone-else@example.com";
    const response = await fetch(
      request("tools/call", ping, { authorization: `Bearer ${token}` }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toContain("not allowed");
  });

  it("should serve 2025-era (legacy) requests statelessly as the signed-in user", async () => {
    const { auth, origin, fetch, clientForUser } = await setup();
    const { user, cookie } = await signIn(auth, "owner@example.com");
    const token = await issueAccessToken(auth, origin, cookie);
    const legacy = (method: string, params: Record<string, unknown>) =>
      fetch(
        new Request(`${origin}/mcp`, {
          method: "POST",
          headers: {
            host: new URL(origin).host,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );

    const init = await legacy("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.status).toBe(200);
    expect((await readMessage(init)).result.protocolVersion).toBe("2025-06-18");

    const sites = await legacy("tools/call", {
      name: "list_sites",
      arguments: {},
    });
    expect(sites.status).toBe(200);
    const message = await readMessage(sites);
    expect(JSON.parse(message.result.content[0].text).sites).toHaveLength(1);
    expect(clientForUser).toHaveBeenCalledWith(user.id);
  });

  it("should still require a token for 2025-era requests", async () => {
    const { origin, fetch } = await setup();
    const response = await fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          host: new URL(origin).host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("Host and Origin validation", () => {
  it("should accept the BETTER_AUTH_URL host without MCP_ALLOWED_HOSTS", async () => {
    const { fetch, request } = await setup({
      VERCEL_PROJECT_PRODUCTION_URL: "gsc.vercel.app",
    });
    // Reaches the auth gate (401), so the Host check passed.
    expect((await fetch(request("tools/call", ping))).status).toBe(401);
  });

  it("should reject a Host outside the allow-list before authentication", async () => {
    const { fetch, request } = await setup({
      VERCEL_PROJECT_PRODUCTION_URL: "gsc.example.com",
    });
    const response = await fetch(
      request("tools/call", ping, { host: "evil.example.net" }),
    );
    expect(response.status).toBe(403);
  });

  it("should reject a browser Origin that is not allow-listed", async () => {
    const { fetch, request } = await setup();
    const response = await fetch(
      request("tools/call", ping, { origin: "https://evil.example.net" }),
    );
    expect(response.status).toBe(403);
  });

  it("should let an allow-listed Origin reach the auth gate", async () => {
    const { fetch, request } = await setup({
      MCP_ALLOWED_ORIGINS: "app.example.com",
    });
    const response = await fetch(
      request("tools/call", ping, { origin: "https://app.example.com" }),
    );
    expect(response.status).toBe(401);
  });
});
