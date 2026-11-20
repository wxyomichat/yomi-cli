import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VERSION } from '../src/core/version.js';
import { startMockWechat, type MockWechat } from '../src/mock/wechat.js';
import { splitText, WechatChannel, wechatSetup } from '../src/relay/channels/wechat.js';
import {
  parseCredentials,
  qrLogin,
  terminalRows,
  wechatScope,
} from '../src/relay/channels/wechat-login.js';
import { memoryIo } from './helpers/io.js';
import {
  baseInfo,
  clientVersion,
  isStaleToken,
  parseIlinkJson,
  trustedUrl,
  UntrustedHost,
  WECHAT_API,
  WechatApi,
  WechatError,
  WechatLoginApi,
  wechatOrigin,
} from '../src/relay/channels/wechat-api.js';
import {
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  imageItem,
  uploadImage,
} from '../src/relay/channels/wechat-media.js';
import { solidPngBytes } from '../src/mock/gen/png.js';

/**
 * The iLink client of the WeChat channel against the mock iLink (design §10.1, §10.4): the
 * protocol's headers and `base_info`, hosts from responses checked before anything is sent,
 * errors without tokens, -14 left to the caller, and pictures encrypted with AES-128-ECB and
 * PKCS#7 as the plugin uploads them. Nothing reaches the network.
 */

let wx: MockWechat;

/** A confirmed login on the mock: its bot token. */
async function login(mock: MockWechat): Promise<string> {
  const api = new WechatLoginApi(mock.origin);
  const code = await api.qrCode([]);
  mock.confirm();
  const status = await api.qrStatus(mock.origin, code.qrcode, '');
  expect(status.status).toBe('confirmed');
  return status.bot_token!;
}

const botApi = (mock: MockWechat, token: string) =>
  new WechatApi({
    baseUrl: mock.origin,
    botToken: token,
    cdnBaseUrl: `${mock.origin}/c2c`,
    loopback: true,
  });

beforeAll(async () => {
  wx = await startMockWechat({ longPollMs: 200 });
});

afterAll(async () => {
  await wx.close();
});

