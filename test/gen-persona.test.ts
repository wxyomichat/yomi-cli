import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import jpeg from 'jpeg-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { encodeBody, type Json } from '../src/core/json.js';
import {
  AVATAR_POLL,
  avatarTaskBody,
  batchBody,
  createPersonaBody,
  updateAvatarBody,
} from '../src/gen/persona.js';
import type { MockPersonaState } from '../src/mock/gen/persona.js';
import { type MockServer, startMockServer } from '../src/mock/server.js';
import { memoryIo } from './helpers/io.js';
import { solidPng } from './helpers/png.js';

/**
 * `yomi persona list | avatar` end to end against the mock gateway: the persona table, the price
 * and balance before anything is charged, refusals that send nothing, per-image outcomes and
 * refunds, an unknown answer resumed with the same request ID (a refused or conflicting replay
 * keeps it), the charge left to the wallet after a replay at another price, reference uploads and
 * unusable reference paths, writing the picked image to a persona, and a new persona whose
 * creation had a lost answer. Downloads go to temporary directories.
 */

let mock: MockServer;
let dir: string;
const saved: Record<string, string | undefined> = {};
const POLL = { ...AVATAR_POLL };
const CURRENT = '7300000000000009201';

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}

const personaState = () => mock.gen.persona as MockPersonaState;
const calls = (path: string) => mock.state.requests.filter((request) => request.path === path);
const creates = () => calls('user/create_conversation_persona_avatar_task');
const outDir = () => mkdtempSync(join(tmpdir(), 'yomi-persona-out-'));

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

/** `persona avatar` with a prompt and a fresh download directory. */
async function generate(extra: string[], options: Parameters<typeof memoryIo>[0] = {}) {
  const out = outDir();
  const result = await run(
    ['persona', 'avatar', '-p', '  海边的旅人，温柔的笑  ', '--out', out, ...extra],
    options,
  );
  return { ...result, dir: out };
}

const requestIdOf = (text: string) => text.match(/--resume ([0-9a-f-]{36})/)?.[1] ?? '';

beforeAll(async () => {
  mock = await startMockServer();
  dir = mkdtempSync(join(tmpdir(), 'yomi-cli-persona-'));
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
  await authorizeLikeTheBrowser(url);
  expect(await pending).toBe(0);
});

beforeEach(() => {
  mock.state.gems = 100;
  const state = personaState();
  state.plan = [];
  state.pollsToFinish = 1;
  state.loseNextAnswer = false;
  state.refuseNext = null;
  state.refuseAtDoor = null;
  state.createFailure = null;
  state.unlimited = false;
  state.uploadMode = 'put';
  Object.assign(AVATAR_POLL, POLL);
});

