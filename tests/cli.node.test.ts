import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ConfigStore } from "../cli/config.ts";
import { ApiClient } from "../cli/client.ts";
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "aichat-"));
  directories.push(dir);
  return new ConfigStore(dir);
}
test("credentials saved with private permissions and cursor isolated by base/session/room", async () => {
  const config = await store();
  await config.saveCredential(
    "https://apiwx.net/chat/v1",
    "s1",
    "secret",
    "session",
  );
  const path = config.file;
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await config.token("https://apiwx.net/chat/v1", "s1")).toBe("secret");
  await config.ack("https://apiwx.net/chat/v1", "s1", "room", 42);
  expect(await config.cursor("https://apiwx.net/chat/v1", "s1", "room")).toBe(
    42,
  );
  expect(await config.cursor("https://apiwx.net/chat/v1", "s2", "room")).toBe(
    0,
  );
  expect(
    await config.cursor("http://localhost:8787/chat/v1", "s1", "room"),
  ).toBe(0);
  await expect(
    config.ack("https://apiwx.net/chat/v1", "s1", "room", 1),
  ).rejects.toThrow("backwards");
});
test("parallel config updates preserve both sessions", async () => {
  const config = await store();
  await Promise.all([
    config.saveCredential("base", "a", "one", "session"),
    config.saveCredential("base", "b", "two", "session"),
  ]);
  expect(await config.token("base", "a")).toBe("one");
  expect(await config.token("base", "b")).toBe("two");
});
test("client retries an idempotent send with same message id and never reports token", async () => {
  const mock = vi
    .fn()
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValueOnce(Response.json({ id: "msg" }));
  vi.stubGlobal("fetch", mock);
  const client = new ApiClient(
    "https://apiwx.net/chat/v1",
    "secret",
    async () => {},
  );
  expect(
    await client.request(
      "/rooms/r/messages",
      "POST",
      { client_message_id: "stable", body: "hello" },
      true,
    ),
  ).toEqual({ id: "msg" });
  expect(mock.mock.calls[0][1].body).toBe(mock.mock.calls[1][1].body);
  mock.mockResolvedValue(
    Response.json({ error: { code: "unauthorized" } }, { status: 401 }),
  );
  await expect(client.request("/rooms")).rejects.toThrow("unauthorized");
});
test("client respects rate limit backoff and does not retry unsafe mutations", async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: "rate_limited" } },
        { status: 429, headers: { "Retry-After": "2" } },
      ),
    )
    .mockResolvedValueOnce(Response.json({ rooms: [] }));
  vi.stubGlobal("fetch", mock);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const client = new ApiClient("https://apiwx.net/chat/v1", "secret", sleep);
  await client.request("/rooms");
  expect(sleep).toHaveBeenCalledWith(2000);
  mock.mockReset().mockRejectedValue(new Error("lost"));
  await expect(client.request("/sessions", "POST", {})).rejects.toThrow(
    "Network request failed",
  );
  expect(mock).toHaveBeenCalledTimes(1);
});
test("remote plaintext URL is rejected before credentials leave machine", () => {
  expect(() => new ApiClient("http://example.com/chat/v1", "secret")).toThrow(
    "HTTPS",
  );
  expect(
    () => new ApiClient("http://localhost:8787/chat/v1", "secret"),
  ).not.toThrow();
});
test("retryable sends recover from interrupted response bodies using identical payload", async () => {
  const broken = new ReadableStream({
    start(controller) {
      controller.error(new Error("body connection interrupted"));
    },
  });
  const mock = vi
    .fn()
    .mockResolvedValueOnce(new Response(broken, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: "saved" }));
  vi.stubGlobal("fetch", mock);
  const client = new ApiClient(
    "https://apiwx.net/chat/v1",
    "secret",
    async () => {},
  );
  expect(
    await client.request(
      "/rooms/r/messages",
      "POST",
      { client_message_id: "same", body: "hello" },
      true,
    ),
  ).toEqual({ id: "saved" });
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls[0][1].body).toBe(mock.mock.calls[1][1].body);
});
