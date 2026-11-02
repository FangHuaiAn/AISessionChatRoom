import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { Principal } from "../src/contracts";
function owner(): Principal {
  return {
    id: crypto.randomUUID(),
    userId: "github:owner",
    kind: "management",
    rooms: [],
    name: "owner",
    expiresAt: Date.now() + 60000,
  };
}
async function source() {
  const id = crypto.randomUUID(),
    room = env.ROOMS.getByName(id),
    principal = owner();
  await room.initialize(id, "Recovery test", principal.userId);
  return { room, id, principal };
}
test("backup cutoff stays stable and restore preserves messages, replies and dedup keys", async () => {
  const { room, id, principal } = await source();
  const first = await room.send(principal, {
    body: "first",
    client_message_id: "first",
  });
  await room.send(principal, {
    body: "reply",
    client_message_id: "second",
    reply_to: first.id,
  });
  const header = await room.backupHeader();
  await room.send(principal, {
    body: "after backup",
    client_message_id: "third",
  });
  const page = await room.backupPage(0, header.last_seq);
  expect(page.messages).toHaveLength(2);
  expect(header.message_count).toBe(2);
  const target = env.ROOMS.getByName("restored-" + id);
  await target.restoreBegin(header);
  await expect(Promise.resolve(target.describe(principal))).rejects.toThrow(
    "not_found",
  );
  await target.restorePage(header.snapshot_id, 0, page.messages);
  await target.restorePage(header.snapshot_id, 0, page.messages); // idempotent retry
  await target.restoreFinish(header.snapshot_id);
  await target.restoreFinish(header.snapshot_id);
  expect(await target.read(principal, 0, 100)).toMatchObject({
    messages: page.messages,
  });
  await expect(
    Promise.resolve(target.acceptInvite(id + "." + "a".repeat(64), "intruder")),
  ).rejects.toThrow("invalid_invite");
  await expect(Promise.resolve(room.restoreBegin(header))).rejects.toThrow(
    "conflict",
  );
});
test("restore refuses incomplete history, conflicting retries and invalid reply references atomically", async () => {
  const { room, id, principal } = await source();
  await room.send(principal, { body: "first", client_message_id: "first" });
  const header = await room.backupHeader(),
    page = await room.backupPage(0, header.last_seq),
    target = env.ROOMS.getByName("restore-" + id);
  await target.restoreBegin(header);
  await expect(
    Promise.resolve(target.restoreFinish(header.snapshot_id)),
  ).rejects.toThrow("conflict");
  await expect(
    Promise.resolve(
      target.restorePage(header.snapshot_id, 0, [
        { ...page.messages[0], reply_to: "missing" },
      ]),
    ),
  ).rejects.toThrow("bad_request");
  await target.restorePage(header.snapshot_id, 0, page.messages);
  await expect(
    Promise.resolve(
      target.restorePage(header.snapshot_id, 0, [
        { ...page.messages[0], body: "changed" },
      ]),
    ),
  ).rejects.toThrow("conflict");
  await target.restoreFinish(header.snapshot_id);
  expect((await target.read(principal, 0, 100)).messages[0].body).toBe("first");
});
test("empty room can be restored and history export requires valid bounds", async () => {
  const { room, id, principal } = await source(),
    header = await room.backupHeader(),
    target = env.ROOMS.getByName("empty-" + id);
  await target.restoreBegin(header);
  await target.restoreFinish(header.snapshot_id);
  expect((await target.read(principal, 0, 100)).messages).toEqual([]);
  await expect(Promise.resolve(room.backupPage(-1, 0))).rejects.toThrow(
    "bad_request",
  );
});

test("restore can resume after eviction and rolls back an invalid multi-message page", async () => {
  const { room, id, principal } = await source();
  for (let i = 0; i < 102; i++)
    await room.send(principal, {
      body: "message " + i,
      client_message_id: String(i),
    });
  const header = await room.backupHeader(),
    target = env.ROOMS.getByName("paged-" + id),
    first = await room.backupPage(0, header.last_seq);
  expect(first.messages).toHaveLength(100);
  expect(first.has_more).toBe(true);
  await target.restoreBegin(header);
  const invalid = [...first.messages];
  invalid[99] = { ...invalid[99], reply_to: "not-a-message" };
  await expect(
    Promise.resolve(target.restorePage(header.snapshot_id, 0, invalid)),
  ).rejects.toThrow("bad_request");
  expect(await target.restoreBegin(header)).toMatchObject({ next_cursor: 0 });
  await target.restorePage(header.snapshot_id, 0, first.messages);
  const { evictDurableObject } = await import("cloudflare:test");
  await evictDurableObject(target);
  expect(await target.restoreBegin(header)).toMatchObject({
    next_cursor: first.next_cursor,
  });
  const last = await room.backupPage(first.next_cursor, header.last_seq);
  await target.restorePage(
    header.snapshot_id,
    first.next_cursor,
    last.messages,
  );
  await target.restoreFinish(header.snapshot_id);
  expect(
    (await target.read(principal, first.next_cursor, 100)).messages,
  ).toEqual(last.messages);
  const next = await target.send(principal, {
    body: "new",
    client_message_id: "new",
  });
  expect(next.seq).toBe(103);
});

