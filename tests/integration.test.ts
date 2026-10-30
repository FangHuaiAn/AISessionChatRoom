import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
const directory = () => env.DIRECTORY.getByName("directory");
const call = (token: string, path: string, method = "GET", body?: unknown) =>
  exports.default.fetch(`https://apiwx.net/chat/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function owner(name: string) {
  const userId = crypto.randomUUID();
  return {
    ...(await directory().issueCredential({
      userId,
      kind: "management",
      name,
      rooms: [],
      ttl: 3600,
    })),
    userId,
  };
}
async function session(token: string, room: string, name: string) {
  const response = await call(token, "/sessions", "POST", {
    name,
    rooms: [room],
  });
  expect(response.status).toBe(201);
  return response.json<{ id: string; token: string }>();
}
test("two users and three sessions collaborate, survive room eviction, and enforce removal", async () => {
  const alice = await owner("alice"),
    bob = await owner("bob"),
    outsider = await owner("outsider");
  const room = await (
    await call(alice.token, "/rooms", "POST", { name: "Integration" })
  ).json<{ id: string }>();
  const a1 = await session(alice.token, room.id, "backend"),
    a2 = await session(alice.token, room.id, "reviewer");
  const sent = await (
    await call(a1.token, `/rooms/${room.id}/messages`, "POST", {
      client_message_id: "one",
      body: "API ready",
    })
  ).json<{ id: string; seq: number }>();
  const invite = await (
    await call(alice.token, `/rooms/${room.id}/invites`, "POST", {})
  ).json<{ code: string }>();
  expect(
    (await call(bob.token, "/invites/accept", "POST", { code: invite.code }))
      .status,
  ).toBe(200);
  const b1 = await session(bob.token, room.id, "tester");
  for (const participant of [a1, a2, b1]) {
    expect(
      await (
        await call(participant.token, `/rooms/${room.id}/messages`)
      ).json(),
    ).toMatchObject({ messages: [{ id: sent.id }] });
  }
  await evictDurableObject(env.ROOMS.getByName(room.id));
  expect(
    await (await call(b1.token, `/rooms/${room.id}/messages?after=0`)).json(),
  ).toMatchObject({ messages: [{ id: sent.id }], next_cursor: 1 });
  const reply = await call(b1.token, `/rooms/${room.id}/messages`, "POST", {
    client_message_id: "two",
    body: "Tests passed",
    reply_to: sent.id,
  });
  expect(reply.status).toBe(201);
  expect(
    (await call(outsider.token, `/rooms/${room.id}/messages`)).status,
  ).toBe(404);
  expect(
    (
      await call(
        alice.token,
        `/rooms/${room.id}/members/${bob.userId}`,
        "DELETE",
      )
    ).status,
  ).toBe(200);
  expect((await call(b1.token, `/rooms/${room.id}/messages`)).status).toBe(404);
  expect(
    (
      await call(b1.token, `/rooms/${room.id}/messages`, "POST", {
        client_message_id: "three",
        body: "denied",
      })
    ).status,
  ).toBe(404);
  expect(await (await call(bob.token, "/rooms")).json()).toEqual({ rooms: [] });
});
test("revocation during a suspended HTTP read never returns message contents", async () => {
  const alice = await owner("alice");
  const room = await (
    await call(alice.token, "/rooms", "POST", { name: "Wait" })
  ).json<{ id: string }>();
  const a1 = await session(alice.token, room.id, "reader"),
    a2 = await session(alice.token, room.id, "writer");
  const pending = Promise.resolve(
    call(a1.token, `/rooms/${room.id}/messages?after=0&wait=1`),
  );
  await call(alice.token, `/sessions/${a1.id}`, "DELETE");
  await call(a2.token, `/rooms/${room.id}/messages`, "POST", {
    client_message_id: "wake",
    body: "private",
  });
  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("private");
});
