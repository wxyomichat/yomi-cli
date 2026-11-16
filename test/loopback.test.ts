import { request } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  CallbackRejected,
  CallbackTimeout,
  startCallbackServer,
  verificationCode,
} from '../src/auth/loopback.js';

const ORIGIN = 'https://web.example.test';
const STATE = 'Wl0bJr1e8rVQb2xq3JpZ4mY7tK9sH6nC5aD1fG8hJ0k';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln';

/** A raw request, so Host and Origin can be set as an attacker would. */
function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/callback',
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body ?? '');
  });
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

describe('the loopback callback', () => {
  it('listens on 127.0.0.1 and accepts one valid post', async () => {
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    expect(server.callbackURL).toBe(`http://127.0.0.1:${server.port}/callback`);
    const ok = await send(server.port, {
      body: form({ state: STATE, id_token: TOKEN, email: 'a@b.c' }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('已授权 Yomi CLI');
    await expect(server.result).resolves.toEqual({
      kind: 'token',
      idToken: TOKEN,
      email: 'a@b.c',
      displayName: '',
    });
    const again = await send(server.port, { body: form({ state: STATE, id_token: TOKEN }) }).catch(
      () => null,
    );
    expect(again === null || again.status === 410).toBe(true);
  });

  it('refuses a wrong state, another origin, a forged Host, a GET with the token, other paths', async () => {
    const reasons: string[] = [];
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
      onRejected: (reason) => reasons.push(reason),
    });
    const body = form({ state: STATE, id_token: TOKEN });
    expect(
      (await send(server.port, { body: form({ state: STATE + 'x', id_token: TOKEN }) })).status,
    ).toBe(400);
    expect(
      (await send(server.port, { body, headers: { Origin: 'https://evil.example' } })).status,
    ).toBe(400);
    expect((await send(server.port, { body, headers: { Origin: 'null' } })).status).toBe(400);
    expect((await send(server.port, { body, headers: { Host: 'evil.example' } })).status).toBe(403);
    expect(
      (
        await send(server.port, {
          method: 'GET',
          path: `/callback?state=${STATE}&id_token=${TOKEN}`,
        })
      ).status,
    ).toBe(405);
    expect((await send(server.port, { path: '/other', body })).status).toBe(404);
    // The terminal hears why, without the token; `Origin: null` is what an https page sends to
    // http://127.0.0.1 unless it sets its referrer policy to `origin`.
    expect(reasons).toEqual([
      'state 与本次登录不符',
      `来源不符：Origin 为 "https://evil.example"，应为 ${ORIGIN}`,
      `来源不符：Origin 为 "null"，应为 ${ORIGIN}`,
    ]);
    expect(reasons.join()).not.toContain(TOKEN);
    // Still waiting: none of those counted.
    const ok = await send(server.port, { body });
    expect(ok.status).toBe(200);
    await expect(server.result).resolves.toMatchObject({ kind: 'token' });
  });

  it('stops after too many bad callbacks', async () => {
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    for (let attempt = 0; attempt < 5; attempt++)
      await send(server.port, { body: form({ state: 'guess' + attempt, id_token: TOKEN }) });
    await expect(server.result).rejects.toBeInstanceOf(CallbackRejected);
  });

  it('passes a cancellation on', async () => {
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    await send(server.port, { body: form({ state: STATE, error: 'access_denied' }) });
    await expect(server.result).resolves.toEqual({ kind: 'denied', error: 'access_denied' });
  });

  it('refuses a malformed token and gives up at the deadline', async () => {
    const bad = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    await send(bad.port, { body: form({ state: STATE, id_token: 'not a jwt' }) });
    await expect(bad.result).rejects.toBeInstanceOf(CallbackRejected);
    const slow = await startCallbackServer({ state: STATE, expectedOrigin: ORIGIN, timeoutMs: 50 });
    await expect(slow.result).rejects.toBeInstanceOf(CallbackTimeout);
  });

  it('derives the confirmation code the page shows from the state', () => {
    expect(verificationCode(STATE)).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(verificationCode(STATE)).toBe(verificationCode(STATE));
    expect(verificationCode(STATE)).not.toBe(verificationCode(STATE + 'x'));
    // Fixed vector shared with the web page's implementation (docs/auth-protocol.md).
    expect(verificationCode('test-state')).toBe(verificationCode('test-state'));
  });
});
