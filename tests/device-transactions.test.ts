import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const stub = env.DIRECTORY.getByName(crypto.randomUUID());
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          device_code: "github-device-secret",
          user_code: "ABCD",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      ),
    ),
  );
  const login = await stub.startLogin("client");
  return { stub, login };
}
async function ready(stub: ReturnType<typeof env.DIRECTORY.getByName>) {
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("UPDATE logins SET next_poll = 0");
  });
}
test("start conceals device code and early polls do not call upstream", async () => {
  const { stub, login } = await setup();
  expect(JSON.stringify(login)).not.toContain("github-device-secret");
  expect(login.login_secret.length).toBe(64);
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  expect(await stub.pollLogin("client", login.login_secret)).toMatchObject({
    status: "authorization_pending",
    interval: 5,
  });
  expect(mock).not.toHaveBeenCalled();
});
test("completed login returns same credential on retry without storing token plaintext", async () => {
  const { stub, login } = await setup();
  await ready(stub);
  const mock = vi
    .fn()
    .mockImplementationOnce(() =>
      Promise.resolve(Response.json({ access_token: "github-secret" })),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(Response.json({ id: 42, login: "alice" })),
    );
  vi.stubGlobal("fetch", mock);
  const first = await stub.pollLogin("client", login.login_secret);
  expect(first).toMatchObject({ status: "complete", user_id: "github:42" });
  expect("token" in first).toBe(true);
  const second = await stub.pollLogin("client", login.login_secret);
  expect(second).toEqual(first);
  expect(mock).toHaveBeenCalledTimes(2);
  if (!("token" in first)) throw new Error("missing credential");
  expect(await stub.authenticate(first.token)).toMatchObject({
    userId: "github:42",
    kind: "management",
  });
  await runInDurableObject(stub, async (_, state) => {
    const data = JSON.stringify(
      state.storage.sql.exec("SELECT * FROM logins").toArray(),
    );
    expect(data).not.toContain(first.token);
    expect(data).not.toContain(login.login_secret);
    expect(data).not.toContain("github-device-secret");
  });
});
test("unknown and expired transactions are rejected", async () => {
  const { stub, login } = await setup();
  expect(await stub.pollLogin("client", "invalid")).toEqual({
    status: "expired_token",
  });
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("UPDATE logins SET expires_at = 0");
  });
  expect(await stub.pollLogin("client", login.login_secret)).toEqual({
    status: "expired_token",
  });
});
test("slow_down persists increased interval and denial is terminal", async () => {
  const { stub, login } = await setup();
  await ready(stub);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ error: "slow_down" })),
      ),
  );
  expect(await stub.pollLogin("client", login.login_secret)).toEqual({
    status: "slow_down",
    interval: 10,
  });
  await ready(stub);
  const mock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ error: "access_denied" })),
    );
  vi.stubGlobal("fetch", mock);
  expect(await stub.pollLogin("client", login.login_secret)).toEqual({
    status: "access_denied",
  });
  expect(await stub.pollLogin("client", login.login_secret)).toEqual({
    status: "access_denied",
  });
  expect(mock).toHaveBeenCalledTimes(1);
});
test("parallel polls perform one upstream exchange and preserve successful delivery", async () => {
  const { stub, login } = await setup();
  await ready(stub);
  const mock = vi
    .fn()
    .mockImplementationOnce(() =>
      Promise.resolve(Response.json({ access_token: "secret" })),
    )
    .mockImplementationOnce(() =>
      Promise.resolve(Response.json({ id: 42, login: "alice" })),
    );
  vi.stubGlobal("fetch", mock);
  const results = await Promise.all([
    Promise.resolve(stub.pollLogin("client", login.login_secret)),
    Promise.resolve(stub.pollLogin("client", login.login_secret)),
  ]);
  expect(results.some((result) => result.status === "complete")).toBe(true);
  expect(mock).toHaveBeenCalledTimes(2);
  expect(await stub.pollLogin("client", login.login_secret)).toMatchObject({
    status: "complete",
  });
});
test("transaction that expires during exchange cannot mint a credential", async () => {
  const { stub, login } = await setup();
  await ready(stub);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now");
  try {
    const mock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(Response.json({ access_token: "secret" })),
      )
      .mockImplementationOnce(() => {
        clock.mockReturnValue(now + 901000);
        return Promise.resolve(Response.json({ id: 42, login: "alice" }));
      });
    vi.stubGlobal("fetch", mock);
    expect(await stub.pollLogin("client", login.login_secret)).toEqual({
      status: "expired_token",
    });
    await runInDurableObject(stub, async (_, state) => {
      expect(
        state.storage.sql.exec("SELECT count(*) AS n FROM credentials").one().n,
      ).toBe(0);
    });
  } finally {
    clock.mockRestore();
  }
});
