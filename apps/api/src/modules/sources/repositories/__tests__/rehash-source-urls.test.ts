import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "@/db/connection";
import { insertSource, rehashSourceUrls } from "@/modules/sources/repositories/source.repository";
import { hashUrl } from "@/modules/sources/utils/url-hash";

const organizationId = "org-rehash";
const url = "https://mcp.example.com/mcp?token=secret";
const urlHashOf = (name: string) =>
  db
    .query<{ urlHash: string | null }, [string, string]>(
      "SELECT url_hash AS urlHash FROM sources WHERE organization_id = ? AND name = ?",
    )
    .get(organizationId, name)?.urlHash;

test("url hashes are keyed by the server secret", () => {
  expect(hashUrl(url)).not.toBe(createHash("sha256").update(url.toLowerCase()).digest("hex"));
  expect(hashUrl("HTTPS://mcp.example.com/mcp/ ")).toBe(hashUrl("https://mcp.example.com/mcp"));
});

test("rehashSourceUrls rewrites hashes stored with the old function once", () => {
  expect(insertSource(organizationId, { name: "legacy", config: { kind: "mcp", url, headers: {} } }).error).toBeNull();
  const legacy = createHash("sha256").update(url.toLowerCase()).digest("hex");
  db.query("UPDATE sources SET url_hash = ? WHERE organization_id = ? AND name = ?").run(
    legacy,
    organizationId,
    "legacy",
  );
  expect(rehashSourceUrls().data).toBeGreaterThanOrEqual(1);
  expect(urlHashOf("legacy")).toBe(hashUrl(url));
  expect(rehashSourceUrls().data).toBe(0);
});
