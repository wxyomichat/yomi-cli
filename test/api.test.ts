import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ApiError, Gateway, NotSignedIn } from '../src/core/api.js';
import { type Credential, FileStore } from '../src/core/credentials.js';
import { resolveEnvironment } from '../src/core/env.js';
import { encodeBody, i64, parseGatewayJson, RawBody } from '../src/core/json.js';
import { redact } from '../src/core/redact.js';
import { wireIds } from '../src/ugc/api.js';

const credential = (patch: Partial<Credential> = {}): Credential => ({
  version: 1,
  env: 'test',
  apiOrigin: 'https://gateway.example.test',
  userId: '7300000000000000101',
  deviceId: '42',
  authToken: 'at_old',
  refreshToken: 'rt_old',
  email: '',
  displayName: '',
  createdAt: 0,
  refreshedAt: 0,
  ...patch,
});

/** The gateway's request signature, written independently of the client. */
function gatewaySignature(url: string, body: string, timestamp: string) {
  const parsed = new URL(url);
  const keys = [...new Set(parsed.searchParams.keys())].sort();
  const canonical = keys.map((key) => `${key}=${parsed.searchParams.get(key)}`).join('&');
  return createHash('sha1')
    .update(canonical + body + 'x-timestamp=' + timestamp + 'salt=417b472b')
    .digest('hex');
}

const env = { ...resolveEnvironment({}, {}), apiOrigin: 'https://gateway.example.test' };

describe('Gateway JSON', () => {
  it('keeps i64 digits both ways', () => {
    const parsed = parseGatewayJson(
      '{"id":7300000000000000101,"small":12,"text":"9007199254740993"}',
    ) as Record<string, unknown>;
    expect(parsed.id).toBe('7300000000000000101');
    expect(parsed.small).toBe(12);
    expect(parsed.text).toBe('9007199254740993');
    expect(
      encodeBody({ id: i64('7300000000000000101'), list: [i64('1')], big: 2n ** 63n - 1n }),
    ).toBe('{"id":7300000000000000101,"list":[1],"big":9223372036854775807}');
    expect(encodeBody(new RawBody('{"a":1}'))).toBe('{"a":1}');
  });

  it('writes the NPC and preview IDs as bare i64, except the local draft ID in features', () => {
    const body = wireIds({
      npc_id: '7300000000000000101',
      content: {
        tag_ids: ['9100000000000000003'],
        cover: { upload_id: '5' },
        features: { draft_id: 'draft_x' },
      },
    });
    expect(encodeBody(body)).toBe(
      '{"npc_id":7300000000000000101,"content":{"tag_ids":[9100000000000000003],"cover":{"upload_id":5},"features":{"draft_id":"draft_x"}}}',
    );
    expect(() => wireIds({ npc_id: '01' })).toThrow();
  });
});

describe('Gateway requests', () => {
  it('signs as the gateway checks, with the common query, token and lane', () => {
    const gateway = new Gateway({
      env: { ...env, lane: 'my-lane' },
      idfv: '00000000-0000-4000-8000-000000000000',
      credential: credential(),
      now: () => 1_700_000_000_000,
    });
    const { url, init } = gateway.buildRequest('npc/create_ugc_character', {
      a: i64('7300000000000000101'),
    });
    const headers = init.headers as Record<string, string>;
    expect(
      url.startsWith('https://gateway.example.test/ember/api/v1/npc/create_ugc_character?'),
    ).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get('app_id')).toBe('50010');
    expect(query.get('os')).toBe('3');
    expect(query.get('user_id')).toBe('7300000000000000101');
    expect(query.get('device_id')).toBe('42');
    expect(query.get('channel')).toBe('cli');
    expect(init.body).toBe('{"a":7300000000000000101}');
    expect(headers['x-sign']).toBe(gatewaySignature(url, String(init.body), '1700000000000'));
    expect(headers['X-Token']).toBe('at_old');
    expect(headers.Lane).toBe('my-lane');
    expect(init.redirect).toBe('error');
  });

  it('refreshes a stale token once, saves the new pair, and retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-api-'));
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential());
    const seen: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const token = (init?.headers as Record<string, string>)['X-Token'];
      seen.push(`${new URL(url).pathname} ${token ?? '-'}`);
      if (url.includes('refresh_auth_token'))
        return new Response(
          '{"data":{"auth_token":"at_new","refresh_token":"rt_new"},"base_resp":{"status_code":0}}',
        );
      if (token === 'at_old')
        return new Response('{"base_resp":{"status_code":401}}', { status: 401 });
      return new Response('{"data":{"ok":true},"base_resp":{"status_code":0}}');
    }) as typeof fetch;
    const gateway = new Gateway({
      env,
      idfv: 'x',
      store,
      account: 'test',
      credential: store.get('test'),
      fetch: fetcher,
    });
    const data = await gateway.requestData('account/get_account');
    expect(data.ok).toBe(true);
    expect(seen).toEqual([
      '/ember/api/v1/account/get_account at_old',
      '/ember/api/v1/account/refresh_auth_token -',
      '/ember/api/v1/account/get_account at_new',
    ]);
    expect(store.get('test')).toMatchObject({ authToken: 'at_new', refreshToken: 'rt_new' });
  });

  it('forgets the credential when the refresh is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-api-'));
    const store = new FileStore(join(dir, 'credentials.json'));
    store.set('test', credential());
    const fetcher = (async (input: string | URL | Request) =>
      String(input).includes('refresh_auth_token')
        ? new Response('{"base_resp":{"status_code":1101010111,"status_msg":"expired"}}')
        : new Response('{"base_resp":{"status_code":401}}', { status: 401 })) as typeof fetch;
    const gateway = new Gateway({
      env,
      idfv: 'x',
      store,
      account: 'test',
      credential: store.get('test'),
      fetch: fetcher,
    });
    await expect(gateway.request('account/get_account')).rejects.toBeInstanceOf(NotSignedIn);
    expect(store.get('test')).toBeNull();
  });

  it('reports business refusals with their code', async () => {
    const fetcher = (async () =>
      new Response(
        '{"base_resp":{"status_code":42201,"status_msg":"text rejected"}}',
      )) as unknown as typeof fetch;
    const gateway = new Gateway({ env, idfv: 'x', credential: credential(), fetch: fetcher });
    const error = await gateway.request('npc/create_ugc_character').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(42201);
  });

  it('puts the refresh token only in the connection URL, which is redacted when logged', () => {
    const gateway = new Gateway({ env, idfv: 'x', credential: credential() });
    const url = gateway.connectionURL();
    expect(url.startsWith('wss://gateway.example.test/connection/ws?')).toBe(true);
    expect(new URL(url).searchParams.get('token')).toBe('rt_old');
    expect(redact(url)).not.toContain('rt_old');
  });
});

describe('redact', () => {
  it('strips tokens from JSON, queries, forms and headers', () => {
    const text = [
      '{"auth_token":"a1","refresh_token":"r1","firebase_token":"f1","name":"ok"}',
      'wss://h/connection/ws?app_id=1&token=r2&user_id=3',
      'state=s1&id_token=i1',
      'X-Token: t1',
    ].join('\n');
    const result = redact(text);
    for (const secret of ['a1', 'r1', 'f1', 'r2', 's1', 'i1', 't1'])
      expect(result).not.toMatch(new RegExp(`\\b${secret}\\b`));
    expect(result).toContain('"name":"ok"');
    expect(result).toContain('user_id=3');
  });
});
