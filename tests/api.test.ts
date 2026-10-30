import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
async function user() {
  return env.DIRECTORY.getByName("directory").issueCredential({
    userId: crypto.randomUUID(),
    kind: "management",
    name: "user",
    rooms: [],
    ttl: 3600,
  });
}
async function api(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
) {
  return exports.default.fetch(`https://apiwx.net/chat/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test("API validates authentication and body and does not expose internal minting", async () => {
  expect((await api("/rooms", "invalid")).status).toBe(401);
  const alice = await user();
  expect((await api("/rooms", alice.token, "POST", { name: "" })).status).toBe(
    400,
  );
  expect(
    (await api("/issueCredential", alice.token, "POST", { userId: "attacker" }))
      .status,
  ).toBe(404);
  expect(
    (await api("/rooms", alice.token, "POST", { name: "x".repeat(40000) }))
      .status,
  ).toBe(413);
});
test("two users join private room and session tokens cannot administer or escape scope", async () => {
  const alice = await user(),
    bob = await user();
  const create = await api("/rooms", alice.token, "POST", {
    name: "Project",
    request_id: "project-one",
  });
  expect(create.status).toBe(201);
  const room = await create.json<{ id: string }>();
  expect(
    (
      await (
        await api("/rooms", alice.token, "POST", {
          name: "Project",
          request_id: "project-one",
        })
      ).json<{ id: string }>()
    ).id,
  ).toBe(room.id);
  const inviteResponse = await api(
    `/rooms/${room.id}/invites`,
    alice.token,
    "POST",
    {},
  );
  expect(inviteResponse.status).toBe(201);
  const invite = await inviteResponse.json<{ code: string }>();
  expect(
    (await api("/invites/accept", bob.token, "POST", { code: invite.code }))
      .status,
  ).toBe(200);
  expect(await (await api("/rooms", bob.token)).json()).toMatchObject({
    rooms: [{ id: room.id }],
  });
  const sessionResponse = await api("/sessions", bob.token, "POST", {
    name: "tester",
    rooms: [room.id],
    user_id: "alice",
  });
  expect(sessionResponse.status).toBe(201);
  const session = await sessionResponse.json<{ id: string; token: string }>();
  expect(
    (await api(`/rooms/${room.id}/invites`, session.token, "POST", {})).status,
  ).toBe(403);
  expect(
    (
      await api("/sessions", session.token, "POST", {
        name: "nested",
        rooms: [room.id],
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await api("/sessions", bob.token, "POST", {
        name: "bad",
        rooms: ["unknown"],
      })
    ).status,
  ).toBe(404);
  expect(
    (await api(`/sessions/${session.id}`, alice.token, "DELETE")).status,
  ).toBe(404);
  expect(
    (await api(`/sessions/${session.id}`, bob.token, "DELETE")).status,
  ).toBe(200);
  expect((await api("/rooms", session.token)).status).toBe(401);
});
test("device login route reports configuration failure without upstream calls", async () => {
  expect((await api("/auth/device/start", "", "POST", {})).status).toBe(503);
});
test("messages cross sessions with retry deduplication and cursor pagination", async () => {
  const owner = await user();
  const room = await (
    await api("/rooms", owner.token, "POST", { name: "Messages" })
  ).json<{ id: string }>();
  const session = await (
    await api("/sessions", owner.token, "POST", {
      name: "writer",
      rooms: [room.id],
    })
  ).json<{ token: string; id: string }>();
  const payload = {
    body: "hello",
    client_message_id: "one",
    user_id: "spoofed",
  };
  const sent = await api(
    `/rooms/${room.id}/messages`,
    session.token,
    "POST",
    payload,
  );
  expect(sent.status).toBe(201);
  const message = await sent.json<{
    id: string;
    seq: number;
    user_id: string;
  }>();
  expect(message.user_id).not.toBe("spoofed");
  expect(
    await (
      await api(`/rooms/${room.id}/messages`, session.token, "POST", payload)
    ).json(),
  ).toEqual(message);
  expect(
    (
      await api(`/rooms/${room.id}/messages`, session.token, "POST", {
        ...payload,
        body: "changed",
      })
    ).status,
  ).toBe(409);
  const received = await (
    await api(`/rooms/${room.id}/messages?after=0&limit=1`, session.token)
  ).json();
  expect(received).toMatchObject({
    messages: [{ id: message.id }],
    next_cursor: 1,
    has_more: false,
  });
  expect(
    (await api(`/rooms/${room.id}/messages?wait=31`, session.token)).status,
  ).toBe(400);
  expect(
    (await api(`/rooms/${room.id}/messages?after=-1`, session.token)).status,
  ).toBe(400);
});
test("encoded GitHub user IDs are decoded before member removal", async () => {
  const owner = await user();
  const userId = `github:${Math.floor(Math.random() * 10000000)}`;
  const bob = await env.DIRECTORY.getByName("directory").issueCredential({
    userId,
    kind: "management",
    name: "bob",
    rooms: [],
    ttl: 60,
  });
  const room = await (
    await api("/rooms", owner.token, "POST", { name: "Encoded member" })
  ).json<{ id: string }>();
  const invite = await (
    await api(`/rooms/${room.id}/invites`, owner.token, "POST", {})
  ).json<{ code: string }>();
  await api("/invites/accept", bob.token, "POST", { code: invite.code });
  expect(
    (
      await api(
        `/rooms/${room.id}/members/${encodeURIComponent(userId)}`,
        owner.token,
        "DELETE",
      )
    ).status,
  ).toBe(200);
  expect((await api(`/rooms/${room.id}`, bob.token)).status).toBe(404);
});
