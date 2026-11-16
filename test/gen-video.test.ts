import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import type { Json } from '../src/core/json.js';
import { sha256 } from '../src/core/state.js';
import { VIDEO_POLL } from '../src/gen/ugcVideo.js';
import type { MockVideoStore } from '../src/mock/gen/video.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi video` end to end against the mock gateway: the price and the balance before the one call
 * that charges, refusals that send nothing, a lost answer resumed with the same request, failures
 * with their refunds, content rejection, `--json`, and the results going with `yomi create` and
 * `yomi preview` of the same character file. Downloads go to a temporary directory.
 */

let mock: MockServer;
let dir: string;
let out: string;
let file: string;
const saved: Record<string, string | undefined> = {};
const polling = { ...VIDEO_POLL };
/** Result asset IDs by use, in the order they finished. */
const results = { cover: [] as string[], intro: [] as string[] };

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

async function authorizeLikeTheBrowser(url: string) {
  const link = new URL(url);
  const params = new URLSearchParams(link.hash.slice(1));
  const page = await (await fetch(link.origin + link.pathname)).text();
  const form = [...page.matchAll(/<form method="POST" data-kind="(\w+)">([\s\S]*?)<\/form>/g)].find(
    (match) => match[1] === 'authorize',
  )!;
  const fields = Object.fromEntries(
    [...form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  fields.state = params.get('state') ?? '';
  return fetch(`http://127.0.0.1:${params.get('port')}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: mock.origin },
    body: new URLSearchParams(fields).toString(),
  });
}

async function run(args: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  process.exitCode = undefined;
  const terminal = memoryIo(options);
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

const store = () => mock.gen.video as MockVideoStore;
const calls = (path: string) => mock.state.requests.filter((request) => request.path === path);
const charges = (requestId: string) =>
  store().ledger.filter((entry) => entry.requestId === requestId && entry.kind === 'charge');
const resultOf = (text: string) => /结果 (\d+)/.exec(text)?.[1] ?? '';
const requestOf = (text: string) => /--resume (video_[0-9a-f]{32})/.exec(text)?.[1] ?? '';

beforeAll(async () => {
  mock = await startMockServer();
  dir = mkdtempSync(join(tmpdir(), 'yomi-cli-video-'));
  out = join(dir, 'media');
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
  VIDEO_POLL.intervalMs = 5;
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorizeLikeTheBrowser(url);
  expect(await pending).toBe(0);
  file = join(dir, 'character.yaml');
  writeFileSync(
    file,
    readFileSync(resolve('examples/character.yaml'), 'utf8').replace(
      /\.\/(cover|avatar)\.png/g,
      resolve('examples') + '/$1.png',
    ),
  );
  mock.state.gems = 1000;
});

afterAll(async () => {
  Object.assign(VIDEO_POLL, polling);
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('yomi video against the mock gateway', () => {
  it('shows the templates, durations and display prices without charging', async () => {
    const result = await run(['video', '--options']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('配置版本 video-config-7，同时进行的任务最多 3 个');
    expect(result.out).toContain('时长 5 / 10 秒（默认 5）');
    expect(result.out).toContain('5 秒 100 钻石 · 10 秒 180 钻石');
    expect(result.out).toContain('tpl_dawn  Dawn');
    expect(result.out).toContain('7 秒 150 钻石');
    expect(result.out).toContain('未公布（以报价为准）');
    const json = await run(['video', '--options', '--json']);
    const config = JSON.parse(json.out) as Json;
    expect(config).toMatchObject({
      config_version: 'video-config-7',
      max_concurrent_tasks: 3,
      custom: { default_duration: 5, display_prices: [{ duration_seconds: 5, diamonds: 100 }, {}] },
    });
    expect((config.templates as Json[]).map((template) => template.template_id)).toEqual([
      'tpl_dawn',
      'tpl_ripple',
    ]);
    expect(store().creates).toHaveLength(0);
  });

  it('shows the price and the balance and sends nothing paid without --accept-price', async () => {
    const result = await run(['video', '-f', file, '--out', out]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('展示价 100 钻石，当前余额 1000 钻石。');
    expect(result.out).toContain('生成 1 条 5 秒的 AI 视频（动态封面）：共 100 钻石。');
    expect(result.err).toContain('--accept-price');
    expect(result.out).toContain('没有扣费，也没有创建任务。');
    expect(store().quotes.size).toBe(1);
    expect(store().creates).toHaveLength(0);
    expect(mock.state.gems).toBe(1000);
  });

  it('uploads and quotes nothing when the gems cannot pay the shown price', async () => {
    mock.state.gems = 50;
    const prepared = calls('ugc/video/frame/prepare').length;
    const quoted = calls('ugc/video/quote').length;
    const result = await run(['video', '-f', file, '--accept-price', '--out', out]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('钻石不足（还差 50）');
    expect(result.err).toContain('没有上传首帧，也没有报价');
    expect(calls('ugc/video/frame/prepare')).toHaveLength(prepared);
    expect(calls('ugc/video/quote')).toHaveLength(quoted);
    expect(store().creates).toHaveLength(0);
    mock.state.gems = 1000;
  });

  it('refuses a quote that differs from the shown price under --accept-price', async () => {
    store().priceDelta = 30;
    const result = await run(['video', '-f', file, '--accept-price', '--out', out]);
    store().priceDelta = 0;
    expect(result.code).toBe(1);
    expect(result.err).toContain('报价 130 钻石，和展示价 100 钻石不同');
    expect(store().creates).toHaveLength(0);
  });

  it('generates a dynamic cover after a typed yes and keeps the result', async () => {
    const result = await run(['video', '-f', file, '--template', 'tpl_dawn', '--out', out], {
      interactive: true,
      input: ['yes'],
    });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('模板：Dawn（tpl_dawn），7 秒');
    expect(result.out).toContain('展示价 150 钻石，当前余额 1000 钻石。');
    expect(result.out).toContain('确认按这个价格扣除钻石？');
    expect(result.out).toContain('生成中 35%');
    expect(result.out).toContain('✓ 视频已生成（扣除 150 钻石）');
    expect(result.out).toContain('已记为动态封面');
    expect(mock.state.gems).toBe(850);
    // The create: string IDs, the quoted input, no server-side wait.
    const [create] = store().creates;
    expect(create).toMatchObject({
      input: { template_id: 'tpl_dawn', template_version: 'v3', custom_prompt: '' },
      wait_timeout_ms: 0,
    });
    expect(create.request_id).toMatch(/^video_[0-9a-f]{32}$/);
    expect(create.draft_id).toMatch(/^draft_[0-9a-f]{32}$/);
    expect(typeof (create.input as Json).first_frame_asset_id).toBe('string');
    expect(typeof create.quote_id).toBe('string');
    expect(charges(String(create.request_id))).toEqual([
      { requestId: create.request_id, kind: 'charge', amount: 150 },
    ]);
    // The first frame: 720×1280 JPEG, a private PUT, its request ID derived as the app does.
    const prepare = calls('ugc/video/frame/prepare').at(-1)!.body;
    const blob = mock.blobs.get(`video-frame-${[...store().frames.keys()].at(-1)}`)!;
    expect(blob.method).toBe('PUT');
    expect(blob.contentType).toBe('image/jpeg');
    expect(blob.headers['x-oss-object-acl']).toBe('private');
    expect(prepare.request_id).toBe(
      'frame_' + sha256(String(create.draft_id) + sha256(blob.bytes)).slice(0, 48),
    );
    expect(prepare).toMatchObject({ sha256: sha256(blob.bytes), byte_size: blob.bytes.length });
    // The preview went to --out.
    const saved = /已保存预览：(\S+)/.exec(result.out)![1];
    expect(saved.startsWith(out)).toBe(true);
    expect(readFileSync(saved).subarray(4, 8).toString()).toBe('ftyp');
    results.cover.push(resultOf(result.out));
  });

  it('reports a failed video as refunding, then refunded', async () => {
    const result = await run([
      'video',
      '-f',
      file,
      '-p',
      'FAIL_VIDEO 海浪',
      '--accept-price',
      '--out',
      out,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('✗ 生成失败（GENERATION_FAILED）');
    const refunding = result.out.indexOf('退款中（还没有到账）');
    expect(refunding).toBeGreaterThan(-1);
    expect(result.out.indexOf('钻石已退回（100 钻石）')).toBeGreaterThan(refunding);
    const requestId = String(store().creates.at(-1)!.request_id);
    expect(store().ledger.filter((entry) => entry.requestId === requestId)).toEqual([
      { requestId, kind: 'charge', amount: 100 },
      { requestId, kind: 'refund', amount: 100 },
    ]);
    expect(mock.state.gems).toBe(850);
  });

  it('reports a result rejected by the content check, refunded', async () => {
    const result = await run([
      'video',
      '-f',
      file,
      '-p',
      'REJECT_VIDEO',
      '--accept-price',
      '--out',
      out,
      '--json',
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('✗ 视频没有通过内容检查（CONTENT_REJECTED）');
    expect(result.err).toContain('钻石已退回（100 钻石）');
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      outcome: 'rejected',
      error_code: 'CONTENT_REJECTED',
      billing_status: 'REFUNDED',
      refund: 'refunded',
      files: [],
    });
    expect(mock.state.gems).toBe(850);
  });

  it('keeps a create whose answer was lost and resumes the same request, charged once', async () => {
    const lost = await run([
      'video',
      '-f',
      file,
      '-p',
      'LOSE_ANSWER 夕阳',
      '--accept-price',
      '--out',
      out,
    ]);
    expect(lost.code).toBe(1);
    expect(lost.err).toContain('创建请求的结果未知（10001）');
    expect(lost.err).toContain('不会自动重发');
    const requestId = requestOf(lost.out);
    expect(requestId).not.toBe('');
    expect(store().creates.filter((body) => body.request_id === requestId)).toHaveLength(1);

    const resumed = await run(['video', '-f', file, '--resume', requestId, '--out', out]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('服务端已经受理了这个请求（没有重复扣费）');
    expect(resumed.out).toContain('✓ 视频已生成（扣除 100 钻石）');
    results.cover.push(resultOf(resumed.out));
    const again = await run(['video', '-f', file, '--resume', requestId, '--out', out]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('✓ 视频已生成');
    // Still one create and one charge for this request.
    expect(store().creates.filter((body) => body.request_id === requestId)).toHaveLength(1);
    expect(charges(requestId)).toHaveLength(1);
    expect(mock.state.gems).toBe(750);
  });

  it('resends a create that never arrived with the same ID and body, after a yes', async () => {
    const dropped = await run([
      'video',
      '-f',
      file,
      '-p',
      'DROP_REQUEST 雨夜',
      '--accept-price',
      '--out',
      out,
    ]);
    expect(dropped.code).toBe(1);
    const requestId = requestOf(dropped.out);
    expect(store().tasks.has(requestId)).toBe(false);

    // The same command again is not a second paid request while this one is unconfirmed.
    const before = { creates: store().creates.length, quotes: calls('ugc/video/quote').length };
    const repeated = await run([
      'video',
      '-f',
      file,
      '-p',
      'DROP_REQUEST 雨夜',
      '--accept-price',
      '--out',
      out,
      '--json',
    ]);
    expect(repeated.code).toBe(1);
    expect(repeated.err).toContain('结果未知的视频请求');
    expect(repeated.err).toContain(`--resume ${requestId}`);
    expect(JSON.parse(repeated.out)).toMatchObject({
      outcome: 'cancelled',
      error_code: 'UNCONFIRMED_REQUEST',
    });
    expect(store().creates).toHaveLength(before.creates);
    expect(calls('ugc/video/quote')).toHaveLength(before.quotes);

    const unconfirmed = await run(['video', '-f', file, '--resume', requestId, '--out', out]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.out).toContain('将重发当时保存的同一个请求');
    expect(unconfirmed.err).toContain('--accept-price');
    expect(store().creates.filter((body) => body.request_id === requestId)).toHaveLength(1);

    const resent = await run([
      'video',
      '-f',
      file,
      '--resume',
      requestId,
      '--accept-price',
      '--out',
      out,
    ]);
    expect(resent.code).toBe(0);
    expect(resent.out).toContain('✓ 视频已生成（扣除 100 钻石）');
    results.cover.push(resultOf(resent.out));
    const bodies = store().creates.filter((body) => body.request_id === requestId);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(charges(requestId)).toHaveLength(1);
  });

  it('quotes again when the quote ran out, and asks again when the price changed', async () => {
    // The first quote has 1 ms left by the server's clock: it is quoted again, same price.
    store().ttlPlan = [1];
    const requoted = await run([
      'video',
      '-f',
      file,
      '--template',
      'tpl_ripple',
      '--duration',
      '5',
      '--as',
      'intro-video',
      '--accept-price',
      '--json',
      '--out',
      out,
    ]);
    expect(requoted.code).toBe(0);
    expect(requoted.err).toContain('展示价未公布（以报价为准）');
    expect(requoted.err).toContain('报价已过期，重新报价');
    const outcome = JSON.parse(requoted.out) as Json;
    expect(outcome).toMatchObject({
      ok: true,
      outcome: 'succeeded',
      use: 'intro-video',
      quoted_diamonds: 120,
      charged_diamonds: 120,
      status: 'SUCCEEDED',
      billing_status: 'CHARGED',
      refund: '',
    });
    expect(existsSync((outcome.files as string[])[0])).toBe(true);
    const create = store().creates.at(-1)!;
    const quotes = [...store().quotes.values()];
    expect(create.quote_id).toBe(quotes.at(-1)!.quoteId);
    expect(create.quote_id).not.toBe(quotes.at(-2)!.quoteId);
    results.intro.push(String(outcome.result_asset_id));

    // Run out again, and the new quote costs more: nothing is sent without a new yes.
    store().ttlPlan = [1];
    store().pricePlan = [0, 20];
    const creates = store().creates.length;
    const changed = await run(['video', '-f', file, '--accept-price', '--out', out]);
    expect(changed.code).toBe(1);
    expect(changed.err).toContain('价格变了：刚才 100 钻石，现在 120 钻石');
    expect(store().creates).toHaveLength(creates);
  });

  it('stops watching without cancelling the task and says how to resume', async () => {
    VIDEO_POLL.maxRounds = 3;
    const result = await run([
      'video',
      '-f',
      file,
      '-p',
      'SLOW_VIDEO',
      '--accept-price',
      '--out',
      out,
    ]);
    VIDEO_POLL.maxRounds = polling.maxRounds;
    expect(result.code).toBe(0);
    expect(result.out).toContain('还没有结束（生成中');
    expect(result.out).toContain('停止查看不会取消服务端的任务，也不会退款');
    const requestId = requestOf(result.out);
    expect(store().tasks.get(requestId)?.status).toBe('RUNNING');
  });

  it("lists the file's tasks and the kept results", async () => {
    const result = await run(['video', '-f', file, '--list']);
    expect(result.code).toBe(0);
    for (const task of store().tasks.values()) expect(result.out).toContain(task.requestId);
    expect(result.out).toContain('已记下：动态封面 3 条、介绍视频 1 条');
    const json = JSON.parse((await run(['video', '-f', file, '--list', '--json'])).out) as Json;
    expect(json.results).toEqual({ dynamic_cover: results.cover, intro_video: results.intro });
    expect((json.tasks as Json[]).length).toBe(store().tasks.size);
  });

  it('sends the videos and the draft ID when the character is created', async () => {
    const result = await run(['create', '-f', file, '--accept-declaration']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('AI 视频：动态封面 3 条、介绍视频 1 条（选用最新一条）');
    const created = [...mock.state.characters.values()].at(-1)!;
    const features = created.content.features as Json;
    const draftId = String(store().creates[0].draft_id);
    expect(features).toMatchObject({
      voice_configuration: { voices: [{ voice_id: 'voice_warm_f', weight: 100 }] },
      dynamic_cover: {
        enabled: true,
        selected_dynamic_video_asset_id: results.cover.at(-1),
        dynamic_video_asset_ids: results.cover,
      },
      intro_video: {
        enabled: true,
        selected_dynamic_video_asset_id: results.intro[0],
        dynamic_video_asset_ids: results.intro,
      },
      draft_id: draftId,
    });
    // Strings on the wire, never i64.
    expect(typeof features.draft_id).toBe('string');
    expect(
      ((features.dynamic_cover as Json).dynamic_video_asset_ids as unknown[]).every(
        (id) => typeof id === 'string',
      ),
    ).toBe(true);
  });

  it('sends them with the first character only: a later create leaves them out, and no new video is made for it', async () => {
    const first = [...mock.state.characters.values()].at(-1)!;
    // The same file again: recognised as created (the videos do not change what the file is).
    const again = await run(['create', '-f', file, '--accept-declaration']);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`已经创建过角色 ${first.npcId}`);
    // A second character from it carries no video bound to the first, and no draft ID.
    const second = await run(['create', '-f', file, '--new', '--accept-declaration']);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain('AI 视频');
    const created = [...mock.state.characters.values()].at(-1)!;
    expect(created.npcId).not.toBe(first.npcId);
    const features = created.content.features as Json;
    expect(features.dynamic_cover).toBeUndefined();
    expect(features.intro_video).toBeUndefined();
    expect(features.draft_id).toBeUndefined();
    // A new video for this file could go with neither: refused before anything is sent.
    const creates = store().creates.length;
    const refused = await run(['video', '-f', file, '-p', '新的海浪', '--accept-price']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`已随角色 ${first.npcId} 提交`);
    expect(store().creates.length).toBe(creates);
    expect((await run(['video', '-f', file, '--list'])).out).toContain(
      `已随角色 ${first.npcId} 提交`,
    );
  });

  it('reads only a regular first-frame file', async () => {
    const other = join(dir, 'frame-check.yaml');
    writeFileSync(other, readFileSync(file, 'utf8').replace('林夏', '林冬'));
    const creates = store().creates.length;
    const result = await run(['video', '-f', other, '--frame', dir, '--accept-price']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('不是普通文件');
    expect(store().creates.length).toBe(creates);
  });

  it('keeps them out of the preview (as the app does), and sends nothing for a file without videos', async () => {
    const result = await run(['preview', '-f', file, '--accept-declaration', '-m', '你好']);
    expect(result.code).toBe(0);
    const prepared = calls('ugc/prepare_ugc_preview').at(-1)!.body;
    const features = ((prepared.character as Json).content as Json).features as Json;
    expect(features.dynamic_cover).toBeUndefined();
    expect(features.intro_video).toBeUndefined();
    expect(features.draft_id).toBeUndefined();
    expect(features.voice_configuration).toBeDefined();

    const plain = join(dir, 'plain.yaml');
    writeFileSync(plain, readFileSync(file, 'utf8').replace('林夏', '林秋'));
    const created = await run(['create', '-f', plain, '--accept-declaration']);
    expect(created.code).toBe(0);
    const last = [...mock.state.characters.values()].at(-1)!;
    const plainFeatures = last.content.features as Json;
    expect(plainFeatures.draft_id).toBeUndefined();
    expect(plainFeatures.dynamic_cover).toBeUndefined();
    expect(plainFeatures.intro_video).toBeUndefined();
    expect(readdirSync(out).filter((name) => name.endsWith('.mp4')).length).toBeGreaterThan(0);
  });
});
