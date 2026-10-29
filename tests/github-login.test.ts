import { afterEach, expect, test, vi } from 'vitest';
import { startDeviceLogin, pollDeviceLogin } from '../src/auth/github';
afterEach(() => vi.unstubAllGlobals());
test('device flow requests identity only and returns verification instructions', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({device_code:'secret',user_code:'ABCD',verification_uri:'https://github.com/login/device',expires_in:900,interval:5}));
  vi.stubGlobal('fetch',fetchMock);
  expect(await startDeviceLogin('client-id')).toMatchObject({device_code:'secret',interval:5});
  const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
  expect(body.get('client_id')).toBe('client-id');
  expect(body.get('scope')).toBeNull();
});
test.each(['authorization_pending','slow_down','access_denied','expired_token'])('handles GitHub %s', async error => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error})));
  expect(await pollDeviceLogin('client','device')).toEqual({status:error});
});
test('success resolves immutable identity without returning GitHub token', async () => {
  const mock = vi.fn().mockResolvedValueOnce(Response.json({access_token:'github-secret'})).mockResolvedValueOnce(Response.json({id:42,login:'alice'}));
  vi.stubGlobal('fetch',mock);
  expect(await pollDeviceLogin('client','device')).toEqual({status:'complete',userId:'github:42',name:'alice'});
  expect(mock.mock.calls[1][1].headers.Authorization).toBe('Bearer github-secret');
});
test('rejects malformed upstream identity', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({access_token:'secret'})).mockResolvedValueOnce(Response.json({login:'alice'})));
  await expect(pollDeviceLogin('client','device')).rejects.toThrow('Invalid GitHub identity');
});
