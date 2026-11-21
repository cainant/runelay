import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { VersionView } from "@runelay/shared";
import { db } from "@/db/connection";
import { GATEWAY_INFO } from "@/modules/gateway/constants/gateway.constants";
import { isNewerVersion, resetLatestCache } from "@/modules/system/services/version.service";
import { body, call, createApiKey, resetDatabase, signUp, type TestAccount } from "../../../../test/helpers";
import { withEnv } from "../../../../test/sources-helpers";

let owner: TestAccount;
let member: TestAccount;
const restores: (() => void)[] = [];

const mockFetch = (handler: (url: string, init?: RequestInit) => Promise<Response>) => {
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign((input: string | URL | Request, init?: RequestInit) => handler(String(input), init), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );
  restores.push(() => spy.mockRestore());
  return spy;
};

const release = (tag: string, extra: Record<string, unknown> = {}) =>
  mockFetch(async () => Response.json({ tag_name: tag, ...extra }));

const withUpdater = () => {
  restores.push(withEnv("RUNELAY_UPDATER_URL", "http://updater:8080/"));
  restores.push(withEnv("RUNELAY_UPDATER_TOKEN", "updater-token-0123456789"));
};

beforeAll(async () => {
  resetDatabase();
  owner = await signUp("System Owner");
  member = await signUp("System Member");
  db.query("UPDATE member SET role = 'member' WHERE userId = ?").run(member.userId);
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  resetLatestCache();
});

describe("version", () => {
  test("reports a newer release and caches the lookup", async () => {
    withUpdater();
    const spy = release("v99.0.0", {
      body: "  - New things\n",
      html_url: "https://github.com/runelay/runelay/releases/tag/v99.0.0",
    });
    const first = await body<VersionView>(await call("/v1/system/version", { cookie: owner.cookie }));
    await call("/v1/system/version", { cookie: owner.cookie });
    expect(first.data).toEqual({
      current: GATEWAY_INFO.version,
      latest: "99.0.0",
      notes: "- New things",
      releaseUrl: "https://github.com/runelay/runelay/releases/tag/v99.0.0",
      updateAvailable: true,
      canUpdate: true,
      desktop: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("hides the update action from members and servers without an updater", async () => {
    release(GATEWAY_INFO.version);
    const asOwner = await body<VersionView>(await call("/v1/system/version", { cookie: owner.cookie }));
    withUpdater();
    const asMember = await body<VersionView>(await call("/v1/system/version", { cookie: member.cookie }));
    expect(asOwner.data.updateAvailable).toBe(false);
    expect([asOwner.data.notes, asOwner.data.releaseUrl]).toEqual([null, null]);
    expect(asOwner.data.canUpdate).toBe(false);
    expect(asMember.data.canUpdate).toBe(false);
  });

  test("falls back to null when GitHub fails or has no tag", async () => {
    mockFetch(async () => new Response("down", { status: 503 }));
    const failed = await body<VersionView>(await call("/v1/system/version", { cookie: owner.cookie }));
    resetLatestCache();
    for (const restore of restores.splice(0).reverse()) restore();
    mockFetch(async () => Response.json({}));
    const untagged = await body<VersionView>(await call("/v1/system/version", { cookie: owner.cookie }));
    resetLatestCache();
    for (const restore of restores.splice(0).reverse()) restore();
    mockFetch(() => Promise.reject(new Error("offline")));
    const offline = await body<VersionView>(await call("/v1/system/version", { cookie: owner.cookie }));
    expect([failed.data.latest, untagged.data.latest, offline.data.latest]).toEqual([null, null, null]);
    expect(offline.data.updateAvailable).toBe(false);
  });

  test("tells the desktop app apart", async () => {
    restores.push(withEnv("RUNELAY_DESKTOP", true));
    release("v99.0.0");
    const { data } = await body<VersionView>(await call("/v1/system/version", { cookie: owner.cookie }));
    expect(data.desktop).toBe(true);
  });

  test("rejects API keys", async () => {
    const key = await createApiKey(owner);
    const response = await call("/v1/system/version", { bearer: key.key });
    expect(response.status).toBe(401);
  });
});

describe("update", () => {
  test("asks the updater to pull the new image", async () => {
    withUpdater();
    const spy = mockFetch(() => Promise.reject(new Error("container restarting")));
    const response = await call("/v1/system/update", { method: "POST", cookie: owner.cookie });
    expect(response.status).toBe(202);
    expect(spy).toHaveBeenCalledWith("http://updater:8080/v1/update", {
      method: "POST",
      headers: { authorization: "Bearer updater-token-0123456789" },
    });
  });

  test("refuses members and servers without an updater", async () => {
    const unconfigured = await call("/v1/system/update", { method: "POST", cookie: owner.cookie });
    withUpdater();
    const asMember = await call("/v1/system/update", { method: "POST", cookie: member.cookie });
    expect(unconfigured.status).toBe(409);
    expect(asMember.status).toBe(403);
  });
});

test("compares versions numerically", () => {
  expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
  expect(isNewerVersion("0.2", "0.1.9")).toBe(true);
  expect(isNewerVersion("0.1.2", "0.1.2")).toBe(false);
  expect(isNewerVersion("0.1.1", "0.1.2")).toBe(false);
});
