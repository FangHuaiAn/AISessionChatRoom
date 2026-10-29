import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
const directory = () => env.DIRECTORY.getByName(crypto.randomUUID());
test('management credentials authenticate an immutable GitHub identity and store only hashes', async () => {
  const stub = directory();
  const issued = await stub.issueCredential({userId:'github:42', kind:'management', name:'Alice', rooms:[], ttl:60});
  expect(issued.token.length).toBeGreaterThan(40);
  expect(await stub.authenticate(issued.token)).toMatchObject({userId:'github:42', kind:'management'});
  await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql.exec('SELECT * FROM credentials').toArray();
    expect(JSON.stringify(rows)).not.toContain(issued.token);
  });
});
test('session credentials retain room scope and can be revoked only by their owner', async () => {
  const stub = directory();
  const issued = await stub.issueCredential({userId:'github:42',kind:'session',name:'tester',rooms:['room-a'],ttl:60});
  expect(await stub.authenticate(issued.token)).toMatchObject({kind:'session', rooms:['room-a']});
  expect(await stub.revokeCredential('github:99', issued.id)).toBe(false);
  expect(await stub.authenticate(issued.token)).not.toBeNull();
  expect(await stub.revokeCredential('github:42', issued.id)).toBe(true);
  expect(await stub.authenticate(issued.token)).toBeNull();
});
test('unknown and expired credentials cannot authenticate', async () => {
  const stub = directory();
  expect(await stub.authenticate('invalid')).toBeNull();
  const issued = await stub.issueCredential({userId:'github:42',kind:'session',name:'old',rooms:[],ttl:60});
  await runInDurableObject(stub, async (_instance,state) => {
    state.storage.sql.exec('UPDATE credentials SET expires_at = 0 WHERE id = ?', issued.id);
  });
  expect(await stub.authenticate(issued.token)).toBeNull();
});
