import { mkdtemp, rm, readFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { backup, restore, type Rpc } from "../scripts/recovery.ts";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function folder() {
  const root = await mkdtemp(join(tmpdir(), "aichat-archive-"));
  dirs.push(root);
  return join(root, "backup");
}
const header = {
  version: 1,
  snapshot_id: "snapshot",
  captured_at: 1,
  room: { id: "room", name: "private", owner_id: "owner", created_at: 1 },
  last_seq: 102,
  message_count: 102,
};
const messages = Array.from({ length: 102 }, (_, i) => ({
  id: "m" + (i + 1),
  seq: i + 1,
  room_id: "room",
  body: "private body " + i,
  session_id: "session",
  user_id: "owner",
  client_message_id: String(i),
  created_at: 1,
  reply_to: null,
}));
const source: Rpc = async (method, args) => {
  if (method === "registryHeader") return { last_seq: 2 };
  if (method === "registeredRooms")
    return {
      rooms: [
        { seq: 1, room_id: "room" },
        { seq: 2, room_id: "pending" },
      ],
      next_cursor: 2,
      has_more: false,
    };
  if (method === "roomHeader") {
    if (args[0] === "pending") throw new Error("not_found");
    return header;
  }
  if (method === "roomPage") {
    const after = args[1] as number;
    const page = messages.filter((m) => m.seq > after).slice(0, 100);
    return {
      messages: page,
      next_cursor: page.at(-1)?.seq ?? after,
      has_more: after + page.length < messages.length,
    };
  }
  throw new Error("unexpected operation");
};
test("archive preserves multiple pages, restrictive permissions, pending registry entries, and resumes restoration", async () => {
  const dir = await folder();
  expect(await backup(source, dir)).toEqual({ rooms: 1, uninitialized: 1 });
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  expect(manifest.uninitialized).toEqual(["pending"]);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, manifest.rooms[0].file))).mode & 0o777).toBe(
    0o600,
  );
  const target = vi.fn<Rpc>().mockImplementation(async (method, args) => {
    if (method === "restoreBegin") return { next_cursor: 100, complete: false };
    if (method === "restorePage") {
      expect(args[2]).toBe(100);
      expect(args[3]).toEqual(messages.slice(100));
      return { next_cursor: 102 };
    }
    if (method === "restoreFinish") return header.room;
  });
  expect(await restore(target, dir)).toEqual({ rooms: 1 });
  expect(target).toHaveBeenCalledTimes(3);
  await expect(backup(source, dir)).rejects.toThrow();
});
test("corrupt archive fails before any target writes", async () => {
  const dir = await folder();
  await backup(source, dir);
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  await appendFile(join(dir, manifest.rooms[0].file), "corrupt");
  const target = vi.fn<Rpc>();
  await expect(restore(target, dir)).rejects.toThrow("checksum");
  expect(target).not.toHaveBeenCalled();
});

test.each(["header", "duplicate", "dedup", "reply", "body"])(
  "invalid %s with a matching checksum is rejected before any target write",
  async (kind) => {
    const dir = await folder();
    await backup(source, dir);
    const manifest = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    );
    const path = join(dir, manifest.rooms[0].file),
      rows = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    if (kind === "header") delete rows[0].value.captured_at;
    if (kind === "duplicate") rows[2].value.id = rows[1].value.id;
    if (kind === "dedup")
      rows[2].value.client_message_id = rows[1].value.client_message_id;
    if (kind === "body") rows[2].value.body = 42;
    if (kind === "reply") rows[2].value.reply_to = "missing-parent";
    const content = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const { writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    await writeFile(path, content);
    manifest.rooms[0].sha256 = createHash("sha256")
      .update(content)
      .digest("hex");
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    const target = vi
      .fn<Rpc>()
      .mockResolvedValue({ next_cursor: 0, complete: false });
    await expect(restore(target, dir)).rejects.toThrow();
    expect(target).not.toHaveBeenCalled();
  },
);
