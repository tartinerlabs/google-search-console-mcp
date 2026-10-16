import { describe, expect, it } from "vitest";
import { createTestClient } from "./helpers.ts";

describe("MCP server", () => {
  it("should describe itself through server/discover", async () => {
    const { rpc } = createTestClient();
    const message = await rpc("server/discover");
    expect(message.result.supportedVersions).toEqual(["2026-07-28"]);
    expect(message.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "google-search-console",
      version: "0.1.0",
    });
    expect(message.result.capabilities.tools).toBeDefined();
  });

  it("should register the read-only ping tool", async () => {
    const { rpc } = createTestClient();
    const message = await rpc("tools/list");
    const tools: { name: string; annotations: { readOnlyHint: boolean } }[] =
      message.result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
    for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it("should answer ping", async () => {
    const { callTool } = createTestClient();
    expect(await callTool("ping")).toEqual({
      isError: false,
      text: "Google Search Console MCP is running.",
    });
  });
});