describe('the iLink protocol', () => {
  it('names plugin 2.4.10 and this CLI the way the protocol asks', () => {
    expect(clientVersion()).toBe('132106');
    expect(clientVersion('1.0.11')).toBe('65547');
    const info = baseInfo();
    expect(info.channel_version).toBe(`2.4.10/yomi-cli-${VERSION}`);
    // A bare name would be dropped and reported as OpenClaw: Name/Version.
    expect(info.bot_agent).toMatch(/^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/);
    expect(info.bot_agent).not.toContain('OpenClaw');
  });

  it('accepts only https qq.com hosts from responses, loopback only beside a loopback mock', () => {
    expect(trustedUrl('https://ilinkai.weixin.qq.com', 'baseurl', false)).toBe(
      'https://ilinkai.weixin.qq.com/',
    );
    expect(trustedUrl('ilinkai.weixin.qq.com', 'redirect_host', false)).toBe(
      'https://ilinkai.weixin.qq.com',
    );
    expect(
      trustedUrl('https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1', 'upload_full_url', false),
    ).toBe('https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1');
    for (const bad of [
      'http://ilinkai.weixin.qq.com',
      'https://evil.example',
      'https://weixin.qq.com.evil.example',
      'https://user@ilinkai.weixin.qq.com',
      'evil.example',
      '127.0.0.1:8080',
      'http://127.0.0.1:8080',
      '',
      undefined,
    ])
      expect(() => trustedUrl(bad, 'redirect_host', false), String(bad)).toThrow(UntrustedHost);
    expect(trustedUrl('127.0.0.1:8080', 'redirect_host', true)).toBe('http://127.0.0.1:8080');
    expect(() => trustedUrl('evil.example', 'redirect_host', true)).toThrow(UntrustedHost);
    try {
      trustedUrl('https://evil.example', 'baseurl', false);
    } catch (error) {
      expect((error as Error).message).toContain('baseurl');
    }
  });

  it('takes the API origin from the setting only when it is loopback', () => {
    expect(wechatOrigin(undefined)).toBe(WECHAT_API);
    expect(wechatOrigin(WECHAT_API)).toBe(WECHAT_API);
    expect(wechatOrigin('http://127.0.0.1:9/x')).toBe('http://127.0.0.1:9');
    expect(() => wechatOrigin('https://ilink.example')).toThrow(/ilinkai\.weixin\.qq\.com/);
    expect(() => wechatOrigin('not a url')).toThrow();
  });

  it('sends the headers and base_info of the protocol, and no token on the QR calls', async () => {
    const from = wx.calls.length;
    const token = await login(wx);
    const api = botApi(wx, token);
    wx.userSends('你好');
    const answer = await api.getUpdates('', 1000, new AbortController().signal);
    expect(answer.ret).toBe(0);
    expect(answer.msgs?.[0]).toMatchObject({
      message_type: 1,
      from_user_id: wx.owner,
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });
    expect(answer.get_updates_buf).toBeTruthy();
    const calls = wx.calls.slice(from);
    const qr = calls.find((call) => call.endpoint === 'get_bot_qrcode')!;
    expect(qr.body).toEqual({ local_token_list: [] });
    expect(qr.headers).toMatchObject({
      'content-type': 'application/json',
      authorizationtype: 'ilink_bot_token',
      'ilink-app-id': 'bot',
      'ilink-app-clientversion': '132106',
    });
    expect(qr.authorized).toBe(false);
    const status = calls.find((call) => call.endpoint === 'get_qrcode_status')!;
    expect(status.headers['ilink-app-id']).toBe('bot');
    expect(status.headers['x-wechat-uin']).toBeUndefined();
    const poll = calls.find((call) => call.endpoint === 'getupdates')!;
    expect(poll.authorized).toBe(true);
    expect(poll.headers).toMatchObject({
      authorizationtype: 'ilink_bot_token',
      'ilink-app-id': 'bot',
      'ilink-app-clientversion': '132106',
    });
    // Base64 of a uint32 in decimal, fresh per request.
    const uin = Buffer.from(poll.headers['x-wechat-uin'], 'base64').toString('utf8');
    expect(uin).toMatch(/^[0-9]{1,10}$/);
    expect(Number(uin)).toBeLessThan(2 ** 32);
    expect(poll.body).toMatchObject({ get_updates_buf: '', base_info: baseInfo() });
  });

  it('returns -14 to the caller, and refuses with codes and messages but never a token', async () => {
    const token = await login(wx);
    const api = botApi(wx, token);
    wx.expireSession(1);
    expect(await api.getUpdates('', 1000, new AbortController().signal)).toMatchObject({
      ret: -14,
      errcode: -14,
    });
    // An aborted poll is an empty batch with the same cursor, not an error.
    const controller = new AbortController();
    const pending = api.getUpdates('c3VyZQ', 5000, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ret: 0, msgs: [], get_updates_buf: 'c3VyZQ' });
    const refused = await api
      .sendMessage({
        to_user_id: wx.owner,
        client_id: 'yomi-x',
        context_token: 'ctx_secret_context_token',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WechatError);
    expect(refused).toMatchObject({ code: -2, status: 200, reason: 'other', channel: 'wechat' });
    expect(String((refused as Error).message)).not.toContain('ctx_secret');
    expect(String((refused as Error).message)).not.toContain(token);
    wx.revokeTokens();
    const revoked = await api.getConfig(wx.owner, '').catch((error: unknown) => error);
    expect(revoked).toMatchObject({ status: 401, refused: true, reason: 'unauthorized' });
    expect(String((revoked as Error).message)).not.toContain(token);
  });

  it("reads iLink's uint64 ids exactly and -14 in either field, as the plugin does", () => {
    const raw =
      '{"ret":0,"msgs":[{"seq":3,"message_id": 7300000000000000001,"item_list":[{"msg_id":7300000000000000003,' +
      '"text_item":{"text":"\\"message_id\\":7300000000000000005"}}]},{"message_id":7300000000000000002}]}';
    const parsed = parseIlinkJson(raw) as {
      msgs: {
        seq: number;
        message_id: string;
        item_list?: { msg_id: string; text_item: { text: string } }[];
      }[];
    };
    // As JS numbers both ids would be 7300000000000000000.
    expect(parsed.msgs.map((message) => message.message_id)).toEqual([
      '7300000000000000001',
      '7300000000000000002',
    ]);
    expect(parsed.msgs[0].seq).toBe(3);
    expect(parsed.msgs[0].item_list![0].msg_id).toBe('7300000000000000003');
    // Text inside a string is left alone.
    expect(parsed.msgs[0].item_list![0].text_item.text).toBe('"message_id":7300000000000000005');
    expect(parseIlinkJson('{"message_id":-1,"x":[1.5]}')).toEqual({ message_id: '-1', x: [1.5] });
    expect(isStaleToken({ ret: -14 })).toBe(true);
    expect(isStaleToken({ ret: -1, errcode: -14 })).toBe(true);
    expect(isStaleToken({ ret: -14, errcode: -2 })).toBe(true);
    expect(isStaleToken({ ret: 0, errcode: -2 })).toBe(false);
  });

  it('takes typing as sent on any 2xx (the answer is not parsed), and a failed QR poll as wait', async () => {
    let answer = new Response('', { status: 200 });
    const fetcher = (async () => answer) as unknown as typeof fetch;
    const api = new WechatApi({
      baseUrl: 'http://127.0.0.1:1',
      botToken: 'tok_x',
      cdnBaseUrl: 'http://127.0.0.1:1/c2c',
      loopback: true,
      fetch: fetcher,
    });
    await expect(api.sendTyping('o@im.wechat', 'tk', 1)).resolves.toBeUndefined();
    answer = new Response('busy', { status: 503 });
    await expect(api.sendTyping('o@im.wechat', 'tk', 2)).rejects.toMatchObject({ code: 503 });
    const login = new WechatLoginApi('http://127.0.0.1:1', fetcher);
    for (const failure of [
      new Response('{"errmsg":"no"}', { status: 400 }),
      new Response('{"ret":-1,"errmsg":"no"}', { status: 200 }),
    ]) {
      answer = failure;
      expect(await login.qrStatus('http://127.0.0.1:1', 'qr', '')).toEqual({
        status: 'wait',
        failed: true,
      });
    }
  });

  it('cuts text at a line break or a space within the limit', () => {
    expect(splitText('short', 10)).toEqual(['short']);
    expect(splitText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc']);
    expect(splitText('line one\nline two', 12)).toEqual(['line one', 'line two']);
    expect(splitText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    // Never between the halves of a surrogate pair.
    const emoji = '😀'.repeat(6);
    for (const piece of splitText(emoji, 5)) expect(piece).not.toMatch(/^[\uDC00-\uDFFF]/);
  });
});

describe('pictures', () => {
  it('encrypts with AES-128-ECB and PKCS#7: the ciphertext size is what getuploadurl is told', () => {
    const key = Buffer.alloc(16, 7);
    for (const size of [0, 1, 15, 16, 17, 1000]) {
      const plain = Buffer.alloc(size, 3);
      const cipher = encryptAesEcb(plain, key);
      expect(cipher.length).toBe(aesEcbPaddedSize(size));
      expect(cipher.length % 16).toBe(0);
      expect(cipher.length).toBeGreaterThan(size);
      expect(decryptAesEcb(cipher, key).equals(plain)).toBe(true);
    }
    expect(aesEcbPaddedSize(16)).toBe(32);
  });

  it('uploads the encrypted picture and names it the way the plugin does', async () => {
    const token = await login(wx);
    const api = botApi(wx, token);
    const bytes = solidPngBytes(40, 30, [10, 120, 200]);
    const uploaded = await uploadImage(api, wx.owner, {
      bytes,
      mime: 'image/png',
      name: 'a.png',
    });
    const upload = wx.uploads.at(-1)!;
    expect(upload).toMatchObject({
      media_type: 1,
      to_user_id: wx.owner,
      rawsize: bytes.length,
      filesize: aesEcbPaddedSize(bytes.length),
      received: aesEcbPaddedSize(bytes.length),
      no_need_thumb: true,
      aeskey: uploaded.aesKeyHex,
    });
    expect(upload.plain!.equals(bytes)).toBe(true);
    expect(uploaded.cipherSize).toBe(upload.filesize);
    const item = imageItem(uploaded);
    expect(item).toEqual({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.encryptQueryParam,
          aes_key: Buffer.from(uploaded.aesKeyHex).toString('base64'),
          encrypt_type: 1,
        },
        mid_size: upload.filesize,
      },
    });
    // The CDN once fails with a 500: tried again. A 4xx: given up at once.
    wx.failNext('cdn', { status: 500 });
    const cdn = () => wx.calls.filter((call) => call.endpoint === 'cdn').length;
    const before = cdn();
    await uploadImage(api, wx.owner, { bytes, mime: 'image/png', name: 'a.png' });
    expect(cdn()).toBe(before + 2);
    wx.failNext('cdn', { status: 413 });
    await expect(
      uploadImage(api, wx.owner, { bytes, mime: 'image/png', name: 'a.png' }),
    ).rejects.toMatchObject({ code: 413 });
    expect(cdn()).toBe(before + 3);
    // An upload URL that is not WeChat's is never used.
    expect(() =>
      api.uploadUrl({ upload_full_url: 'https://evil.example/upload' }, 'f'.repeat(32)),
    ).toThrow(UntrustedHost);
  });

  it('builds the CDN URL from upload_param and the filekey when no full URL is given', async () => {
    const mock = await startMockWechat({ uploadParamOnly: true });
    try {
      const token = await login(mock);
      const api = botApi(mock, token);
      expect(api.uploadUrl({ upload_param: 'p&q' }, 'abc')).toBe(
        `${mock.origin}/c2c/upload?encrypted_query_param=p%26q&filekey=abc`,
      );
      const bytes = solidPngBytes(8, 8, [0, 0, 0]);
      await uploadImage(api, mock.owner, { bytes, mime: 'image/png', name: 'b.png' });
      expect(mock.uploads[0].plain!.equals(bytes)).toBe(true);
    } finally {
      await mock.close();
    }
  });
});

