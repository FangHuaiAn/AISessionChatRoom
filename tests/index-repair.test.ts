import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
async function user() {
  const credential = await env.DIRECTORY.getByName("directory").issueCredential(
    {
      userId: crypto.randomUUID(),
      kind: "management",
      name: "repair-test",
      rooms: [],
      ttl: 3600,
    },
  );
  return credential;
}
async function api(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
) {
  return exports.default.fetch("https://apiwx.net/chat/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test("owner reconstructs a lost room index from actual membership, without granting outsiders access", async () => {
  const owner = await user(),
    member = await user(),
    outsider = await user();
  const room = await (
    await api("/rooms", owner.token, "POST", { name: "Recover me" })
  ).json<{ id: string }>();
  const invite = await (
    await api(`/rooms/${room.id}/invites`, owner.token, "POST", {})
  ).json<{ code: string }>();
  await api("/invites/accept", member.token, "POST", { code: invite.code });
  const session = await (
    await api("/sessions", owner.token, "POST", {
      name: "agent",
      rooms: [room.id],
    })
  ).json<{ token: string }>();
  await runInDurableObject(env.DIRECTORY.getByName("directory"), (_, state) => {
    state.storage.sql.exec("DELETE FROM room_index WHERE room_id=?", room.id);
  });
  expect(await (await api("/rooms", member.token)).json()).toEqual({
    rooms: [],
  });
  const path = `/rooms/${room.id}/repair-index`;
  expect((await api(path, outsider.token, "POST", {})).status).toBe(404);
  expect((await api(path, member.token, "POST", {})).status).toBe(403);
  expect((await api(path, session.token, "POST", {})).status).toBe(403);
  const repaired = await api(path, owner.token, "POST", {});
  expect(repaired.status).toBe(200);
  expect(await repaired.json()).toMatchObject({ indexed: 2, has_more: false });
  expect(await (await api("/rooms", member.token)).json()).toMatchObject({
    rooms: [{ id: room.id }],
  });
  expect(await (await api("/rooms", outsider.token)).json()).toEqual({
    rooms: [],
  });
  expect((await api(path, owner.token, "POST", {})).status).toBe(200);
  // A stale directory row must never override Room membership after removal.
  const memberPrincipal = await env.DIRECTORY.getByName(
    "directory",
  ).authenticate(member.token);
  await api(
    `/rooms/${room.id}/members/${encodeURIComponent(memberPrincipal!.userId)}`,
    owner.token,
    "DELETE",
  );
  expect(await (await api("/rooms", member.token)).json()).toEqual({
    rooms: [],
  });
});

test("index repair pages through membership with a bounded stable cursor", async () => {
  const owner = await user();
  const room = await (
    await api("/rooms", owner.token, "POST", { name: "Many members" })
  ).json<{ id: string }>();
  await runInDurableObject(env.ROOMS.getByName(room.id), (_, state) => {
    for (let i = 0; i < 105; i++)
      state.storage.sql.exec(
        "INSERT INTO members VALUES (?,?)",
        "member-" + String(i).padStart(3, "0"),
        Date.now(),
      );
  });
  const path = `/rooms/${room.id}/repair-index`;
  const first = await (
    await api(path, owner.token, "POST", {})
  ).json<{ indexed: number; has_more: boolean; next_cursor: string }>();
  expect(first.indexed).toBe(100);
  expect(first.has_more).toBe(true);
  const next = await (
    await api(path, owner.token, "POST", { after: first.next_cursor })
  ).json<{ indexed: number; has_more: boolean; next_cursor: string }>();
  expect(next.indexed).toBe(6);
  expect(next.has_more).toBe(false);
  expect(next.next_cursor > first.next_cursor).toBe(true);
  expect((await api(path, owner.token, "POST", { after: 42 })).status).toBe(
    400,
  );
});
