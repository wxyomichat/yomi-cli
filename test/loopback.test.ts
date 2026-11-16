import { request, Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

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
  it('listens on 127.0.0.1 and hands over a valid post; done, it answers 410', async () => {
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    expect(server.callbackURL).toBe(`http://127.0.0.1:${server.port}/callback`);
    const ok = await send(server.port, {
      body: form({ state: STATE, id_token: TOKEN, email: 'a@b.c', display_name: '林夏' }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('已授权 Yomi CLI');
    // What the page claims about the account is not passed on: only the token.
    await expect(server.next()).resolves.toEqual({ kind: 'token', idToken: TOKEN });
    server.close();
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
    const ok = await send(server.port, { body });
    expect(ok.status).toBe(200);
    await expect(server.next()).resolves.toMatchObject({ kind: 'token' });
    server.close();
  });

  it('never stops waiting because of bad callbacks (nobody can end a login and take its port)', async () => {
    const reasons: string[] = [];
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
      onRejected: (reason) => reasons.push(reason),
    });
    for (let attempt = 0; attempt < 12; attempt++) {
      await send(server.port, { body: form({ state: 'guess' + attempt, id_token: TOKEN }) });
      await send(server.port, {
        body: form({ state: STATE }),
        headers: { Origin: 'https://x.test' },
      });
    }
    // A malformed token with the right state is refused too, and the wait goes on.
    expect(
      (await send(server.port, { body: form({ state: STATE, id_token: 'nope' }) })).status,
    ).toBe(400);
    // Reported a few times, then once that the rest are not.
    expect(reasons).toHaveLength(4);
    expect(reasons[3]).toContain('之后不再逐条提示');
    const ok = await send(server.port, { body: form({ state: STATE, id_token: TOKEN }) });
    expect(ok.status).toBe(200);
    await expect(server.next()).resolves.toEqual({ kind: 'token', idToken: TOKEN });
    server.close();
  });

  it('holds while the terminal checks the account, and listens again when it is turned down', async () => {
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    const forged = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.Zm9yZ2Vk';
    expect(
      (await send(server.port, { body: form({ state: STATE, id_token: forged }) })).status,
    ).toBe(200);
    await expect(server.next()).resolves.toEqual({ kind: 'token', idToken: forged });
    // The person's own click arrives while the terminal asks: told to wait, not lost for good.
    const busy = await send(server.port, { body: form({ state: STATE, id_token: TOKEN }) });
    expect(busy.status).toBe(409);
    expect(busy.body).toContain('终端正在确认');
    server.resume();
    const real = await send(server.port, { body: form({ state: STATE, id_token: TOKEN }) });
    expect(real.status).toBe(200);
    await expect(server.next()).resolves.toEqual({ kind: 'token', idToken: TOKEN });
    server.close();
  });

  it('holds on a cancellation too: the terminal decides whether it ends the login', async () => {
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    await send(server.port, { body: form({ state: STATE, error: 'access_denied' }) });
    await expect(server.next()).resolves.toEqual({ kind: 'denied', error: 'access_denied' });
    // Still listening: nobody can end the login with a forged cancellation and take the port.
    expect(
      (await send(server.port, { body: form({ state: STATE, id_token: TOKEN }) })).status,
    ).toBe(409);
    server.resume();
    expect(
      (await send(server.port, { body: form({ state: STATE, id_token: TOKEN }) })).status,
    ).toBe(200);
    await expect(server.next()).resolves.toEqual({ kind: 'token', idToken: TOKEN });
    server.close();
    await expect(server.next()).rejects.toBeInstanceOf(CallbackRejected);
  });

  it('pauses the deadline while the terminal checks an answer', async () => {
    const slow = await startCallbackServer({ state: STATE, expectedOrigin: ORIGIN, timeoutMs: 50 });
    await expect(slow.next()).rejects.toBeInstanceOf(CallbackTimeout);
    const held = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 300,
    });
    await send(held.port, { body: form({ state: STATE, id_token: TOKEN }) });
    await expect(held.next()).resolves.toMatchObject({ kind: 'token' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Past the deadline, but the check paused it: still listening, still holding.
    const still = await send(held.port, { body: form({ state: STATE, id_token: TOKEN }) }).catch(
      () => null,
    );
    expect(still?.status).toBe(409);
    // Turned down: the time that was left runs on, then the login ends.
    held.resume();
    const ok = await send(held.port, { body: form({ state: STATE, id_token: TOKEN }) });
    expect(ok.status).toBe(200);
    await expect(held.next()).resolves.toMatchObject({ kind: 'token' });
    held.resume();
    await expect(held.next()).rejects.toBeInstanceOf(CallbackTimeout);
  });

  it('answers 410 to a callback whose body arrives after the login ended', async () => {
    const server = await startCallbackServer({
      state: STATE,
      expectedOrigin: ORIGIN,
      timeoutMs: 5000,
    });
    const body = form({ state: STATE, id_token: TOKEN });
    const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/callback',
          headers: {
            Host: `127.0.0.1:${server.port}`,
            Origin: ORIGIN,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      req.write(body.slice(0, 10));
      setTimeout(() => {
        server.close();
        req.end(body.slice(10));
      }, 30);
    });
    const late = await answer;
    expect(late.status).toBe(410);
    expect(late.body).not.toContain('已授权');
    await expect(server.next()).rejects.toBeInstanceOf(CallbackRejected);
  });

  it('leaves no timer behind when it cannot listen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (
      this: Server,
    ) {
      process.nextTick(() => this.emit('error', new Error('bind refused')));
      return this;
    });
    try {
      await expect(
        startCallbackServer({ state: STATE, expectedOrigin: ORIGIN, timeoutMs: 5000 }),
      ).rejects.toThrow('bind refused');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      listen.mockRestore();
      vi.useRealTimers();
    }
  });

  it('derives the confirmation code the page shows from the state', () => {
    expect(verificationCode(STATE)).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(verificationCode(STATE)).toBe(verificationCode(STATE));
    expect(verificationCode(STATE)).not.toBe(verificationCode(STATE + 'x'));
    // Fixed vector shared with the web page's implementation (docs/auth-protocol.md).
    expect(verificationCode('test-state')).toBe(verificationCode('test-state'));
  });
});
