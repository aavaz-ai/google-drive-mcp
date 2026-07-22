import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("fresh MCP subprocess authorization", () => {
  it("re-evaluates picked and unpicked IDs with a refreshed bearer and no persisted catalog", async () => {
    const fixture = join(process.cwd(), "tests", "managed", "fixtures", "fresh-process-server.mjs");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, GOOGLE_DRIVE_OAUTH_BEARER: "REFRESHED_MOCK_BEARER" },
      stderr: "pipe",
    });
    const client = new Client({ name: "fresh-process-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const selected = await client.callTool({
        name: "read_text_file",
        arguments: { item_id: "picked_after_refresh", offset: 0, limit: 100 },
      });
      const unpicked = await client.callTool({
        name: "get_item_metadata",
        arguments: { item_id: "unpicked_after_refresh" },
      });

      expect(selected.isError).not.toBe(true);
      expect(selected.structuredContent).toMatchObject({ status: "ok", text: "fresh process content" });
      expect(unpicked.isError).toBe(true);
      expect(unpicked.structuredContent).toMatchObject({
        status: "error",
        error: { code: "DRIVE_ITEM_NOT_AUTHORIZED", outcome: "not_completed", retryable: false },
      });
      const unpickedContent = unpicked.content as Array<{ type: "text"; text: string }>;
      expect(unpickedContent[0]?.text).toContain("DRIVE_ITEM_NOT_AUTHORIZED");
      expect(JSON.stringify([selected, unpicked])).not.toContain("REFRESHED_MOCK_BEARER");
      expect(JSON.stringify(unpicked)).not.toContain("must-not-surface");
    } finally {
      await client.close();
    }
  });
});
