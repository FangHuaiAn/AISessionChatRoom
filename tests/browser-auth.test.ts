import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
async function credential() {
  return env.DIRECTORY.getByName("directory").issueCredential({
    userId: crypto.randomUUID(),
    kind: "management",
    name: "Browser user",
    rooms: [],
    ttl: 60,
  });
}
const request = (
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: unknown,
) =>
  exports.default.fetch("https://apiwx.net/chat/v1" + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
test("cookie authentication returns identity without the secret", async () => {
  const auth = await credential();
  const response = await request("/auth/me", {
    Cookie: `aichat_session=${auth.token}`,
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ name: "Browser user", kind: "management" });
  expect(JSON.stringify(result)).not.toContain(auth.token);
});
test("cookie writes require exact same origin while bearer requests remain supported", async () => {
  const auth = await credential();
  const cookie = { Cookie: `aichat_session=${auth.token}` };
  expect(
    (await request("/rooms", cookie, "POST", { name: "Blocked" })).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/rooms",
        { ...cookie, Origin: "https://evil.apiwx.net" },
        "POST",
        { name: "Blocked" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/rooms",
        { ...cookie, Origin: "https://apiwx.net" },
        "POST",
        { name: "Allowed" },
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await request(
        "/rooms",
        { Authorization: `Bearer ${auth.token}` },
        "POST",
        { name: "CLI" },
      )
    ).status,
  ).toBe(201);
});
test("logout revokes the credential and expires cookie", async () => {
  const auth = await credential();
  const response = await request(
    "/auth/logout",
    { Cookie: `aichat_session=${auth.token}`, Origin: "https://apiwx.net" },
    "POST",
    {},
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(
    (await request("/auth/me", { Cookie: `aichat_session=${auth.token}` }))
      .status,
  ).toBe(401);
});
test("browser login rejects cross-origin initiation", async () => {
  expect(
    (
      await request(
        "/auth/browser/start",
        { Origin: "https://other.example" },
        "POST",
        {},
      )
    ).status,
  ).toBe(403);
});
test("session list contains only caller-owned credentials and no secret material", async () => {
  const auth = await credential(),
    other = await credential();
  const headers = { Authorization: `Bearer ${auth.token}` };
  const room = await (
    await request("/rooms", headers, "POST", { name: "List" })
  ).json<{ id: string }>();
  const session = await (
    await request("/sessions", headers, "POST", {
      name: "agent",
      rooms: [room.id],
    })
  ).json<{ id: string; token: string }>();
  const response = await request("/sessions", headers);
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data).toMatchObject({ sessions: [{ id: session.id, name: "agent" }] });
  expect(JSON.stringify(data)).not.toContain(session.token);
  expect(JSON.stringify(data)).not.toContain("token_hash");
  expect(
    await (
      await request("/sessions", { Authorization: `Bearer ${other.token}` })
    ).json(),
  ).toMatchObject({ sessions: [] });
  expect(
    (await request("/sessions", { Authorization: `Bearer ${session.token}` }))
      .status,
  ).toBe(403);
});
test("member list requires room membership and reports owner role", async () => {
  const auth = await credential(),
    other = await credential(),
    headers = { Authorization: `Bearer ${auth.token}` };
  const room = await (
    await request("/rooms", headers, "POST", { name: "Members" })
  ).json<{ id: string }>();
  const response = await request(`/rooms/${room.id}/members`, headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ members: [{ role: "owner" }] });
  expect(
    (
      await request(`/rooms/${room.id}/members`, {
        Authorization: `Bearer ${other.token}`,
      })
    ).status,
  ).toBe(404);
});
test("browser device login sets an HttpOnly cookie without returning management token", async () => {
  const { default: worker } = await import("../src/index");
  const { createExecutionContext, runInDurableObject } =
    await import("cloudflare:test");
  const { vi } = await import("vitest");
  const ctx = createExecutionContext(),
    configured = { ...env, GITHUB_CLIENT_ID: "client" };
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          device_code: "device",
          user_code: "ABCD",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      ),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(Response.json({ access_token: "upstream-secret" })),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(Response.json({ id: 12345, login: "browser-alice" })),
    );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const start = await worker.fetch(
      new Request("https://apiwx.net/chat/v1/auth/browser/start", {
        method: "POST",
        headers: {
          Origin: "https://apiwx.net",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      configured,
      ctx,
    );
    const transaction = await start.json<{ login_secret: string }>();
    await runInDurableObject(
      env.DIRECTORY.getByName("directory"),
      async (_, state) => {
        state.storage.sql.exec("UPDATE logins SET next_poll=0");
      },
    );
    const response = await worker.fetch(
      new Request("https://apiwx.net/chat/v1/auth/browser/poll", {
        method: "POST",
        headers: {
          Origin: "https://apiwx.net",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(transaction),
      }),
      configured,
      ctx,
    );
    expect(response.status).toBe(200);
    const result = await response.json<Record<string, unknown>>();
    expect(result.status).toBe("complete");
    expect(result).not.toHaveProperty("token");
    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/chat");
    expect(
      await (
        await request("/auth/me", { Cookie: cookie.split(";")[0] })
      ).json(),
    ).toMatchObject({ name: "browser-alice" });
  } finally {
    vi.unstubAllGlobals();
  }
});
