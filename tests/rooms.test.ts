import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { Principal } from "../src/contracts";
const person = (
  userId: string,
  kind: Principal["kind"] = "management",
): Principal => ({
  id: crypto.randomUUID(),
  userId,
  kind,
  name: userId,
  rooms: [],
  expiresAt: Date.now() + 60000,
});
async function setup() {
  const id = crypto.randomUUID();
  const room = env.ROOMS.getByName(id);
  const owner = person("alice");
  await room.initialize(id, "Project", owner.userId);
  return { id, room, owner };
}
test("room initialization is idempotent and cannot change owner", async () => {
  const { id, room, owner } = await setup();
  expect(await room.initialize(id, "Project", owner.userId)).toMatchObject({
    id,
    name: "Project",
  });
  await expect(
    Promise.resolve(room.initialize(id, "Other", "bob")),
  ).rejects.toThrow("conflict");
  expect(await room.describe(owner)).toMatchObject({ owner_id: "alice" });
  await expect(Promise.resolve(room.describe(person("bob")))).rejects.toThrow(
    "not_found",
  );
});
test("only owner creates invites and single-use acceptance is atomic", async () => {
  const { room, owner } = await setup();
  const invite = await room.createInvite(owner);
  const results = await Promise.allSettled([
    Promise.resolve(room.acceptInvite(invite.code, "bob")),
    Promise.resolve(room.acceptInvite(invite.code, "carol")),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const winner = results[0].status === "fulfilled" ? "bob" : "carol";
  await room.acceptInvite(invite.code, winner);
  expect(await room.describe(person(winner))).toMatchObject({
    name: "Project",
  });
  await expect(
    Promise.resolve(room.createInvite(person(winner))),
  ).rejects.toThrow("forbidden");
});
test("revoked and expired invites cannot be accepted", async () => {
  const { room, owner } = await setup();
  const revoked = await room.createInvite(owner);
  await room.revokeInvite(owner, revoked.id);
  await expect(
    Promise.resolve(room.acceptInvite(revoked.code, "bob")),
  ).rejects.toThrow("invalid_invite");
  const expired = await room.createInvite(owner);
  await runInDurableObject(room, async (_, state) => {
    state.storage.sql.exec("UPDATE invites SET expires_at=0");
  });
  await expect(
    Promise.resolve(room.acceptInvite(expired.code, "bob")),
  ).rejects.toThrow("invalid_invite");
});
test("removed users cannot rejoin with consumed invite and sessions require scope", async () => {
  const { id, room, owner } = await setup();
  const invite = await room.createInvite(owner);
  await room.acceptInvite(invite.code, "bob");
  const session = person("bob", "session");
  await expect(Promise.resolve(room.describe(session))).rejects.toThrow(
    "not_found",
  );
  session.rooms = [id];
  expect(await room.describe(session)).toMatchObject({ id });
  await expect(
    Promise.resolve(
      room.createInvite({ ...owner, kind: "session", rooms: [id] }),
    ),
  ).rejects.toThrow("forbidden");
  await room.removeMember(owner, "bob");
  await expect(Promise.resolve(room.describe(session))).rejects.toThrow(
    "not_found",
  );
  await expect(
    Promise.resolve(room.acceptInvite(invite.code, "bob")),
  ).rejects.toThrow("invalid_invite");
  await expect(
    Promise.resolve(room.removeMember(owner, "alice")),
  ).rejects.toThrow("conflict");
});
