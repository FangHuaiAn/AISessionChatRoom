import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../cli/commands.ts";
import { ConfigStore } from "../cli/config.ts";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "aichat-cmd-"));
  dirs.push(dir);
  return { dir, config: new ConfigStore(dir), out: [] as unknown[] };
}
test("send chooses explicit session, includes stable key, and keeps token out of output", async () => {
  const { dir, config, out } = await setup();
  await config.saveCredential(
    "https://apiwx.net/chat/v1",
    "s1",
    "private",
    "session",
  );
  const mock = vi.fn().mockResolvedValue(Response.json({ id: "m1" }));
  vi.stubGlobal("fetch", mock);
  await runCli(
    [
      "send",
      "--session",
      "s1",
      "--room",
      "r1",
      "--message",
      "hello",
      "--request-id",
      "stable",
      "--config-dir",
      dir,
    ],
    {},
    (value) => out.push(value),
  );
  expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({
    body: "hello",
    client_message_id: "stable",
  });
  expect(mock.mock.calls[0][1].headers.Authorization).toBe("Bearer private");
  expect(JSON.stringify(out)).not.toContain("private");
});
test("read leaves cursor unchanged until explicit ack", async () => {
  const { dir, config, out } = await setup();
  const args = ["--config-dir", dir, "--session", "s1", "--room", "r1"];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        messages: [{ seq: 4 }],
        next_cursor: 4,
        has_more: false,
      }),
    ),
  );
  await runCli(["read", ...args], { AICHAT_TOKEN: "token" }, (value) =>
    out.push(value),
  );
  expect(await config.cursor("https://apiwx.net/chat/v1", "s1", "r1")).toBe(0);
  await runCli(["ack", ...args, "--cursor", "4"], {}, (value) =>
    out.push(value),
  );
  expect(await config.cursor("https://apiwx.net/chat/v1", "s1", "r1")).toBe(4);
});
test("session creation saves secret without printing and can export isolated config", async () => {
  const { dir, config, out } = await setup();
  const isolated = join(dir, "agent");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ id: "s1", token: "session-secret", expiresAt: 42 }),
      ),
  );
  await runCli(
    [
      "session",
      "create",
      "--name",
      "tester",
      "--room",
      "r1",
      "--export-dir",
      isolated,
      "--config-dir",
      dir,
    ],
    { AICHAT_TOKEN: "admin" },
    (value) => out.push(value),
  );
  expect(await config.token("https://apiwx.net/chat/v1", "s1")).toBe(
    "session-secret",
  );
  expect(JSON.stringify(out)).not.toContain("session-secret");
  const exported = new ConfigStore(isolated);
  expect(await exported.token("https://apiwx.net/chat/v1", "s1")).toBe(
    "session-secret",
  );
  await expect(exported.token("https://apiwx.net/chat/v1")).rejects.toThrow(
    "missing",
  );
});
test("export refuses an existing configuration before creating a session", async () => {
  const { dir } = await setup();
  const isolated = join(dir, "existing");
  const config = new ConfigStore(isolated);
  await config.saveCredential(
    "https://apiwx.net/chat/v1",
    "manager",
    "management-secret",
    "management",
  );
  const mock = vi
    .fn()
    .mockResolvedValue(
      Response.json({ id: "s1", token: "session-secret", expiresAt: 42 }),
    );
  vi.stubGlobal("fetch", mock);
  await expect(
    runCli(
      [
        "session",
        "create",
        "--name",
        "tester",
        "--room",
        "r1",
        "--export-dir",
        isolated,
        "--config-dir",
        dir,
      ],
      { AICHAT_TOKEN: "admin" },
      () => {},
    ),
  ).rejects.toThrow("new directory");
  expect(mock).not.toHaveBeenCalled();
  expect(await config.token("https://apiwx.net/chat/v1")).toBe(
    "management-secret",
  );
});

test("room index repair follows every cursor and sends no caller supplied membership", async () => {
  const { dir, out } = await setup();
  const mock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        indexed: 100,
        next_cursor: "member-099",
        has_more: true,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ indexed: 6, next_cursor: "member-105", has_more: false }),
    );
  vi.stubGlobal("fetch", mock);
  await runCli(
    ["room", "repair-index", "--room", "r1", "--config-dir", dir],
    { AICHAT_TOKEN: "owner-token" },
    (value) => out.push(value),
  );
  expect(mock.mock.calls).toHaveLength(2);
  expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({ after: "" });
  expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual({
    after: "member-099",
  });
  expect(out).toEqual([{ ok: true, room_id: "r1", indexed: 106 }]);
});
