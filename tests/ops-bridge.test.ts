import { expect, test, vi } from "vitest";
import bridge from "../ops/bridge";
const token = "f".repeat(64);
const request = (
  url = "http://127.0.0.1:8790/rpc",
  authorization = "Bearer " + token,
  origin?: string,
) =>
  new Request(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ method: "registryHeader", args: [] }),
  });
test("maintenance bridge requires loopback, a dedicated token, and same origin", async () => {
  const method = vi.fn().mockResolvedValue({ last_seq: 0 });
  const env = { OPS_TOKEN: token, CHAT: { registryHeader: method } } as any;
  for (const req of [
    request(undefined, "wrong"),
    request("https://apiwx.net/rpc"),
    request(undefined, undefined, "https://untrusted.example"),
  ])
    expect((await bridge.fetch(req, env)).status).toBeGreaterThanOrEqual(400);
  expect(method).not.toHaveBeenCalled();
  expect(await (await bridge.fetch(request(), env)).json()).toEqual({
    last_seq: 0,
  });
  expect(method).toHaveBeenCalledTimes(1);
});