describe('the saved login', () => {
  const credentials = {
    botToken: 'tok_saved',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    ilinkBotId: 'b@im.bot',
    ilinkUserId: 'o@im.wechat',
    savedAt: 1,
  };

  it('is keyed by the scanner: scope, lock and service words', () => {
    const secret = JSON.stringify(credentials);
    expect(parseCredentials(secret)).toEqual(credentials);
    expect(parseCredentials('{"botToken":"x"}')).toBeNull();
    expect(parseCredentials('not json')).toBeNull();
    const channel = new WechatChannel(credentials);
    expect(channel.scope).toBe(wechatScope('o@im.wechat'));
    expect(channel.scope).toMatch(/^wx:[0-9a-f]{16}$/);
    expect(channel.lockName).toBe(`wx-${channel.scope.slice(3)}`);
    expect(wechatSetup.storedBot(secret)?.lockName).toBe(channel.lockName);
    // Another bot of the same scanner: the same relay state, for a login of before the registry.
    expect(new WechatChannel({ ...credentials, ilinkBotId: 'other@im.bot' }).scope).toBe(
      channel.scope,
    );
    // A ClawBot added under the registry has its record's own.
    const own = new WechatChannel(credentials, {
      place: { scope: 'bot:0123456789ab', lockName: 'bot-0123456789ab' },
    });
    expect([own.scope, own.lockName]).toEqual(['bot:0123456789ab', 'bot-0123456789ab']);
    expect(channel.caps).toMatchObject({ maxText: 2000, quotes: false, pairing: 'login' });
  });

  it("is never used with a host that is not WeChat's: nothing is sent", () => {
    const fetches: string[] = [];
    const fetcher = (async (url: string) => {
      fetches.push(url);
      return new Response('{}');
    }) as unknown as typeof fetch;
    for (const baseUrl of ['https://ilink.evil.example', 'http://ilinkai.weixin.qq.com'])
      expect(() => new WechatChannel({ ...credentials, baseUrl }, { fetch: fetcher })).toThrow(
        UntrustedHost,
      );
    // A loopback baseurl only beside a loopback API origin (a test's mock).
    expect(
      () =>
        new WechatChannel({ ...credentials, baseUrl: 'http://127.0.0.1:1' }, { fetch: fetcher }),
    ).toThrow(UntrustedHost);
    expect(
      new WechatChannel(
        { ...credentials, baseUrl: 'http://127.0.0.1:1' },
        { apiOrigin: 'http://127.0.0.1:1', fetch: fetcher },
      ).scope,
    ).toBeTruthy();
    expect(fetches).toEqual([]);
  });
});

