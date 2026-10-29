import { exports } from 'cloudflare:workers';
import { expect, test } from 'vitest';
test('health is available at the configured API base', async () => {
  const response = await exports.default.fetch('https://apiwx.net/chat/v1/health');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({status: 'ok'});
});
test.each(['/chat-other', '/v1/health', '/chat/v10/health'])('does not claim %s', async path => {
  expect((await exports.default.fetch(`https://apiwx.net${path}`)).status).toBe(404);
});
