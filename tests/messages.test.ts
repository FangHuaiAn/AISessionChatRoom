import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { Principal } from "../src/contracts";
async function setup() {
  const id = crypto.randomUUID(),
    room = env.ROOMS.getByName(id);
  const principal: Principal = {
    id: crypto.randomUUID(),
    userId: "alice",
    name: "agent",
    kind: "session",
    rooms: [id],
    expiresAt: Date.now() + 60000,
  };
  await room.initialize(id, "Project", "alice");
  return { room, principal, id };
}
test("concurrent sends produce ordered persistent messages and idempotent retries", async () => {
  const { room, principal } = await setup();
  const inputs = Array.from({ length: 10 }, (_, i) => ({
    client_message_id: `m${i}`,
    body: `message ${i}`,
  }));
  const messages = await Promise.all(
    inputs.map((input) => Promise.resolve(room.send(principal, input))),
  );
  expect(messages.map((m) => m.seq).sort((a, b) => a - b)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  expect(await room.send(principal, inputs[0])).toEqual(messages[0]);
  await expect(
    Promise.resolve(room.send(principal, { ...inputs[0], body: "different" })),
  ).rejects.toThrow("conflict");
  const first = await room.read(principal, 0, 3);
  expect(first.messages).toHaveLength(3);
  expect(first.next_cursor).toBe(3);
  expect(first.has_more).toBe(true);
  const second = await room.read(principal, first.next_cursor, 100);
  expect(second.messages.map((m) => m.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  expect(second.has_more).toBe(false);
  await runInDurableObject(room, async (_, state) => {
    expect(
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n,
    ).toBe(10);
  });
});
test("reply must refer to a message in the room and identity comes from principal", async () => {
  const { room, principal } = await setup();
  await expect(
    Promise.resolve(
      room.send(principal, {
        client_message_id: "bad",
        body: "hello",
        reply_to: "elsewhere",
      }),
    ),
  ).rejects.toThrow("bad_request");
  const first = await room.send(principal, {
    client_message_id: "first",
    body: "hello",
  });
  const reply = await room.send(principal, {
    client_message_id: "reply",
    body: "answer",
    reply_to: first.id,
  });
  expect(reply).toMatchObject({
    user_id: "alice",
    session_id: principal.id,
    reply_to: first.id,
  });
  await expect(
    Promise.resolve(room.read({ ...principal, userId: "outsider" }, 0, 100)),
  ).rejects.toThrow("not_found");
});
test("long poll returns newly persisted messages and times out without advancing cursor", async () => {
  const { room, principal } = await setup();
  const pending = Promise.resolve(room.waitForMessages(principal, 0, 100, 1));
  await room.send(principal, { client_message_id: "wake", body: "hello" });
  expect((await pending).messages).toHaveLength(1);
  expect(await room.waitForMessages(principal, 1, 100, 0.01)).toEqual({
    messages: [],
    next_cursor: 1,
    has_more: false,
  });
});
test("member removal wakes waiters and denies reading", async () => {
  const { room, principal, id } = await setup();
  const owner = { ...principal, kind: "management" as const };
  const invite = await room.createInvite(owner);
  await room.acceptInvite(invite.code, "bob");
  const bob = {
    ...principal,
    id: crypto.randomUUID(),
    userId: "bob",
    rooms: [id],
  };
  const pending = Promise.resolve(room.waitForMessages(bob, 0, 100, 1));
  const assertion = expect(pending).rejects.toThrow("not_found");
  await room.removeMember(owner, "bob");
  await assertion;
});