afterAll(async () => {
  Object.assign(AVATAR_POLL, POLL);
  await mock.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('yomi persona', () => {
  it('writes i64 IDs bare and keeps the frozen create body in order', () => {
    expect(encodeBody(batchBody(['7300000000000000123', '9007199254740993']))).toBe(
      '{"media_task_ids":[7300000000000000123,9007199254740993]}',
    );
    expect(encodeBody(updateAvatarBody(CURRENT, '9007199254740993'))).toBe(
      `{"persona_id":${CURRENT},"patch":{"avatar_media_asset_id":9007199254740993}}`,
    );
    expect(
      encodeBody(createPersonaBody({ name: '晚星', gender: 2, age: 22 }, '7300000000000000999')),
    ).toBe(
      '{"input":{"name":"晚星","gender":2,"age":22,"description":"","avatar_media_asset_id":7300000000000000999}}',
    );
    expect(
      avatarTaskBody({ prompt: 'p', model_id: 'm', image_cnt: 2, style_id: 's' }, 'id-1'),
    ).toBe('{"client_request_id":"id-1","prompt":"p","model_id":"m","image_cnt":2,"style_id":"s"}');
  });

  it('lists the personas as a table and as JSON', async () => {
    const table = await run(['persona', 'list']);
    expect(table.code).toBe(0);
    expect(table.out).toContain('你的人设（主控）：共 1 个（最多 3 个，还可以新建）');
    expect(table.out).toMatch(
      new RegExp(`${CURRENT}\\s+旅人\\s+男\\s+24\\s+默认头像\\s+当前·默认`),
    );
    const json = await run(['persona', 'list', '--json']);
    const parsed = JSON.parse(json.out);
    expect(parsed).toMatchObject({
      current_persona_id: CURRENT,
      default_persona_id: CURRENT,
      total_cnt: 1,
      rules: { can_create: true, unlimited: false, max_persona_cnt: 3 },
    });
    expect(parsed.personas[0]).toMatchObject({
      persona_id: CURRENT,
      name: '旅人',
      gender: 'male',
      age: 24,
      is_current: true,
      is_default: true,
    });
  });

  it('shows models, prices and styles without charging', async () => {
    const text = await run(['persona', 'avatar', '--options']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('persona-standard  标准  3 钻石/张（默认）');
    expect(text.out).toContain('persona-lite  轻量  免费');
    expect(text.out).toContain('anime  动漫');
    expect(text.out).toContain('每次最多 4 张');
    const json = JSON.parse((await run(['persona', 'avatar', '--options', '--json'])).out);
    expect(json.models).toEqual([
      { model_id: 'persona-standard', display_name: '标准', price_diamonds: 3, default: true },
      { model_id: 'persona-lite', display_name: '轻量', price_diamonds: 0, default: false },
    ]);
    expect(json.max_image_cnt).toBe(4);
    expect(creates()).toHaveLength(0);
  });

  it('shows the price and the balance, and sends nothing without --accept-price', async () => {
    const result = await generate([]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('生成 4 张人设头像：共 12 钻石（3 钻石/张 × 4）');
    expect(result.out).toContain('按成功的张数扣钻石');
    expect(result.out).toContain('当前余额 100 钻石');
    expect(result.out).toContain(`选中的图片会写进：当前使用的人设「旅人」（${CURRENT}）`);
    expect(result.err).toContain('--accept-price');
    expect(result.out).toContain('没有发出生成请求');
    expect(creates()).toHaveLength(0);
    expect(mock.state.gems).toBe(100);
  });

  it('checks the balance first: too few gems sends nothing', async () => {
    mock.state.gems = 5;
    const result = await generate(['--accept-price']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('钻石不足（还差 7）');
    expect(creates()).toHaveLength(0);
    expect(mock.state.gems).toBe(5);
  });

  it('checks where the image goes before spending', async () => {
    const unknown = await generate(['--accept-price', '--persona', '7300000000000000001']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('没有 ID 为 7300000000000000001 的人设');
    const mixed = await generate(['--accept-price', '--name', '晚星']);
    expect(mixed.err).toContain('--name / --gender / --age 只在 --new 新建人设时使用');
    const gender = await generate([
      '--accept-price',
      '--new',
      '--name',
      '晚星',
      '--age',
      '22',
      '--gender',
      'constructor',
    ]);
    expect(gender.err).toContain('--new 需要 --gender');
    const long = await run(['persona', 'avatar', '-p', 'x'.repeat(501), '--accept-price']);
    expect(long.err).toContain('描述最多 500 个字');
    expect(creates()).toHaveLength(0);
  });

  it('generates, downloads every success and writes the picked one to the current persona', async () => {
    const result = await generate(['--count', '2', '--pick', '2', '--accept-price']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const [create] = creates().slice(-1);
    expect(create.body).toMatchObject({
      prompt: '海边的旅人，温柔的笑',
      model_id: 'persona-standard',
      image_cnt: 2,
    });
    expect(create.body.client_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.body).not.toHaveProperty('style_id');
    expect(create.body).not.toHaveProperty('source_image_object_key');
    const files = readdirSync(result.dir).sort();
    expect(files).toHaveLength(2);
    for (const file of files)
      expect(readFileSync(join(result.dir, file)).subarray(1, 4).toString()).toBe('PNG');
    expect(result.out).toMatch(/第 1 张：✓ 成功 {2}\S+persona-avatar-\w{8}-1\.png/);
    expect(result.out).toContain('按成功的 2 张计费：6 钻石（3 钻石/张）');
    expect(result.out).toContain(`✓ 已把第 2 张设为人设「旅人」（${CURRENT}）的头像`);
    expect(mock.state.gems).toBe(94);
    const [poll] = calls('user/batch_get_conversation_persona_avatar_tasks').slice(-1);
    const taskIds = poll.body.media_task_ids as string[];
    expect(taskIds).toHaveLength(2);
    const [update] = calls('user/update_conversation_persona').slice(-1);
    const second = personaState().tasks.get(taskIds[1])!;
    expect(update.body).toEqual({
      persona_id: CURRENT,
      patch: { avatar_media_asset_id: second.assetId },
    });
    const list = await run(['persona', 'list']);
    expect(list.out).toMatch(new RegExp(`${CURRENT}\\s+旅人.*AI 生成`));
  });

  it('reports failed and rejected images and charges only the successes', async () => {
    personaState().plan = ['ok', 'fail', 'sensitive'];
    const ledger = personaState().ledger.length;
    const result = await generate(['--count', '3', '--accept-price']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('第 2 张：✗ 生成失败（生成失败，请换个描述再试），这张不计费');
    expect(result.out).toContain('第 3 张：✗ 没有通过内容检查，这张不计费');
    expect(result.out).toContain('共 3 张：成功 1，生成失败 1，没有通过内容检查 1。');
    expect(result.out).toContain('按成功的 1 张计费：3 钻石');
    expect(readdirSync(result.dir)).toHaveLength(1);
    // Held for three, refunded the two that did not succeed.
    expect(mock.state.gems).toBe(97);
    expect(
      personaState()
        .ledger.slice(ledger)
        .map((entry) => entry.amount),
    ).toEqual([-3, -3, -3, 3, 3]);
    // Without a terminal and --pick, nothing is written; it says how.
    const id = requestIdOf(result.out);
    expect(result.out).toContain(
      `选一张写进人设：yomi persona avatar --resume ${id} --pick <编号>`,
    );
    expect(calls('user/update_conversation_persona')).toHaveLength(1);
  });

  it('never offers a success that came without its asset', async () => {
    personaState().plan = ['incomplete'];
    const result = await generate(['--count', '1', '--pick', '1', '--accept-price']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('第 1 张：✗ 服务端标为成功但没有返回可用的图片');
    expect(result.err).toContain('第 1 张不能用作头像');
    expect(readdirSync(result.dir)).toHaveLength(0);
  });

  it('keeps an unknown answer and resumes it with the same request ID, charging once', async () => {
    personaState().loseNextAnswer = true;
    const before = creates().length;
    const first = await generate(['--count', '2', '--accept-price']);
    expect(first.code).toBe(1);
    expect(first.err).toContain('生成请求的结果未知');
    expect(first.err).toContain('不会自动重发');
    const id = requestIdOf(first.out);
    expect(id).not.toBe('');
    // The server took it and held the gems; the CLI does not know.
    expect(mock.state.gems).toBe(94);
    // The same command again does not send a new request.
    const again = await generate(['--count', '2', '--accept-price']);
    expect(again.code).toBe(1);
    expect(again.err).toContain(`同样的请求上次结果未知（请求号 ${id}）`);
    expect(creates()).toHaveLength(before + 1);
    // --resume replays the same ID and body: the server answers the same tasks, no new charge.
    const resumed = await run([
      'persona',
      'avatar',
      '--resume',
      id,
      '--pick',
      '1',
      '--out',
      first.dir,
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('原样重发（同一个请求号、同一个请求体）');
    expect(resumed.out).toContain('服务端已受理（同一个请求号）：2 张');
    const replays = creates().slice(before);
    expect(replays).toHaveLength(2);
    expect(replays[1].body).toEqual(replays[0].body);
    expect(replays[1].body.client_request_id).toBe(id);
    expect(mock.state.gems).toBe(94);
    expect(resumed.out).toContain('✓ 已把第 1 张设为人设「旅人」');
    expect(readdirSync(first.dir)).toHaveLength(2);
  });

  it('asks again before a replay when the price went up since it was agreed', async () => {
    const model = personaState().models[0];
    try {
      // The answer is lost before the server takes it: nothing created, nothing charged.
      personaState().refuseNext = { code: 500, message: 'internal error' };
      const first = await generate(['--count', '2', '--accept-price']);
      expect(first.err).toContain('生成请求的结果未知');
      const id = requestIdOf(first.out);
      expect(mock.state.gems).toBe(100);
      model.price_diamonds = 10;
      const sent = creates().length;
      const held = await run(['persona', 'avatar', '--resume', id, '--out', first.dir]);
      expect(held.code).toBe(1);
      expect(held.err).toContain('单价从 3 变成了 10 钻石/张');
      expect(held.out).toContain('重发生成 2 张人设头像：共 20 钻石（10 钻石/张 × 2）');
      expect(held.err).toContain('--accept-price');
      expect(creates()).toHaveLength(sent);
      expect(mock.state.gems).toBe(100);
      // Still kept: agreeing to the new price replays the same ID.
      const agreed = await run([
        'persona',
        'avatar',
        '--resume',
        id,
        '--accept-price',
        '--out',
        first.dir,
      ]);
      expect(agreed.code).toBe(0);
      expect(creates()).toHaveLength(sent + 1);
      expect(creates().slice(-1)[0].body.client_request_id).toBe(id);
      expect(mock.state.gems).toBe(80);
      // Sent at 3, replayed at 10: which applies is the wallet's to say, not the old price.
      expect(agreed.out).not.toContain('计费：6 钻石');
      expect(agreed.out).toContain('单价不确定：这个请求先后在 3 和 10 钻石/张时发出');
      expect(agreed.out).toContain('实际扣了多少以钱包记录为准');
      // Still so on a later look, and in the JSON.
      const later = await run(['persona', 'avatar', '--resume', id, '--json', '--out', first.dir]);
      expect(later.code).toBe(0);
      expect(JSON.parse(later.out)).toMatchObject({
        status: 'done',
        unit_price_diamonds: null,
        charged_diamonds: null,
        possible_unit_prices_diamonds: [3, 10],
      });
      expect(creates()).toHaveLength(sent + 1);
    } finally {
      model.price_diamonds = 3;
    }
  });

  it('treats a refusal as uncharged and forgets its request ID', async () => {
    personaState().refuseNext = { code: 400, message: 'prompt rejected' };
    const refused = await generate(['--count', '1', '--accept-price', '--json']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('服务端拒绝了这次生成（400：prompt rejected）。这次没有扣费。');
    const json = JSON.parse(refused.out);
    expect(json).toMatchObject({ status: 'refused', reason: 'rejected', code: '400' });
    expect(mock.state.gems).toBe(100);
    personaState().refuseNext = { code: 1503021061, message: 'insufficient gems' };
    const short = await generate(['--count', '1', '--accept-price']);
    expect(short.err).toContain('钻石不足，请先在 Yomi App 或网页充值。这次没有扣费。');
    // The same request again is a new one, with a new ID.
    const ok = await generate(['--count', '1', '--accept-price']);
    expect(ok.code).toBe(0);
    const ids = creates()
      .slice(-3)
      .map((request) => request.body.client_request_id);
    expect(new Set(ids).size).toBe(3);
  });

  it('uploads a reference photo the way the ticket asks (PUT or form POST)', async () => {
    const photo = join(outDir(), 'me.png');
    writeFileSync(photo, solidPng(600, 1000, [10, 20, 30]));
    for (const mode of ['put', 'form'] as const) {
      personaState().uploadMode = mode;
      const result = await generate(['--count', '1', '--accept-price', '--reference', photo]);
      expect(result.code).toBe(0);
      const [ticket] = calls('user/create_image_upload').slice(-1);
      expect(ticket.body).toMatchObject({ image_type: 3, content_type: 'image/jpeg' });
      const [create] = creates().slice(-1);
      const key = create.body.source_image_object_key as string;
      expect(key).toMatch(/^user\/persona\//);
      const blob = mock.blobs.get(key)!;
      expect(blob.method).toBe(mode === 'put' ? 'PUT' : 'POST');
      expect(blob.headers['x-token']).toBeUndefined();
      expect(blob.bytes.length).toBe(ticket.body.size_bytes);
      if (mode === 'form') expect(blob.fields).toMatchObject({ key, signature: 'mock-signature' });
      else expect(blob.contentType).toBe('image/jpeg');
      // Cropped to 3:4 around the centre, at most 1024 px high, JPEG.
      const image = jpeg.decode(blob.bytes);
      expect([image.width, image.height]).toEqual([600, 800]);
    }
  });

  it('creates a new persona with the picked avatar', async () => {
    const result = await generate([
      '--count',
      '1',
      '--pick',
      '1',
      '--accept-price',
      '--new',
      '--name',
      '晚星',
      '--gender',
      'female',
      '--age',
      '22',
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('选中的图片会写进：新人设「晚星」（女，22 岁）');
    expect(result.out).toMatch(/✓ 已新建人设「晚星」（\d{19}），头像用第 1 张/);
    const [created] = calls('user/create_conversation_persona').slice(-1);
    const input = created.body.input as Json;
    expect(input).toMatchObject({ name: '晚星', gender: 2, age: 22, description: '' });
    expect(input.avatar_media_asset_id).toMatch(/^\d{19}$/);
    expect(input).not.toHaveProperty('avatar_object_key');
    const list = JSON.parse((await run(['persona', 'list', '--json'])).out);
    const star = list.personas.find((item: Json) => item.name === '晚星');
    expect(star).toMatchObject({
      gender: 'female',
      age: 22,
      is_current: false,
      avatar_media_asset_id: input.avatar_media_asset_id,
    });
  });

  it('prints one JSON object for scripts', async () => {
    const result = await generate(['--count', '2', '--pick', '1', '--accept-price', '--json']);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({
      status: 'done',
      model_id: 'persona-standard',
      style_id: null,
      image_cnt: 2,
      unit_price_diamonds: 3,
      charged_diamonds: 6,
      applied: { persona_id: CURRENT, created: false, index: 1 },
    });
    expect(json.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.outputs).toHaveLength(2);
    for (const output of json.outputs) {
      expect(output.status).toBe('succeeded');
      expect(output.media_asset_id).toMatch(/^\d{19}$/);
      expect(existsSync(output.file)).toBe(true);
    }
    // The human lines went to stderr.
    expect(result.err).toContain('当前余额');
  });

  it('asks for yes and for the image when someone is at the terminal', async () => {
    const out = outDir();
    const terminal = memoryIo({ interactive: true });
    process.exitCode = undefined;
    const pending = main(
      [
        'persona',
        'avatar',
        '-p',
        '晨光里的读书人',
        '--count',
        '2',
        '--style',
        'anime',
        '--out',
        out,
      ],
      terminal.io,
    );
    await terminal.waitFor(/输入 yes 继续：/);
    terminal.stdin.write('yes\n');
    await terminal.waitFor(/输入编号（1\/2；直接回车跳过）：/);
    terminal.stdin.write('2\n');
    expect(await pending).toBe(0);
    expect(terminal.out).toContain('风格：动漫');
    expect(terminal.out).toContain('✓ 已把第 2 张设为人设「旅人」');
    expect(creates().slice(-1)[0].body.style_id).toBe('anime');
  });

  it('stops polling after its rounds without cancelling, then resumes without charging', async () => {
    personaState().pollsToFinish = 100;
    Object.assign(AVATAR_POLL, { intervalMs: 5, maxRounds: 3 });
    const first = await generate(['--count', '2', '--accept-price']);
    expect(first.code).toBe(1);
    expect(first.out).toContain('第 1 张：… 还在生成');
    expect(first.out).toContain('停止查看不会取消服务端的生成');
    const id = requestIdOf(first.out);
    expect(mock.state.gems).toBe(94);
    const sent = creates().length;
    personaState().pollsToFinish = 1;
    const resumed = await run([
      'persona',
      'avatar',
      '--resume',
      id,
      '--pick',
      '2',
      '--persona',
      CURRENT,
      '--out',
      first.dir,
      '--json',
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.err).toContain('不会再扣费');
    const json = JSON.parse(resumed.out);
    expect(json).toMatchObject({ status: 'done', request_id: id, charged_diamonds: 6 });
    expect(json.applied).toMatchObject({ persona_id: CURRENT, index: 2 });
    expect(creates()).toHaveLength(sent);
    expect(mock.state.gems).toBe(94);
    expect(readdirSync(first.dir)).toHaveLength(2);
  });

  it('keeps the run when a replay is refused, and resumes it later charging once', async () => {
    personaState().loseNextAnswer = true;
    const before = creates().length;
    const first = await generate(['--count', '2', '--accept-price']);
    expect(first.err).toContain('生成请求的结果未知');
    const id = requestIdOf(first.out);
    // Accepted and charged; the answer was lost.
    expect(mock.state.gems).toBe(94);
    // A refusal of the replay (here at the door, before the request ID is looked up) does not
    // prove the first send was turned away: nothing is forgotten.
    personaState().refuseAtDoor = { code: 1503021061, message: 'insufficient gems' };
    const short = await run(['persona', 'avatar', '--resume', id, '--out', first.dir]);
    expect(short.code).toBe(1);
    expect(short.err).toContain('这次重发被拒了：钻石不足（1503021061：insufficient gems）');
    expect(short.err).toContain(`本机没有删除这次生成：记录和请求号 ${id} 都还在`);
    expect(short.err).not.toContain('这次没有扣费。');
    expect(short.out).toContain(`充值后再试：yomi persona avatar --resume ${id}`);
    personaState().refuseAtDoor = { code: 429, message: 'too many requests' };
    const busy = await run(['persona', 'avatar', '--resume', id, '--json', '--out', first.dir]);
    expect(busy.code).toBe(1);
    expect(JSON.parse(busy.out)).toEqual({
      status: 'unknown',
      request_id: id,
      replay_refusal: { reason: 'rateLimited', code: '429' },
      resume: `yomi persona avatar --resume ${id}`,
    });
    expect(busy.err).toContain('过一会儿再试');
    // The same request is still held back from a new ID.
    const again = await generate(['--count', '2', '--accept-price']);
    expect(again.err).toContain(`同样的请求上次结果未知（请求号 ${id}）`);
    // The next replay gets the tasks the first send made: one charge in all.
    const resumed = await run(['persona', 'avatar', '--resume', id, '--out', first.dir]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('服务端已受理（同一个请求号）：2 张');
    expect(resumed.out).toContain('按成功的 2 张计费：6 钻石（3 钻石/张）');
    const sent = creates().slice(before);
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((request) => request.body.client_request_id))).toEqual(new Set([id]));
    expect(mock.state.gems).toBe(94);
  });

  it('treats a 409 on its own request ID as unknown, not as a refusal', async () => {
    const before = creates().length;
    personaState().refuseNext = {
      code: 409,
      message: 'client_request_id was used for another request',
    };
    const first = await generate(['--count', '1', '--accept-price', '--json']);
    expect(first.code).toBe(1);
    const id = JSON.parse(first.out).request_id as string;
    expect(JSON.parse(first.out)).toEqual({
      status: 'unknown',
      request_id: id,
      reason: 'request_id_conflict',
      resume: `yomi persona avatar --resume ${id}`,
    });
    expect(first.err).not.toContain('服务端拒绝了这次生成');
    expect(first.err).toContain(`服务端说请求号 ${id} 已经用在了另一个请求体上`);
    expect(first.err).toContain('本机仍保留这次生成的记录和请求号');
    // A replay answered 409 too stays unknown and kept.
    personaState().refuseAtDoor = { code: 409, message: 'client_request_id conflict' };
    const replay = await run(['persona', 'avatar', '--resume', id, '--out', first.dir]);
    expect(replay.code).toBe(1);
    expect(replay.err).toContain('生成请求的结果未知（409：client_request_id conflict）');
    expect(replay.err).not.toContain('这次重发被拒了');
    const resumed = await run(['persona', 'avatar', '--resume', id, '--out', first.dir]);
    expect(resumed.code).toBe(0);
    expect(
      creates()
        .slice(before)
        .map((request) => request.body.client_request_id),
    ).toEqual([id, id, id]);
    expect(mock.state.gems).toBe(97);
  });

  it('refuses a reference that is a folder or cannot be read, before sending anything', async () => {
    const folder = join(outDir(), 'photos');
    mkdirSync(folder);
    const sent = mock.state.requests.length;
    const dirResult = await generate(['--accept-price', '--reference', folder]);
    expect(dirResult.code).toBe(1);
    expect(dirResult.err).toContain(`--reference 要指向一张图片，${folder} 是文件夹`);
    const missing = await generate(['--accept-price', '--reference', join(folder, 'none.png')]);
    expect(missing.err).toContain('找不到参考图');
    const empty = join(folder, 'empty.png');
    writeFileSync(empty, '');
    expect((await generate(['--accept-price', '--reference', empty])).err).toContain(
      `参考图是空文件：${empty}`,
    );
    // Root reads anything: the permission case only means something for an ordinary user.
    if (process.getuid?.() !== 0) {
      const locked = join(folder, 'locked.png');
      writeFileSync(locked, solidPng(30, 40, [1, 2, 3]));
      chmodSync(locked, 0o000);
      try {
        const result = await generate(['--accept-price', '--reference', locked]);
        expect(result.code).toBe(1);
        expect(result.err).toContain(`参考图读不出来：${locked}（没有读取权限）`);
      } finally {
        chmodSync(locked, 0o600);
      }
    }
    expect(mock.state.requests.length).toBe(sent);
  });

  it('finds a new persona whose creation lost its answer instead of creating it twice', async () => {
    personaState().unlimited = true;
    personaState().createFailure = 'lost';
    const newPersona = ['--new', '--name', '晨星', '--gender', 'female', '--age', '30'];
    const first = await generate(['--count', '2', '--pick', '1', '--accept-price', ...newPersona]);
    expect(first.code).toBe(1);
    expect(first.err).toContain(
      '新建人设的结果未知（500：answer lost after the persona was created）',
    );
    expect(first.out).toContain('先运行 yomi persona list 看看：已经有「晨星」就不要再新建');
    const id = requestIdOf(first.out);
    const createCalls = calls('user/create_conversation_persona').length;
    const listed = await run(['persona', 'list']);
    expect(listed.out).toMatch(/晨星\s+女\s+30\s+AI 生成/);
    expect(listed.out).toContain(
      `本机记着一次结果未知的新建：人设「晨星」（头像用请求 ${id} 的第 1 张）`,
    );
    // The list shows it with the avatar sent: recorded as created, nothing sent again.
    const resumed = await run(['persona', 'avatar', '--resume', id, '--pick', '1', '--json']);
    expect(resumed.code).toBe(0);
    expect(resumed.err).toMatch(
      /✓ 上次新建的人设「晨星」（\d{19}）已经建好了，头像是第 1 张，没有再建/,
    );
    expect(JSON.parse(resumed.out).applied).toMatchObject({ created: true, index: 1 });
    expect(calls('user/create_conversation_persona')).toHaveLength(createCalls);
    const personas = JSON.parse((await run(['persona', 'list', '--json'])).out).personas as Json[];
    expect(personas.filter((item) => item.name === '晨星')).toHaveLength(1);
    expect((await run(['persona', 'list'])).out).not.toContain('结果未知的新建');
    // A second try now says it was already created.
    const twice = await run(['persona', 'avatar', '--resume', id, '--pick', '2']);
    expect(twice.err).toContain('这次生成已经新建过人设');
    expect(calls('user/create_conversation_persona')).toHaveLength(createCalls);
  });

  it('creates a persona again only after a typed yes or --create-again', async () => {
    personaState().unlimited = true;
    personaState().createFailure = 'before';
    const newPersona = ['--new', '--name', '朝露', '--gender', 'other', '--age', '28'];
    const first = await generate(['--count', '1', '--pick', '1', '--accept-price', ...newPersona]);
    expect(first.err).toContain('新建人设的结果未知');
    const id = requestIdOf(first.out);
    const createCalls = () => calls('user/create_conversation_persona').length;
    const sent = createCalls();
    // Nobody to type yes: it explains and creates nothing.
    const held = await run(['persona', 'avatar', '--resume', id, '--pick', '1']);
    expect(held.code).toBe(1);
    expect(held.err).toContain(
      '上次新建人设「朝露」时结果未知，可能已经建好了（人设列表里暂时没有看到它）',
    );
    expect(held.out).toContain('先运行 yomi persona list 看看');
    expect(held.err).toContain('加 --create-again（非交互运行时代替输入 yes）。这次没有新建人设。');
    expect(createCalls()).toBe(sent);
    // At a terminal: anything but yes creates nothing.
    const ask = async (answer: string) => {
      const terminal = memoryIo({ interactive: true });
      process.exitCode = undefined;
      const pending = main(['persona', 'avatar', '--resume', id, '--pick', '1'], terminal.io);
      await terminal.waitFor(/确认没有「朝露」，要再新建一次？输入 yes 继续：/);
      terminal.stdin.write(answer + '\n');
      return { code: await pending, out: terminal.out };
    };
    const declined = await ask('no');
    expect(declined.code).toBe(1);
    expect(declined.out).toContain('没有新建人设。');
    expect(createCalls()).toBe(sent);
    const agreed = await ask('yes');
    expect(agreed.code).toBe(0);
    expect(agreed.out).toMatch(/✓ 已新建人设「朝露」（\d{19}），头像用第 1 张/);
    expect(createCalls()).toBe(sent + 1);

    // `--create-again` (the option this command takes for scripts) stands for the yes.
    personaState().createFailure = 'before';
    const second = await generate(['--count', '1', '--pick', '1', '--accept-price', ...newPersona]);
    const secondId = requestIdOf(second.out);
    const out = outDir();
    const scripted = await run([
      'persona',
      'avatar',
      '--resume',
      secondId,
      '--pick',
      '1',
      '--out',
      out,
      '--create-again',
    ]);
    expect(scripted.code).toBe(0);
    expect(scripted.out).toContain('已加 --create-again');
    expect(scripted.out).toMatch(/✓ 已新建人设「朝露」（\d{19}）/);
    expect(createCalls()).toBe(sent + 3);
  });
});
