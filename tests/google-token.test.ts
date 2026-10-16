import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGoogleAccessToken,
  getUserGscClient,
} from "../src/auth/google-token.ts";
import { createHttpHandler } from "../src/http.ts";
import { CredentialsError } from "../src/utils/errors.ts";
import {
  createTestAuth,
  issueAccessToken,
  linkGoogle,
  routeFetchTo,
  signIn,
} from "./auth-setup.ts";
import { mcpRequest, readMessage } from "./helpers.ts";

// googleapis does its own HTTP (not globalThis.fetch), so the API module is mocked here.
const { searchconsole } = vi.hoisted(() => ({ searchconsole: vi.fn() }));
vi.mock("@googleapis/searchconsole", () => ({ searchconsole }));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signedInUser() {
  const setup = await createTestAuth();
  const { user, cookie } = await signIn(setup.auth, "owner@example.com");
  return { ...setup, user, cookie };
}

describe("getGoogleAccessToken", () => {
  it("should return the stored token while it is valid, without calling Google", async () => {
    const { auth, user } = await signedInUser();
    await linkGoogle(auth, user.id, { accessToken: "ya29.stored" });
    const google = vi.fn();
    vi.stubGlobal("fetch", google);
    await expect(getGoogleAccessToken(auth, user.id)).resolves.toBe(
      "ya29.stored",
    );
    expect(google).not.toHaveBeenCalled();
  });

  it("should ask the user to sign in again when no Google account is linked", async () => {
    const { auth, user } = await signedInUser();
    await expect(getGoogleAccessToken(auth, user.id)).rejects.toThrow(
      CredentialsError,
    );
  });

  it("should explain a Search Console permission left unticked on Google's consent screen", async () => {
    const { auth, user } = await signedInUser();
    await linkGoogle(auth, user.id, {
      scope: "openid,https://www.googleapis.com/auth/userinfo.email",
    });
    await expect(getGoogleAccessToken(auth, user.id)).rejects.toThrow(
      "did not grant access to Search Console",
    );
  });

  it("should refresh an expired token through Google's token endpoint", async () => {
    const { auth, user, store } = await signedInUser();
    await linkGoogle(auth, user.id, {
      accessToken: "ya29.expired",
      refreshToken: "1//refresh",
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const google = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://oauth2.googleapis.com/token");
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("1//refresh");
        return Response.json({
          access_token: "ya29.fresh",
          expires_in: 3599,
          token_type: "Bearer",
        });
      },
    );
    vi.stubGlobal("fetch", google);

    await expect(getGoogleAccessToken(auth, user.id)).resolves.toBe(
      "ya29.fresh",
    );
    expect(google).toHaveBeenCalledOnce();
    // Stored encrypted (encryptOAuthTokens), never as plain text.
    expect(JSON.stringify(store.account)).not.toContain("ya29.fresh");
  });

  it("should turn a revoked refresh token into a sign-in-again error", async () => {
    const { auth, user } = await signedInUser();
    await linkGoogle(auth, user.id, {
      refreshToken: "1//revoked",
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        },
        { status: 400 },
      ),
    );
    const error = await getGoogleAccessToken(auth, user.id).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CredentialsError);
    expect(String(error)).toContain("expired or been revoked");
  });
});

describe("per-user Search Console client", () => {
  it("should build the Search Console client with the user's Google token", async () => {
    const { auth, user } = await signedInUser();
    await linkGoogle(auth, user.id, { accessToken: "ya29.user-token" });
    const listSites = vi.fn(async () => ({
      data: { siteEntry: [{ siteUrl: "sc-domain:a.com" }] },
    }));
    searchconsole.mockReturnValue({ sites: { list: listSites } });

    const client = await getUserGscClient(auth, user.id);
    await expect(client.listSites()).resolves.toEqual({
      siteEntry: [{ siteUrl: "sc-domain:a.com" }],
    });
    const options = searchconsole.mock.calls[0]?.[0];
    expect(options?.version).toBe("v1");
    expect(options?.auth).toBeInstanceOf(OAuth2Client);
    expect(options?.auth.credentials.access_token).toBe("ya29.user-token");
  });

  it("should report a missing Search Console grant as an [auth] tool error over HTTP", async () => {
    const { auth, env, origin, user, cookie } = await signedInUser();
    await linkGoogle(auth, user.id, { scope: "openid" });
    const token = await issueAccessToken(auth, origin, cookie);
    routeFetchTo(auth, origin);

    const response = await createHttpHandler(
      auth,
      env,
    )(
      mcpRequest(
        "tools/call",
        { name: "list_sites", arguments: {} },
        { authorization: `Bearer ${token}`, host: new URL(origin).host },
        `${origin}/mcp`,
      ),
    );
    const message = await readMessage(response);
    expect(message.result.isError).toBe(true);
    expect(message.result.content[0].text).toMatch(
      /^\[auth\] .*Search Console/,
    );
    expect(message.result.content[0].text).toContain("Reconnect");
  });
});
