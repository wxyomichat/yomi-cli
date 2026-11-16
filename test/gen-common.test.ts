import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ApiError, Gateway } from '../src/core/api.js';
import { resolveEnvironment } from '../src/core/env.js';
import { LocalState } from '../src/core/state.js';
import {
  confirmSpend,
  download,
  GenRefusal,
  generationRefusal,
  localTestServer,
  loopbackHttpAllowed,
} from '../src/gen/common.js';
import { UgcFailure } from '../src/ugc/api.js';
import { memoryIo } from './helpers/io.js';

/**
 * The pieces every generation command relies on for money safety: the local state that two `yomi`
 * processes share, telling a refusal (nothing charged) from an unknown outcome, the replay consent,
 * and plain http allowed only against a local test server.
 */

describe('the local state shared by several yomi processes', () => {
  it('keeps what another process wrote in between', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-state-'));
    // Two processes: two instances that share nothing but the file.
    const relay = new LocalState('scope', '7300000000000000101', dir);
    const video = new LocalState('scope', '7300000000000000101', dir);
    relay.setRecord('chat-image', 'bot', { requestId: 'r1', state: 'sent' });
    video.setRecord('video-request', 'v1', { state: 'sent' });
    const draft = video.draft('a.yaml');
    relay.setRecord('chat-image', 'bot', { requestId: 'r1', state: 'accepted' });
    expect(video.record('video-request', 'v1')).toEqual({ state: 'sent' });
    expect(relay.draft('a.yaml').draftId).toBe(draft.draftId);
    expect(video.record<{ state: string }>('chat-image', 'bot')?.state).toBe('accepted');
    // Receipts: the same request gets the same id from either process.
    const id = relay.receipt('m', 'k', { a: 1 });
    expect(video.receipt('m', 'k', { a: 1 })).toBe(id);
  });

  it('lets only one process freeze the same request, and changes records in one step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-state-'));
    const first = new LocalState('scope', '7300000000000000101', dir);
    const second = new LocalState('scope', '7300000000000000101', dir);
    const same = (records: [string, { intent: string }][]) =>
      records.find(([, record]) => record.intent === 'x') ?? null;
    const a = first.claimRecord('batch', same, () => ['a', { intent: 'x' }]);
    const b = second.claimRecord('batch', same, () => ['b', { intent: 'x' }]);
    expect(a).toEqual({ key: 'a', value: { intent: 'x' }, existing: false });
    expect(b).toEqual({ key: 'a', value: { intent: 'x' }, existing: true });
    expect(second.records('batch')).toHaveLength(1);
    // Two changes from two processes: both kept.
    const add = (state: LocalState, item: string) =>
      state.updateRecord<string[]>('results', 'd', (list) => [...(list ?? []), item]);
    add(first, 'one');
    add(second, 'two');
    expect(first.record('results', 'd')).toEqual(['one', 'two']);
    expect(first.updateRecord('results', 'd', () => null)).toBeNull();
    expect(second.record('results', 'd')).toBeNull();
  });
});

describe('refusal or unknown outcome', () => {
  it('counts only known refusals as "nothing charged"', () => {
    expect(generationRefusal(new UgcFailure('1503021061', 'wallet'))).toBeInstanceOf(GenRefusal);
    expect((generationRefusal(new UgcFailure('409', 'conflict')) as GenRefusal).kind).toBe(
      'rejected',
    );
    expect((generationRefusal(new UgcFailure('QUOTE_EXPIRED', '')) as GenRefusal).kind).toBe(
      'rejected',
    );
    // Unrecognised codes may have been accepted: kept as unknown, resent with the same id.
    const odd = new UgcFailure('77001', 'something');
    expect(generationRefusal(odd)).toBe(odd);
    const unavailable = new UgcFailure('UNAVAILABLE', '');
    expect(generationRefusal(unavailable)).toBe(unavailable);
    // A failure that still carries the accepted task or batch is not a refusal.
    const withTask = new UgcFailure('409', '', { task: { task_id: '1' } });
    expect(generationRefusal(withTask)).toBe(withTask);
    const withBatch = new UgcFailure('400', '', { batch: { batch_id: 'b' } });
    expect(generationRefusal(withBatch)).toBe(withBatch);
    // Transport: a 429 was turned away; a 502 or no answer is unknown.
    expect(
      (generationRefusal(new ApiError(-1, 'HTTP 429', null, 'x', 429)) as GenRefusal).kind,
    ).toBe('rateLimited');
    const gateway = new ApiError(-1, 'HTTP 502', null, 'x', 502);
    expect(generationRefusal(gateway)).toBe(gateway);
  });
});