test("room registry has a fixed scan cutoff and repeated registration is idempotent", async () => {
  const directory = env.DIRECTORY.getByName("registry-" + crypto.randomUUID());
  await directory.registerRoom("first");
  await directory.registerRoom("first");
  const header = await directory.registryHeader();
  await directory.registerRoom("later");
  const page = await directory.registeredRooms(0, header.last_seq);
  expect(page.rooms.map((room) => room.room_id)).toEqual(["first"]);
  expect(page.has_more).toBe(false);
  expect(
    (
      await directory.registeredRooms(
        0,
        (await directory.registryHeader()).last_seq,
      )
    ).rooms.map((room) => room.room_id),
  ).toEqual(["first", "later"]);
});

test("maintenance entrypoint restores ownership/index but is absent from public HTTP routes", async () => {
  const { exports } = await import("cloudflare:workers");
  const { room, principal } = await source();
  await room.send(principal, {
    body: "private backup",
    client_message_id: "secret",
  });
  const original = await room.backupHeader();
  const header = {
    ...original,
    room: { ...original.room, id: crypto.randomUUID() },
  };
  const messages = (await room.backupPage(0, original.last_seq)).messages.map(
    (message) => ({ ...message, room_id: header.room.id }),
  );
  await exports.Maintenance.restoreBegin(header);
  await exports.Maintenance.restorePage(
    header.room.id,
    header.snapshot_id,
    0,
    messages,
  );
  await exports.Maintenance.restoreFinish(header.room.id, header.snapshot_id);
  expect(
    await env.DIRECTORY.getByName("directory").roomIds(principal.userId),
  ).toContain(header.room.id);
  const credential = await env.DIRECTORY.getByName("directory").issueCredential(
    {
      userId: principal.userId,
      kind: "management",
      rooms: [],
      name: "test",
      ttl: 60,
    },
  );
  const response = await exports.default.fetch(
    "https://apiwx.net/chat/v1/maintenance/restoreBegin",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(header),
    },
  );
  expect(response.status).toBe(404);
});

test("restoration requires re-invitation and does not revive old invite codes", async () => {
  const { room, id, principal } = await source();
  const consumed = await room.createInvite(principal);
  await room.acceptInvite(consumed.code, "github:former-member");
  const pending = await room.createInvite(principal);
  const target = env.ROOMS.getByName("permissions-" + id),
    header = await room.backupHeader();
  await target.restoreBegin(header);
  await target.restoreFinish(header.snapshot_id);
  await expect(
    Promise.resolve(
      target.describe({ ...principal, userId: "github:former-member" }),
    ),
  ).rejects.toThrow("not_found");
  await expect(
    Promise.resolve(target.acceptInvite(pending.code, "github:new-member")),
  ).rejects.toThrow("invalid_invite");
  expect(
    (await target.listMembers(principal)).members.map(
      (member) => member.user_id,
    ),
  ).toEqual([principal.userId]);
});

test("missing required snapshot fields cannot create a partially restored room", async () => {
  const { room, id } = await source(),
    header = await room.backupHeader(),
    target = env.ROOMS.getByName("invalid-" + id);
  await expect(
    Promise.resolve(
      target.restoreBegin({ ...header, captured_at: undefined } as any),
    ),
  ).rejects.toThrow("bad_request");
  await expect(Promise.resolve(target.backupHeader())).rejects.toThrow(
    "not_found",
  );
});

test("invalid maintenance restore headers leave the registry unchanged", async () => {
  const { exports } = await import("cloudflare:workers");
  const { room } = await source(),
    header = await room.backupHeader();
  const before = await exports.Maintenance.registryHeader();
  await expect(
    Promise.resolve(
      exports.Maintenance.restoreBegin({
        ...header,
        room: { ...header.room, id: crypto.randomUUID() },
        captured_at: undefined,
      } as any),
    ),
  ).rejects.toThrow("bad_request");
  expect(await exports.Maintenance.registryHeader()).toEqual(before);
});
