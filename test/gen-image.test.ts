import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import type { ImageCommandOptions } from '../src/commands/image.js';
import type { Json } from '../src/core/json.js';
import {
  billingText,
  describeOutput,
  type ImageOutput,
  parseImageConfig,
  pollingComplete,
} from '../src/gen/ugcImage.js';
import type { MockImageState } from '../src/mock/gen/image.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import { loadImage, sniffImage } from '../src/ugc/imageFile.js';
import { loadSpecFile } from '../src/ugc/spec.js';
import { memoryIo } from './helpers/io.js';
import { solidPng } from './helpers/png.js';

/**
 * `yomi image` end to end against the mock gateway: the price and balance before anything is
 * charged, the frozen request and its replay, per-picture refunds, the content checks' refusal,
 * downloads with the cropped cover and avatar, and writing one into a character file. Every
 * download goes to a temporary folder (`--out`).
 */

let mock: MockServer;
let dir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

const images = () => mock.gen.image as MockImageState;
const creates = () =>
  mock.state.requests.filter((request) => request.path === 'npc/create_ugc_image_generation_batch');
const outDir = () => mkdtempSync(join(tmpdir(), 'yomi-image-out-'));

async function run(args: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  process.exitCode = undefined;
  const terminal = memoryIo(options);
  const code = await main(args, terminal.io);
  return { code, out: terminal.out, err: terminal.err };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `yomi image` and presses Ctrl-C once it watches the batch: calls the SIGINT listener the
 * command added, as the signal would, and no other.
 */
async function runAndInterrupt(args: string[]) {
  process.exitCode = undefined;
  const terminal = memoryIo();
  const before = new Set(process.listeners('SIGINT'));
  let finished = false;
  const pending = main(args, terminal.io).finally(() => {
    finished = true;
  });
  const started = Date.now();
  for (;;) {
    const added = process.listeners('SIGINT').filter((listener) => !before.has(listener));
    if (added.length) {
      for (const listener of added) listener('SIGINT');
      break;
    }
    if (finished) throw new Error(`finished before watching\n${terminal.out}\n${terminal.err}`);
    if (Date.now() - started > 10_000) throw new Error('never started watching');
    await tick();
  }
  const code = await pending;
  return { code, out: terminal.out, err: terminal.err };
}

/** `yomi image --resume <id> --forget` through the command line, as a person types it. */
async function runForget(patch: Partial<ImageCommandOptions>) {
  const args = ['image', '--forget'];
  if (patch.resume) args.push('--resume', patch.resume);
  if (patch.pick) args.push('--pick', String(patch.pick));
  if (patch.into) args.push('--into', patch.into);
  if (patch.as) args.push('--as', patch.as);
  if (patch.json) args.push('--json');
  const result = await run(args);
  await tick();
  return result;
}

/** What a browser does on the authorize page (see e2e.test.ts). */
async function authorize(url: string) {
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

/** A character file with comments, in its own folder. */
function characterFile(): string {
  const folder = mkdtempSync(join(tmpdir(), 'yomi-image-char-'));
  const path = join(folder, 'lin.yaml');
  writeFileSync(
    path,
    [
      '# 林夏的角色文件',
      'name: 林夏 # 名字',
      'gender: female',
      'voice: voice_warm_f',
      'cover: ./old-cover.png # 旧封面',
      '# 头像在下面',
      'avatar: ./old-avatar.png',
      'tags: []',
      '',
    ].join('\n'),
  );
  return path;
}

beforeAll(async () => {
  mock = await startMockServer();
  dir = mkdtempSync(join(tmpdir(), 'yomi-cli-image-'));
  setEnv({
    YOMI_API_ORIGIN: mock.origin,
    YOMI_WEB_ORIGIN: mock.origin,
    YOMI_CONFIG_DIR: dir,
    YOMI_CREDENTIAL_STORE: 'file',
    YOMI_LANG: 'zh-Hans',
    NO_COLOR: '1',
  });
  const terminal = memoryIo();
  const pending = main(['login', '--no-browser', '--timeout', '20'], terminal.io);
  const [url] = await terminal.waitFor(/http:\/\/127\.0\.0\.1:\d+\/cli\/auth#\S+/);
  await authorize(url);
  expect(await pending).toBe(0);
});

afterAll(async () => {
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  mock.state.gems = 1000;
});

describe('yomi image', () => {
  it('lists models, prices, styles per model and ratios without charging', async () => {
    const result = await run(['image', '--options']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('yomi-art  Yomi Art  50 钻石/张（原价 100）');
    // The original equals the price: not shown.
    expect(result.out).toMatch(/yomi-lite {2}Yomi Lite {2}5 钻石\/张\n/);
    expect(result.out).toContain('yomi-art：anime（动漫）、realistic（写实）');
    expect(result.out).toContain('yomi-lite：anime（动漫）');
    expect(result.out).toContain('比例（--ratio）：9:16、1:1，默认 9:16');
    expect(result.out).toContain('张数（--count）：1–4，默认 4');
    const json = await run(['image', '--options', '--json']);
    const config = JSON.parse(json.out);
    expect(config.models[0]).toMatchObject({ id: 'yomi-art', price: 50, originalPrice: 100 });
    expect(config.version).toBe('mock-image-v1');
    expect(creates()).toHaveLength(0);
  });

  it('shows the price and balance and charges nothing without --accept-price', async () => {
    const out = outDir();
    const result = await run(['image', '-p', '雨夜书店里的店主', '--out', out]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('生成 4 张角色图片：共 200 钻石（50 钻石/张 × 4）。');
    expect(result.out).toContain('原价 400 钻石（划线价，仅展示）');
    expect(result.out).toContain('当前余额 1000 钻石。');
    expect(result.err).toContain('--accept-price');
    expect(result.out).toContain('没有发出生成请求，没有扣费。');
    expect(creates()).toHaveLength(0);
    expect(mock.state.gems).toBe(1000);
    expect(readdirSync(out)).toHaveLength(0);
  });

  it('checks the request against the configuration before anything is sent', async () => {
    const style = await run(['image', '-p', 'x', '--model', 'yomi-lite', '--style', 'realistic']);
    expect(style.code).toBe(1);
    expect(style.err).toContain('模型 yomi-lite 没有风格 realistic；可选：anime');
    const ratio = await run(['image', '-p', 'x', '--ratio', '4:3']);
    expect(ratio.err).toContain('没有比例 4:3；可选：9:16、1:1');
    const long = await run(['image', '-p', '字'.repeat(1001)]);
    expect(long.err).toContain('描述最多 1000 个字，现在 1001 个');
    const blank = await run(['image', '-p', '   ']);
    expect(blank.err).toContain('需要描述');
    const pick = await run(['image', '-p', 'x', '--pick', '1']);
    expect(pick.err).toContain('--pick 需要配合 --into');
    images().config.max_count = 2;
    const count = await run(['image', '-p', 'x', '--count', '3']);
    expect(count.err).toContain('--count 只能是 1–2');
    images().config.max_count = 4;
    images().config.enabled = false;
    const disabled = await run(['image', '-p', 'x', '--accept-price']);
    expect(disabled.code).toBe(1);
    expect(disabled.err).toContain('暂未开放');
    images().config.enabled = true;
    expect(creates()).toHaveLength(0);
  });

  it('generates, downloads, crops, and writes the picked one into the character file', async () => {
    const out = outDir();
    const file = characterFile();
    const result = await run([
      'image',
      '-p',
      '雨夜书店里的店主，温柔的笑',
      '--accept-price',
      '--out',
      out,
      '--pick',
      '2',
      '--into',
      file,
      '--as',
      'both',
    ]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(mock.state.gems).toBe(800);
    const [request] = creates();
    expect(request.body).toMatchObject({
      prompt: '雨夜书店里的店主，温柔的笑',
      model_id: 'yomi-art',
      style_id: '',
      aspect_ratio: '9:16',
      image_count: 4,
      config_version: 'mock-image-v1',
    });
    expect(request.body.reference).toBeUndefined();
    const batchId = result.out.match(/已受理，批次 (\S+)。/)![1];
    expect(result.out).toContain(`yomi image --resume ${batchId}`);
    for (let n = 1; n <= 4; n++) expect(result.out).toContain(`#${n} ✓ 成功（已扣 50 钻石）`);
    expect(result.out).toContain('共扣 200 钻石。');
    // Signed addresses are never printed.
    expect(result.out).not.toContain('/media/');
    const files = readdirSync(out).sort();
    expect(files).toHaveLength(12);
    const cover = join(out, `yomi-image-${batchId}-2-cover.jpg`);
    const avatar = join(out, `yomi-image-${batchId}-2-avatar.jpg`);
    expect(sniffImage(readFileSync(join(out, `yomi-image-${batchId}-2.png`)))).toMatchObject({
      mime: 'image/png',
      width: 180,
      height: 320,
    });
    expect(sniffImage(readFileSync(cover))).toMatchObject({
      mime: 'image/jpeg',
      width: 720,
      height: 1440,
    });
    expect(sniffImage(readFileSync(avatar))).toMatchObject({ width: 512, height: 512 });
    // The character file keeps its comments and order; the paths are relative to it.
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# 林夏的角色文件');
    expect(text).toContain('name: 林夏 # 名字');
    expect(text).toContain('# 头像在下面');
    expect(text).toMatch(/cover: \.\.\/.*-2-cover\.jpg # 旧封面/);
    expect(text.indexOf('cover:')).toBeLessThan(text.indexOf('avatar:'));
    expect(text.indexOf('avatar:')).toBeLessThan(text.indexOf('tags:'));
    const spec = loadSpecFile(file);
    expect(spec.cover).toEqual({ kind: 'file', path: cover });
    expect(spec.avatar).toEqual({ kind: 'file', path: avatar });
    // What create would upload passes the app's shape checks.
    expect(loadImage(cover, 'cover')).toMatchObject({ width: 720, height: 1440 });
    expect(loadImage(avatar, 'avatar')).toMatchObject({ width: 512, height: 512 });
    expect(result.out).toContain('✓ 已把第 2 张写进');
  });

  it('asks interactively, and a typed yes goes ahead', async () => {
    const before = creates().length;
    const out = outDir();
    const result = await run(
      [
        'image',
        '-p',
        '海边的风',
        '--model',
        'yomi-lite',
        '--style',
        'anime',
        '--count',
        '1',
        '--out',
        out,
      ],
      { interactive: true, input: ['yes'] },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('生成 1 张角色图片：共 5 钻石（5 钻石/张 × 1）。');
    expect(result.out).not.toContain('原价');
    expect(result.out).toContain('输入 yes 继续');
    expect(creates()).toHaveLength(before + 1);
    expect(creates().at(-1)!.body).toMatchObject({ style_id: 'anime', image_count: 1 });
    expect(mock.state.gems).toBe(995);
  });

  it('never sends a request the balance cannot pay', async () => {
    mock.state.gems = 100;
    const before = creates().length;
    const result = await run(['image', '-p', '雨夜', '--accept-price', '--out', outDir()]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('共 200 钻石');
    expect(result.out).toContain('当前余额 100 钻石。');
    expect(result.err).toContain('钻石不足（还差 100）');
    expect(creates()).toHaveLength(before);
    expect(mock.state.gems).toBe(100);
  });

  it('a refusal by the wallet charges nothing and is forgotten', async () => {
    images().refuseNext = { code: 1503021061, message: 'wallet insufficient amount' };
    const before = creates().length;
    const args = [
      'image',
      '-p',
      '被拒绝的请求',
      '--count',
      '1',
      '--accept-price',
      '--out',
      outDir(),
    ];
    const refused = await run(args);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('钻石不足，请先在 Yomi App 或网页充值。这次没有扣费。');
    expect(mock.state.gems).toBe(1000);
    const again = await run(args);
    expect(again.code).toBe(0);
    const [first, second] = creates().slice(before);
    // The refused request was forgotten: the next one is a new request.
    expect(second.body.client_request_id).not.toBe(first.body.client_request_id);
    expect(mock.state.gems).toBe(950);
  });

  it('keeps an unknown outcome and --resume replays the same request without a second charge', async () => {
    images().loseNextAnswer = true;
    const before = creates().length;
    const charged = images().charged;
    const out = outDir();
    const lost = await run([
      'image',
      '-p',
      '答案丢了',
      '--count',
      '2',
      '--accept-price',
      '--out',
      out,
    ]);
    expect(lost.code).toBe(1);
    expect(lost.err).toContain('结果未知');
    expect(lost.err).toContain('没有自动重发');
    const requestId = lost.err.match(/yomi image --resume (\S+) 会用同一个请求 ID/)![1];
    expect(creates().at(-1)!.body.client_request_id).toBe(requestId);
    // The mock did accept it.
    expect(mock.state.gems).toBe(900);
    const resumed = await run(['image', '--resume', requestId, '--accept-price', '--out', out]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('重发同一请求：生成 2 张角色图片：共 100 钻石');
    const [first, replay] = creates().slice(before);
    expect(replay.body).toEqual(first.body);
    expect(images().charged - charged).toBe(100);
    expect(mock.state.gems).toBe(900);
    expect(resumed.out).toContain('#2 ✓ 成功（已扣 50 钻石）');
    // The batch is known now: --resume by its ID reads it and never creates.
    const batchId = resumed.out.match(/已受理，批次 (\S+)。/)![1];
    const again = await run(['image', '--resume', batchId, '--out', out]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('不会扣费');
    expect(creates()).toHaveLength(before + 2);
  });

  it('runs an unchanged request whose answer was lost with its own request ID again', async () => {
    images().loseNextAnswer = true;
    const before = creates().length;
    const args = ['image', '-p', '同一个请求', '--count', '1', '--accept-price', '--out', outDir()];
    expect((await run(args)).code).toBe(1);
    expect(mock.state.gems).toBe(950);
    const again = await run(args);
    expect(again.code).toBe(0);
    expect(again.err).toContain('这次用同一个请求 ID 重发');
    const [first, second] = creates().slice(before);
    expect(second.body.client_request_id).toBe(first.body.client_request_id);
    expect(mock.state.gems).toBe(950);
  });

  it('treats an answer it does not know as unknown, never as a refusal', async () => {
    // A gateway-made error code: not one the app reads as a refusal of the batch.
    images().refuseNext = { code: 1000500, message: 'gateway error' };
    const before = creates().length;
    const args = [
      'image',
      '-p',
      '认不出的回包',
      '--count',
      '1',
      '--accept-price',
      '--out',
      outDir(),
    ];
    const first = await run(args);
    expect(first.code).toBe(1);
    expect(first.err).toContain('结果未知（1000500：gateway error）');
    const again = await run(args);
    expect(again.code).toBe(0);
    const [a, b] = creates().slice(before);
    expect(b.body.client_request_id).toBe(a.body.client_request_id);
    expect(mock.state.gems).toBe(950);
  });

  it('says per picture what failed, what the content checks refused, and what was refunded', async () => {
    const out = outDir();
    const result = await run([
      'image',
      '-p',
      '雨夜 [fail:2] [sensitive:3]',
      '--model',
      'yomi-lite',
      '--count',
      '3',
      '--accept-price',
      '--out',
      out,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('#1 ✓ 成功（已扣 5 钻石）');
    expect(result.out).toContain('#2 ✗ 生成失败（GENERATION_FAILED）。钻石已退回');
    expect(result.out).toContain('#3 ✗ 未通过内容检查（CONTENT_SENSITIVE）。钻石已退回');
    expect(result.out).toContain('共扣 5 钻石，已退回 10 钻石。');
    // While polling, the refund was shown as under way, never as done.
    expect(result.out).toMatch(/进度：.*退款中 2/);
    expect(mock.state.gems).toBe(995);
    // Only the succeeded one was downloaded.
    expect(readdirSync(out).filter((name) => name.includes('-1'))).toHaveLength(3);
    expect(readdirSync(out)).toHaveLength(3);
  });

  it('prints one JSON object for scripts', async () => {
    const out = outDir();
    const result = await run([
      'image',
      '-p',
      '雨夜 [sensitive:2]',
      '--model',
      'yomi-lite',
      '--count',
      '2',
      '--accept-price',
      '--json',
      '--out',
      out,
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      status: 'done',
      replayed: false,
      unitPrice: 5,
      total: 10,
      charged: 5,
      refunded: 5,
      refunding: 0,
      request: { model: 'yomi-lite', count: 2, ratio: '9:16', style: '' },
    });
    expect(report.requestId).toBe(creates().at(-1)!.body.client_request_id);
    expect(report.batchId).toMatch(/^ugcimg_/);
    expect(report.outputs[0]).toMatchObject({ index: 1, result: 'succeeded', billing: 'charged' });
    expect(existsSync(report.outputs[0].files.cover)).toBe(true);
    expect(existsSync(report.outputs[0].files.avatar)).toBe(true);
    expect(report.outputs[1]).toMatchObject({
      result: 'rejected',
      billing: 'refunded',
      files: null,
      failure: { code: 'CONTENT_SENSITIVE' },
    });
    // The person's lines went to stderr.
    expect(result.err).toContain('共 10 钻石');
  });

  it('keeps a WebP original and writes its asset reference instead', async () => {
    const out = outDir();
    const file = characterFile();
    const result = await run([
      'image',
      '-p',
      '雨夜 [webp]',
      '--model',
      'yomi-lite',
      '--count',
      '1',
      '--accept-price',
      '--out',
      out,
      '--pick',
      '1',
      '--into',
      file,
      '--as',
      'cover',
    ]);
    expect(result.code).toBe(0);
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-1\.webp$/);
    const assetId = result.out.match(/cover: \{ asset_id: "(\d+)" \}/)![1];
    expect(result.out).toContain('本机不能裁剪这张原图');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`asset_id: "${assetId}"`);
    expect(text).toContain('avatar: ./old-avatar.png');
    expect(loadSpecFile(file).cover).toEqual({ kind: 'asset', assetId });
    expect(result.err).toContain('没有裁剪成 1:2 / 1:1');

    // A WebP result without an asset ID: nothing usable, the character file is left alone.
    const untouched = characterFile();
    const before = readFileSync(untouched, 'utf8');
    const bare = await run([
      'image',
      '-p',
      '雨夜 [webp] [noasset]',
      '--model',
      'yomi-lite',
      '--count',
      '1',
      '--accept-price',
      '--out',
      outDir(),
      '--pick',
      '1',
      '--into',
      untouched,
      '--as',
      'both',
    ]);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('第 1 张没有可用的结果');
    expect(bare.out).not.toContain('asset_id');
    expect(readFileSync(untouched, 'utf8')).toBe(before);
  });

  it('uploads and reviews a reference first; a rejected one charges nothing', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'yomi-image-ref-'));
    const rejected = join(folder, 'bad.png');
    writeFileSync(rejected, solidPng(64, 64, [9, 9, 9], 'REJECT'));
    const before = creates().length;
    const refused = await run([
      'image',
      '-p',
      '照着参考图',
      '--reference',
      rejected,
      '--accept-price',
      '--out',
      outDir(),
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('参考图未通过审核，请换一张。没有发出生成请求，没有扣费。');
    expect(creates()).toHaveLength(before);
    expect(mock.state.gems).toBe(1000);

    const good = join(folder, 'good.png');
    writeFileSync(good, solidPng(64, 64, [200, 120, 40]));
    const result = await run([
      'image',
      '-p',
      '照着参考图',
      '--reference',
      good,
      '--count',
      '1',
      '--accept-price',
      '--out',
      outDir(),
    ]);
    expect(result.code).toBe(0);
    const uploads = mock.state.requests.filter(
      (request) => request.path === 'npc/create_ugc_image_upload',
    );
    expect(uploads.at(-1)!.body).toMatchObject({ purpose: 'reference', mime_type: 'image/png' });
    const reference = creates().at(-1)!.body.reference as Json;
    expect(Object.keys(reference)).toEqual(['upload_id']);
    expect(String(reference.upload_id)).toMatch(/^[1-9][0-9]{18}$/);
  });

  it('refuses an unknown batch on --resume', async () => {
    const result = await run(['image', '--resume', 'ugcimg_nope', '--out', outDir()]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('404');
  });

  it('charges nothing when the balance or the price cannot be read', async () => {
    const before = creates().length;
    mock.state.walletFailures = 1;
    const args = ['image', '-p', '读不到', '--count', '1', '--accept-price', '--out', outDir()];
    const balance = await run(args);
    expect(balance.code).toBe(1);
    expect(balance.err).toContain('暂时读不到钻石余额');
    const config = images().config;
    images().config = { ...config, models: [{ model_id: 'yomi-art', name: 'Yomi Art' }] };
    try {
      const price = await run(args);
      expect(price.code).toBe(1);
      expect(price.err).toContain('读不到模型 yomi-art 的价格');
    } finally {
      images().config = config;
    }
    expect(creates()).toHaveLength(before);
    expect(mock.state.gems).toBe(1000);
  });

  it('runs an unchanged request again with its own ID even after the configuration changed', async () => {
    // Accepted and charged, but the answer was lost; then the quote's version moved on.
    images().loseNextAnswer = true;
    const before = creates().length;
    const args = ['image', '-p', '版本变了', '--count', '1', '--accept-price', '--out', outDir()];
    expect((await run(args)).code).toBe(1);
    expect(mock.state.gems).toBe(950);
    images().config.config_version = 'mock-image-v2';
    try {
      const again = await run(args);
      expect(again.code).toBe(0);
      expect(again.err).toContain('这次用同一个请求 ID 重发');
      const [first, second] = creates().slice(before);
      expect(second.body).toEqual(first.body);
      expect(mock.state.gems).toBe(950);

      // Never accepted (outcome unknown), then refused as stale: forgotten, and the next run is a
      // new request at the new version.
      images().refuseNext = { code: 1000500, message: 'gateway error' };
      const other = ['image', '-p', '没受理', '--count', '1', '--accept-price', '--out', outDir()];
      expect((await run(other)).code).toBe(1);
      images().config.config_version = 'mock-image-v3';
      // The resend is refused as stale: that refusal covers the resend only (the first send might
      // have been accepted), so the request stays until it is let go on purpose.
      const stale = await run(other);
      expect(stale.code).toBe(1);
      expect(stale.err).toContain('被拒的只是这次重发');
      const kept = String(creates()[before + 2].body.client_request_id);
      expect(stale.err).toContain(`yomi image --resume ${kept}`);
      const still = await run(other);
      expect(still.err).toContain('这次用同一个请求 ID 重发');
      expect((await runForget({ resume: kept })).code).toBe(0);
      const fresh = await run(other);
      expect(fresh.code).toBe(0);
      const [unknown, replayed, resent, renewed] = creates().slice(before + 2);
      expect(replayed.body).toEqual(unknown.body);
      expect(resent.body).toEqual(unknown.body);
      expect(renewed.body.client_request_id).not.toBe(unknown.body.client_request_id);
      expect(renewed.body.config_version).toBe('mock-image-v3');
      expect(mock.state.gems).toBe(900);
    } finally {
      images().config.config_version = 'mock-image-v1';
    }
  });
});

describe('yomi image: batches that have not settled, and letting requests go', () => {
  it('shows an accepted batch that has not settled again instead of paying for a new one', async () => {
    const before = creates().length;
    const out = outDir();
    const args = [
      'image',
      '-p',
      '还在生成的一批',
      '--model',
      'yomi-lite',
      '--count',
      '1',
      '--accept-price',
      '--out',
      out,
    ];
    let batchId = '';
    images().readsToFinish = Number.POSITIVE_INFINITY;
    try {
      // Accepted and charged, then Ctrl-C while it still runs.
      const first = await runAndInterrupt(args);
      expect(first.code).toBe(1);
      batchId = first.out.match(/已受理，批次 (\S+)。/)![1];
      expect(first.out).toContain('已停止查看。');
      expect(first.err).toContain('还没有全部完成');
      expect(first.err).toContain('同样的命令只会继续查看它，不会重新生成');
      expect(first.err).toContain(`yomi image --resume ${batchId} --forget`);
      expect(creates()).toHaveLength(before + 1);
      expect(mock.state.gems).toBe(995);

      // The same command while it runs: that batch again, no price asked, nothing created.
      const again = await runAndInterrupt(args);
      expect(again.code).toBe(1);
      expect(again.out).toContain(
        `上次同样的请求已受理（批次 ${batchId}），还没有结束：继续查看这一批，不会再扣费。`,
      );
      expect(again.out).not.toContain('当前余额');
      expect(again.out).toContain('#1 … 生成中（已扣 5 钻石）');
      expect(creates()).toHaveLength(before + 1);
      expect(mock.state.gems).toBe(995);
    } finally {
      images().readsToFinish = 1;
    }

    // It settles: shown and downloaded, still without a charge, and marked settled.
    const settled = await run([...args, '--json']);
    expect(settled.code).toBe(0);
    expect(settled.err).toContain('继续查看这一批，不会再扣费');
    expect(JSON.parse(settled.out)).toMatchObject({
      status: 'done',
      continued: true,
      replayed: false,
      batchId,
      charged: 5,
      outputs: [{ index: 1, result: 'succeeded' }],
    });
    expect(readdirSync(out)).toContain(`yomi-image-${batchId}-1-cover.jpg`);
    expect(creates()).toHaveLength(before + 1);
    expect(mock.state.gems).toBe(995);
    const nothing = await runForget({ resume: batchId });
    expect(nothing.code).toBe(0);
    expect(nothing.out).toContain(`批次 ${batchId} 已经结束，不需要放弃`);

    // Settled: the same command is a new paid batch.
    const fresh = await run(args);
    expect(fresh.code).toBe(0);
    expect(fresh.out).not.toContain('继续查看这一批');
    expect(fresh.out).not.toContain(`批次 ${batchId}`);
    expect(creates()).toHaveLength(before + 2);
    const [paid, renewed] = creates().slice(before);
    expect(renewed.body.client_request_id).not.toBe(paid.body.client_request_id);
    expect(mock.state.gems).toBe(990);
  });

  it('lets a batch that never settles go with --forget; the same command then pays anew', async () => {
    const before = creates().length;
    const args = [
      'image',
      '-p',
      '一直不结束的一批',
      '--model',
      'yomi-lite',
      '--count',
      '1',
      '--accept-price',
      '--out',
      outDir(),
    ];
    let batchId = '';
    images().readsToFinish = Number.POSITIVE_INFINITY;
    try {
      const first = await runAndInterrupt(args);
      batchId = first.out.match(/已受理，批次 (\S+)。/)![1];
      expect(mock.state.gems).toBe(995);
    } finally {
      images().readsToFinish = 1;
    }
    // The server no longer finds it: it can never settle, and the same command says how out.
    images().batches.delete(batchId);
    const stuck = await run(args);
    expect(stuck.code).toBe(1);
    expect(stuck.err).toContain(`读不到批次 ${batchId}`);
    expect(stuck.err).toContain(`运行 yomi image --resume ${batchId} --forget 放弃跟踪`);
    expect(creates()).toHaveLength(before + 1);

    // Let go on this machine only: nothing is sent.
    const requests = mock.state.requests.length;
    const dropped = await runForget({ resume: batchId });
    expect(dropped.code).toBe(0);
    expect(dropped.out).toContain(`已放弃跟踪批次 ${batchId}`);
    expect(dropped.err).toContain('不会取消服务端的生成，也不会退款');
    expect(mock.state.requests).toHaveLength(requests);
    const twice = await runForget({ resume: batchId, json: true });
    expect(JSON.parse(twice.out)).toMatchObject({ status: 'forgotten', batchId });
    expect(twice.err).toContain('之前已经放弃，没有变化');

    const fresh = await run(args);
    expect(fresh.code).toBe(0);
    expect(fresh.out).not.toContain('继续查看这一批');
    expect(creates()).toHaveLength(before + 2);
    expect(mock.state.gems).toBe(990);
  });

  it('drops a request whose outcome is unknown on purpose, and can still take it back', async () => {
    images().loseNextAnswer = true;
    const before = creates().length;
    const args = [
      'image',
      '-p',
      '不要这个请求了',
      '--count',
      '1',
      '--accept-price',
      '--out',
      outDir(),
    ];
    const lost = await run(args);
    expect(lost.code).toBe(1);
    const requestId = lost.err.match(/yomi image --resume (\S+) 会用同一个请求 ID/)![1];
    expect(lost.err).toContain(`yomi image --resume ${requestId} --forget 放弃`);
    // The mock did accept and charge it.
    expect(mock.state.gems).toBe(950);

    const requests = mock.state.requests.length;
    const dropped = await runForget({ resume: requestId, json: true });
    expect(dropped.code).toBe(0);
    expect(JSON.parse(dropped.out)).toMatchObject({
      status: 'forgotten',
      requestId,
      batchId: null,
      total: 50,
    });
    expect(dropped.err).toContain(`已放弃请求 ${requestId}`);
    expect(dropped.err).toContain('如果这个请求其实已经被服务端受理，它的扣费照常生效');
    expect(dropped.err).toContain(`yomi image --resume ${requestId}：用原来的请求 ID 重发`);
    expect(mock.state.requests).toHaveLength(requests);

    // The same command is a new request now, paid again; the dropped one is not mentioned.
    const fresh = await run(args);
    expect(fresh.code).toBe(0);
    expect(fresh.err).not.toContain('这次用同一个请求 ID 重发');
    expect(fresh.err).not.toContain(requestId);
    const [first, second] = creates().slice(before);
    expect(first.body.client_request_id).toBe(requestId);
    expect(second.body.client_request_id).not.toBe(requestId);
    expect(mock.state.gems).toBe(900);

    // Taken back on purpose: resent as frozen, the original batch comes back, no second charge.
    const resumed = await run([
      'image',
      '--resume',
      requestId,
      '--accept-price',
      '--out',
      outDir(),
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('这个请求之前已放弃');
    expect(creates().at(-1)!.body).toEqual(first.body);
    expect(mock.state.gems).toBe(900);
  });

  it('checks --forget before anything is read or sent', async () => {
    const requests = mock.state.requests.length;
    const alone = await runForget({});
    expect(alone.code).toBe(1);
    expect(alone.err).toContain('--forget 需要配合 --resume');
    const picked = await runForget({ resume: 'ugcimg_x', pick: 1, into: 'x.yaml', as: 'cover' });
    expect(picked.code).toBe(1);
    expect(picked.err).toContain('--forget 只放弃本机的记录');
    const unknown = await runForget({ resume: 'ugcimg_nope' });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('本机没有 ugcimg_nope 的记录');
    expect(mock.state.requests).toHaveLength(requests);
  });
});

describe('image results in words', () => {
  const output = (patch: Partial<ImageOutput>): ImageOutput => ({
    index: 1,
    taskId: '1',
    generationStatus: 4,
    assetId: '2',
    url: '',
    mime: '',
    expiresAt: null,
    failure: null,
    billing: 'charged',
    ...patch,
  });

  it('never calls a refund under way a finished one', () => {
    expect(billingText('refunding', 5)).toBe('退款中…');
    expect(billingText('refunded', 5)).toBe('钻石已退回');
    const failed = { generationStatus: 5, failure: { code: 'X', message: '', retryable: false } };
    expect(describeOutput(output({ ...failed, billing: 'refunding' }), 5)).toBe(
      '#1 ✗ 生成失败（X）。退款中…',
    );
    expect(describeOutput(output({ ...failed, billing: 'charged' }), 5)).toContain(
      '退款还没有开始',
    );
  });

  it('stops polling only when every output is final and no money is moving', () => {
    const batch = (outputs: ImageOutput[]) => ({ id: 'b', outputs });
    expect(pollingComplete(batch([]))).toBe(false);
    expect(pollingComplete(batch([output({})]))).toBe(true);
    expect(pollingComplete(batch([output({ billing: 'pending' })]))).toBe(false);
    expect(pollingComplete(batch([output({ generationStatus: 2 })]))).toBe(false);
    const refunding = output({ generationStatus: 5, billing: 'refunding' });
    expect(pollingComplete(batch([refunding]))).toBe(false);
    // Interrupted: not final, but a failure that will not be retried.
    const stuck = output({
      generationStatus: 2,
      failure: { code: 'STUCK', message: '', retryable: false },
    });
    expect(pollingComplete(batch([stuck]))).toBe(true);
    expect(describeOutput(stuck, 5)).toContain('生成已中断，正在确认结果');
  });

  it('reads styles per model, and plain style names as offered by every model', () => {
    const config = parseImageConfig({
      enabled: true,
      models: [{ model_id: 'm', name: 'M', price: '7300000000', original_price: 1 }],
      styles: ['a'],
      aspect_ratios: ['1:1'],
      max_count: 9,
      config_version: 'v',
    });
    expect(config.models[0]).toMatchObject({ price: 7300000000, originalPrice: 1 });
    expect(config.styles).toEqual([{ id: 'a', name: 'a', modelIds: null }]);
    expect(config.maxCount).toBe(4);
    const unknownPrice = parseImageConfig({ models: [{ model_id: 'm', price: -1 }] });
    expect(unknownPrice.models[0].price).toBeNull();
    expect(unknownPrice.enabled).toBe(false);
  });
});