describe('the QR on screen', () => {
  /** A terminal `columns` wide: stdout says it is a TTY. */
  function terminal(columns: number) {
    const screen = memoryIo({ interactive: true });
    Object.assign(screen.io.stdout, { isTTY: true, columns });
    return screen;
  }

  it('is erased from a terminal when the login ends, link and all', async () => {
    const screen = terminal(120);
    const pending = qrLogin(screen.io, { qrLink: true, apiOrigin: wx.origin }, []);
    await screen.waitFor(/用手机微信扫上面的二维码并确认/);
    const link = wx.qrcodes.at(-1)!;
    wx.scan();
    await screen.waitFor(/已扫码/);
    wx.confirm();
    expect((await pending).kind).toBe('confirmed');
    const out = screen.out;
    const erase = /\u001b\[(\d+)A\r\u001b\[J$/.exec(out);
    expect(erase).not.toBeNull();
    // Everything since the code was drawn: its lines, the prompt, the link, "scanned".
    const shown = out.slice(0, erase!.index).split('\n').length - 1;
    expect(Number(erase![1])).toBe(shown);
    expect(out.slice(0, erase!.index)).toContain(link);
  });

  it('prints the link instead when the terminal is too narrow to draw the code, and erases every row of it', async () => {
    const screen = terminal(30);
    const pending = qrLogin(screen.io, { qrLink: false, apiOrigin: wx.origin }, []);
    await screen.waitFor(/终端太窄，画不下二维码/);
    const link = wx.qrcodes.at(-1)!;
    expect(screen.out).toContain(link);
    expect(screen.out).not.toMatch(/[█▀▄]/);
    wx.confirm();
    expect((await pending).kind).toBe('confirmed');
    const out = screen.out;
    const erase = /\u001b\[(\d+)A\r\u001b\[J$/.exec(out)!;
    // The link and the Chinese lines wrap on 30 columns: the cursor goes up past all their rows.
    const printed = out.slice(0, erase.index).replace(/\n$/, '');
    const rows = printed.split('\n').reduce((sum, line) => sum + terminalRows(line, 30), 0);
    expect(rows).toBeGreaterThan(printed.split('\n').length + 3);
    expect(Number(erase[1])).toBe(rows);
  });

  it('counts terminal rows with wrapping, wide characters and no colour codes', () => {
    expect(terminalRows('abc', 80)).toBe(1);
    expect(terminalRows('', 80)).toBe(1);
    expect(terminalRows('x'.repeat(81), 80)).toBe(2);
    expect(terminalRows('二'.repeat(40), 80)).toBe(1);
    expect(terminalRows('二'.repeat(41), 80)).toBe(2);
    expect(terminalRows('\u001b[30;47m' + '█'.repeat(80) + '\u001b[0m', 80)).toBe(1);
    expect(terminalRows('a\nb', 80)).toBe(2);
    expect(terminalRows('x'.repeat(500), undefined)).toBe(1);
  });
});
