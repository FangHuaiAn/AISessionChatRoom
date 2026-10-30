import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
test("rate limit buckets atomically cap requests and separate keys", async () => {
  const stub = env.DIRECTORY.getByName(crypto.randomUUID());
  const values = await Promise.all(
    Array.from({ length: 5 }, () =>
      Promise.resolve(stub.consumeLimit("alice", 3, 60)),
    ),
  );
  expect(values.filter(Boolean)).toHaveLength(3);
  expect(await stub.consumeLimit("bob", 3, 60)).toBe(true);
});