describe('downloads', () => {
  it('stops reading an answer once it passes the size cap, declared or not', async () => {
    const chunk = new Uint8Array(1024);
    const streamed = (chunks: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < chunks; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
    const answer = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
      (async () => new Response(body, { headers })) as unknown as typeof fetch;
    const url = 'https://media.example.test/x';
    await expect(download(url, { maxBytes: 4096, fetcher: answer(streamed(8)) })).rejects.toThrow(
      '结果文件太大',
    );
    await expect(
      download(url, {
        maxBytes: 4096,
        fetcher: answer(streamed(1), { 'content-length': '999999' }),
      }),
    ).rejects.toThrow('结果文件太大');
    const fine = await download(url, {
      maxBytes: 4096,
      fetcher: answer(streamed(2), { 'content-type': 'image/png' }),
    });
    expect(fine.bytes.length).toBe(2048);
    expect(fine.mime).toBe('image/png');
  });

  it('allows plain http only against a local test server', () => {
    const url = new URL('http://127.0.0.1:9/media/x');
    expect(localTestServer({ YOMI_API_ORIGIN: 'http://127.0.0.1:1234' })).toBe(true);
    expect(localTestServer({})).toBe(false);
    expect(localTestServer({ YOMI_API_ORIGIN: 'https://api.yomichat.io' })).toBe(false);
    const saved = process.env.YOMI_API_ORIGIN;
    try {
      delete process.env.YOMI_API_ORIGIN;
      expect(loopbackHttpAllowed(url)).toBe(false);
      process.env.YOMI_API_ORIGIN = 'http://127.0.0.1:1234';
      expect(loopbackHttpAllowed(url)).toBe(true);
      expect(loopbackHttpAllowed(new URL('http://example.com/x'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.YOMI_API_ORIGIN;
      else process.env.YOMI_API_ORIGIN = saved;
    }
  });
});

describe('agreeing to a price', () => {
  const env = { ...resolveEnvironment({}, {}), apiOrigin: 'https://gateway.example.test' };
  const wallet = (gems: number) =>
    new Gateway({
      env,
      idfv: 'x',
      credential: {
        version: 1,
        env: 'prod',
        apiOrigin: env.apiOrigin,
        userId: '1',
        deviceId: '2',
        authToken: 'a',
        refreshToken: 'r',
        email: '',
        displayName: '',
        createdAt: 0,
        refreshedAt: 0,
      },
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: { balance: { total_amount: gems } },
            base_resp: { status_code: 0 },
          }),
        )) as typeof fetch,
    });

  it('refuses a new spend the balance cannot pay, but lets a resend of an accepted request through', async () => {
    const terminal = memoryIo();
    const spend = { action: '生成', total: 50, acceptPrice: true };
    expect(await confirmSpend(terminal.io, wallet(10), spend)).toBe(false);
    expect(terminal.err).toContain('钻石不足');
    expect(await confirmSpend(memoryIo().io, wallet(10), { ...spend, replay: true })).toBe(true);
    expect(await confirmSpend(memoryIo().io, wallet(60), { ...spend, acceptPrice: false })).toBe(
      false,
    );
  });
});
