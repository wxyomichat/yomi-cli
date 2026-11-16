import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as RawSocket } from 'ws';

import { exchangeFirebaseToken } from '../src/auth/session.js';
import {
  characterProfile,
  characterReportReasons,
  ChatRefusal,
  ConsumptionMode,
  conversationId,
  feedbackReasons,
  findConversation,
  listMessages,
  openingOf,
  personaName,
  pollMessages,
  refusalOf,
  replyCost,
  sendMessage,
  type SendRequest,
  submitCharacterReport,
  submitFeedback,
} from '../src/chat/api.js';
import { ApiError, Gateway } from '../src/core/api.js';
import { i64 } from '../src/core/json.js';
import { ImConnection, type ImEvent } from '../src/im/connection.js';
import { ParagraphType, SenderType } from '../src/im/models.js';
import { BusinessType, Command, decodePacket, type Packet } from '../src/im/packet.js';
import {
  ConversationPurpose,
  readStruct,
  type StreamEvent,
  StreamEventType,
} from '../src/im/thrift.js';
import { MOCK_NPCS, type MockServer, startMockServer } from '../src/mock/server.js';
import { relayPolicy } from '../src/relay/policy.js';

/**
 * Ordinary chat against the mock gateway, through the real client: the chat routes in
 * `src/chat/api.ts` on a signed-in Gateway and an `ImConnection` reading types 1 and 4, as
 * `yomi relay` does. Nothing reaches the network.
 */

const IDFV = 'mock-chat-test';
const single = MOCK_NPCS.single;

let mock: MockServer;
let gateway: Gateway;
let connection: ImConnection;
const events: ImEvent[] = [];

/** What a client does on every connect: read the msgbox and pass each packet on. */
async function drain() {
  for (let page = 0; page < 10; page++) {
    const result = await pollMessages(gateway, 50);
    result.packets.sort((a, b) => a.sid - b.sid).forEach((packet) => connection.ingest(packet));
    if (!result.hasMore) return;
  }
}

beforeAll(async () => {
  mock = await startMockServer();
  gateway = new Gateway({
    env: { name: 'test', apiOrigin: mock.origin, webOrigin: mock.origin, lane: '', custom: true },
    idfv: IDFV,
  });
  const credential = await exchangeFirebaseToken(gateway, mock.idToken(), IDFV);
  connection = new ImConnection({
    businessTypes: [BusinessType.conversationStream, BusinessType.conversationAside],
    purpose: ConversationPurpose.normal,
    url: () => gateway.connectionURL(),
    headers: () => gateway.connectionHeaders(),
    userId: credential.userId,
    deviceId: credential.deviceId,
    maxBackoffMs: 50,
    onConnected: () => {
      void drain().catch(() => undefined);
    },
  });
  connection.on((event) => events.push(event));
  connection.start();
  expect(await connection.ready(5_000)).toBe(true);
});

beforeEach(() => {
  Object.assign(mock.state, {
    gems: 25,
    chatFreeLimit: 2,
    replyCost: 5,
    relayPolicy: null,
    ignoreFreeOnly: false,
    reportCharge: false,
    nextSendFailure: null,
    offline: false,
    streamStepMs: 15,
  });
  mock.state.chats.clear();
  mock.state.sendAnswers.clear();
  mock.state.msgbox.length = 0;
  events.length = 0;
});

afterAll(async () => {
  connection.stop();
  await mock.close();
});

let sent = 0;
const send = (npcId: string, text: string, extra: Partial<SendRequest> = {}) =>
  sendMessage(gateway, {
    npcId,
    text,
    clientRequestId: `req_${++sent}`,
    consumptionMode: ConsumptionMode.allowPaid,
    ...extra,
  });

const streamOf = (streamId: string): StreamEvent[] =>
  events.flatMap((item) =>
    item.kind === 'stream' && item.event.streamId === streamId ? [item.event] : [],
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(5);
  }
}

/** Waits for the stream's completion or error. */
const finished = (streamId: string) =>
  until(() => streamOf(streamId).some((event) => event.type !== StreamEventType.messageChunk));

describe('ordinary chat on the mock gateway', () => {
  it('reads the profile, the persona and the price', async () => {
    const profile = await characterProfile(gateway, single);
    expect(profile).toMatchObject({
      npcId: single,
      name: '林夏',
      group: false,
      openingStatus: 1,
      visibility: 1,
    });
    expect(openingOf(profile)).toEqual([
      {
        type: ParagraphType.narration,
        text: '雨停了，书店的门铃响了一声。',
        npcId: '',
        npcName: '',
      },
      { type: ParagraphType.dialogue, text: '你来了。', npcId: single, npcName: '林夏' },
    ]);
    expect(await characterProfile(gateway, MOCK_NPCS.group)).toMatchObject({
      name: '雾港',
      group: true,
    });
    expect(await personaName(gateway, single)).toBe('旅人');
    expect(await replyCost(gateway, single)).toBe(5);
  });

  it('streams reviewed paragraphs (raw text and thinking only on the wire), then keeps history', async () => {
    const raw = new RawSocket(gateway.connectionURL());
    const frames: Packet[] = [];
    raw.on('message', (data: Buffer) => frames.push(decodePacket(new Uint8Array(data))));
    await new Promise((resolve, reject) => {
      raw.once('open', resolve);
      raw.once('error', reject);
    });
    try {
      expect(await conversationId(gateway, single)).toBe('');
      const answer = await send(single, '你最近在读什么书');
      expect(answer).toMatchObject({ chargedDiamonds: null, notices: [] });
      expect(answer.cid).toMatch(/^\d{19}$/);
      await finished(answer.streamId);
      const stream = streamOf(answer.streamId);
      expect(stream.map((event) => [event.type, event.seq])).toEqual([
        [1, 1],
        [1, 2],
        [1, 3],
        [2, 4],
      ]);
      const chunks = stream.slice(0, 3).map((event) => event.chunk!);
      for (const chunk of chunks) {
        expect(chunk).toMatchObject({ mid: answer.assistantMid, parentMid: answer.mid });
        expect(chunk.text).toMatch(/^RAW-UNREVIEWED /);
      }
      // Cumulative: every chunk extends the one before it.
      chunks.slice(1).forEach((chunk, index) => {
        const before = chunks[index].paragraphs!;
        expect(chunk.paragraphs!.length).toBeGreaterThanOrEqual(before.length);
        before.forEach((paragraph, at) =>
          expect(chunk.paragraphs![at].text.startsWith(paragraph.text)).toBe(true),
        );
      });
      const completed = stream[3].message!;
      expect(stream[3]).toMatchObject({ entityId: single, entityType: 1, purpose: 1 });
      expect(completed.content.paragraphs).toEqual([
        { type: ParagraphType.narration, text: '她合上书，看着你。', npcId: '', npcName: '' },
        {
          type: ParagraphType.dialogue,
          text: '你最近在读什么书？这个问题，我想了很久。',
          npcId: single,
          npcName: '林夏',
        },
      ]);
      expect(chunks[2].paragraphs).toEqual(completed.content.paragraphs);
      expect(completed.content.text).toBe(
        '她合上书，看着你。\n你最近在读什么书？这个问题，我想了很久。',
      );
      expect(JSON.stringify(stream)).not.toContain('THINKING-SECRET');

      // Every open socket got the pushes; the thinking (4) is on the wire, never decoded.
      await until(() => frames.filter((frame) => frame.businessType === 1).length === 4);
      const wire = frames.filter((frame) => frame.businessType === BusinessType.conversationStream);
      expect(wire.map((frame) => frame.command)).toEqual([
        Command.businessStreaming,
        Command.businessStreaming,
        Command.businessStreaming,
        Command.business,
      ]);
      const chunk = readStruct(wire[0].payload).struct(7)!;
      expect(chunk.string(4)).toBe('THINKING-SECRET');
      expect(chunk.string(2)).toMatch(/^RAW-UNREVIEWED /);
      expect(readStruct(wire[0].payload).i32(12)).toBeUndefined();

      const history = await listMessages(gateway, answer.cid);
      expect(history.map((message) => [message.mid, message.senderType])).toEqual([
        [answer.assistantMid, SenderType.assistant],
        [answer.mid, SenderType.user],
      ]);
      expect(history[0]).toMatchObject({ parentMid: answer.mid, content: completed.content });
      expect(history[1].content.text).toBe('你最近在读什么书');
      expect(await conversationId(gateway, single)).toBe(answer.cid);
      expect(await findConversation(gateway, single)).toBe(answer.cid);
    } finally {
      raw.terminate();
    }
  });

  it('lets both members of a group chat speak', async () => {
    const answer = await send(MOCK_NPCS.group, '大家好');
    await finished(answer.streamId);
    const last = streamOf(answer.streamId).at(-1)!;
    expect(last.entityId).toBe(MOCK_NPCS.group);
    expect(last.message!.content.paragraphs).toEqual([
      {
        type: ParagraphType.dialogue,
        text: '大家好？我先说两句。',
        npcId: '7300000000000009101',
        npcName: '阿青',
      },
      {
        type: ParagraphType.dialogue,
        text: '我也在听。',
        npcId: '7300000000000009102',
        npcName: '小白',
      },
    ]);
  });

  it('gives free replies, then refuses FreeOnly and a low spend cap, then charges', async () => {
    mock.state.reportCharge = true;
    const accepted: string[] = [];
    for (const text of ['一', '二']) {
      const answer = await send(single, text, { consumptionMode: ConsumptionMode.freeOnly });
      expect(answer.chargedDiamonds).toBe(0);
      accepted.push(answer.streamId);
    }
    await expect(
      send(single, '三', { consumptionMode: ConsumptionMode.freeOnly }),
    ).rejects.toMatchObject({
      name: 'ChatRefusal',
      kind: 'freeExhausted',
      code: 'FREE_QUOTA_EXHAUSTED',
    });
    await expect(send(single, '三', { maxCostDiamonds: 4 })).rejects.toMatchObject({
      kind: 'spendCap',
      code: 'SPEND_CAP_EXCEEDED',
    });
    expect(mock.state.gems).toBe(25);
    const paid = await send(single, '三', { maxCostDiamonds: 5 });
    expect(paid.chargedDiamonds).toBe(5);
    expect(mock.state.gems).toBe(20);
    accepted.push(paid.streamId);

    mock.state.gems = 4;
    const refusal = await send(single, '四').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ChatRefusal);
    expect(refusal).toMatchObject({
      kind: 'gems',
      code: '1504011011',
      dialog: { title: '钻石不足', content: '充值后继续' },
    });
    expect(mock.state.gems).toBe(4);

    // A server that does not honour FreeOnly charges it anyway.
    mock.state.gems = 25;
    mock.state.ignoreFreeOnly = true;
    const ignored = await send(single, '五', { consumptionMode: ConsumptionMode.freeOnly });
    expect(ignored.chargedDiamonds).toBe(5);
    expect(mock.state.gems).toBe(20);
    accepted.push(ignored.streamId);
    for (const streamId of accepted) await finished(streamId);
    // Only accepted sends reached history.
    expect(await listMessages(gateway, paid.cid, 100)).toHaveLength(8);
  });

  it('answers a repeated client_request_id once, charged once', async () => {
    mock.state.chatFreeLimit = 0;
    mock.state.reportCharge = true;
    const request: SendRequest = {
      npcId: single,
      text: '只发一次',
      clientRequestId: 'req_once',
      consumptionMode: ConsumptionMode.allowPaid,
    };
    const first = await sendMessage(gateway, request);
    const again = await sendMessage(gateway, request);
    expect(again).toEqual(first);
    expect(mock.state.gems).toBe(20);
    await finished(first.streamId);
    await sleep(50);
    expect(await listMessages(gateway, first.cid)).toHaveLength(2);
  });

  it('answers the next send with a set failure, once', async () => {
    mock.state.nextSendFailure = {
      relay_error: 'RATE_LIMITED',
      retry_after_ms: 3000,
      base_resp: { status_code: 429, status_msg: 'slow down' },
    };
    await expect(send(single, '快')).rejects.toMatchObject({
      kind: 'rateLimited',
      retryAfterMs: 3000,
    });
    expect(mock.state.nextSendFailure).toBeNull();
    const answer = await send(single, '慢一点');
    await finished(answer.streamId);
  });

  it('fails a stream after one chunk, and keeps a silent reply for history only', async () => {
    const failing = await send(single, 'FAIL 一下');
    await finished(failing.streamId);
    const stream = streamOf(failing.streamId);
    expect(stream.map((event) => [event.type, event.seq])).toEqual([
      [1, 1],
      [3, 2],
    ]);
    expect(stream[1].error).toEqual({ code: 'GENERATION_FAILED', message: '模型开小差了' });

    const silent = await send(single, 'SILENT');
    await sleep(100);
    expect(streamOf(silent.streamId)).toEqual([]);
    await until(() => mock.state.chats.get(single)!.messages.length === 3);
    const history = await listMessages(gateway, silent.cid);
    expect(history.map((message) => message.mid)).toEqual([
      silent.assistantMid,
      silent.mid,
      failing.mid,
    ]);
  });

  it('keeps streaming to the client after its socket is dropped', async () => {
    const answer = await send(single, 'SLOW 慢慢说');
    await until(() => streamOf(answer.streamId).length >= 2);
    const reconnects = connection.reconnects;
    mock.dropSockets();
    await finished(answer.streamId);
    expect(connection.reconnects).toBeGreaterThan(reconnects);
    expect(streamOf(answer.streamId).at(-1)).toMatchObject({ type: 2, seq: 13 });
  });

  it('keeps pushes in the msgbox while offline; poll_message hands them out once', async () => {
    mock.setOffline(true);
    await until(() => connection.state !== 'connected');
    const answer = await send(single, '离线时的话');
    await until(() => mock.state.msgbox.length === 4);
    expect(streamOf(answer.streamId)).toEqual([]);

    const page = await pollMessages(gateway, 2);
    expect(page.hasMore).toBe(true);
    expect(page.packets.map((packet) => [packet.command, packet.businessType])).toEqual([
      [Command.businessStreaming, 1],
      [Command.businessStreaming, 1],
    ]);
    page.packets.forEach((packet) => connection.ingest(packet));
    expect(mock.state.msgbox).toHaveLength(2);

    // Back online: the client reconnects and drains the rest.
    mock.setOffline(false);
    await finished(answer.streamId);
    expect(streamOf(answer.streamId).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(mock.state.msgbox).toEqual([]);
    expect((await pollMessages(gateway)).packets).toEqual([]);
    // A packet read twice is passed on once.
    page.packets.forEach((packet) => connection.ingest(packet));
    expect(streamOf(answer.streamId)).toHaveLength(4);
  });

  it('streams a reply the same account started on another device', async () => {
    const own = await send(single, '我先说');
    await finished(own.streamId);
    const other = mock.replyFromAnotherDevice(single, '在手机上说的');
    expect(other.streamId).not.toBe(own.streamId);
    await finished(other.streamId);
    const stream = streamOf(other.streamId);
    expect(stream[0]).toMatchObject({ entityId: single, chunk: { mid: other.assistantMid } });
    expect(stream.at(-1)!.message!.mid).toBe(other.assistantMid);
    const history = await listMessages(gateway, own.cid);
    expect(history[0].mid).toBe(other.assistantMid);
    expect(history[1].content.text).toBe('在手机上说的');
    expect(mock.state.gems).toBe(25);
  });

  it('pushes asides on business type 4', async () => {
    const asideId = mock.pushAside(single, {
      scene: 'memory_updated',
      text: '记忆已更新',
      anchorMid: '7300000000000099999',
    });
    await until(() => events.some((item) => item.kind === 'aside'));
    const aside = events.find((item) => item.kind === 'aside')!;
    expect(aside.event).toMatchObject({
      asideId,
      entityId: single,
      anchorMid: '7300000000000099999',
      aside: { scene: 'memory_updated', style: 1, texts: [{ text: '记忆已更新', schema: '' }] },
    });
  });

  it('refreshes after the auth tokens expire, and reconnects with the new refresh token', async () => {
    const before = mock.state.refreshes;
    const token = gateway.credential!.authToken;
    mock.expireAuthTokens();
    expect(await replyCost(gateway, single)).toBe(5);
    expect(mock.state.refreshes).toBe(before + 1);
    expect(gateway.credential!.authToken).not.toBe(token);
    const reconnects = connection.reconnects;
    mock.dropSockets();
    await until(() => connection.reconnects > reconnects && connection.state === 'connected');
  });

  it('refuses every call about a removed character with 41001', async () => {
    await expect(send(MOCK_NPCS.removed, '还在吗')).rejects.toMatchObject({
      name: 'ChatRefusal',
      kind: 'unavailable',
      code: '41001',
    });
    await expect(characterProfile(gateway, MOCK_NPCS.removed)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    const error = await gateway
      .request('conversation/get_chat_preference', {
        entity_id: i64(MOCK_NPCS.removed),
        entity_type: 1,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(refusalOf(error)).toMatchObject({ kind: 'unavailable', code: '41001' });
    expect(mock.state.chats.size).toBe(0);
  });

  it('takes feedback on a reply and reports on a character', async () => {
    const answer = await send(single, '讲个故事');
    await finished(answer.streamId);
    const reasons = await feedbackReasons(gateway);
    expect(reasons).toContainEqual({
      key: 'sexual_minor',
      label: '涉及未成年人',
      section: '举报',
      isReport: true,
    });
    expect(reasons).toContainEqual({
      key: 'boring',
      label: '无聊',
      section: '不喜欢',
      isReport: false,
    });
    await submitFeedback(gateway, single, answer.assistantMid, ['boring'], '太短');
    expect(mock.state.feedback.at(-1)).toMatchObject({
      mid: answer.assistantMid,
      tag_keys: ['boring'],
      comment: '太短',
    });
    // Only an assistant message of that chat takes feedback.
    await expect(submitFeedback(gateway, single, answer.mid, ['boring'])).rejects.toMatchObject({
      code: '400',
    });
    expect(await characterReportReasons(gateway)).toEqual([
      { key: 'npc_inappropriate', label: '不当内容', section: '举报', isReport: true },
    ]);
    await submitCharacterReport(gateway, MOCK_NPCS.group, ['npc_inappropriate']);
    expect(mock.state.npcReports.at(-1)).toMatchObject({
      npc_id: MOCK_NPCS.group,
      tag_keys: ['npc_inappropriate'],
    });
  });

  it('has relay/get_policy only when a test sets it', async () => {
    expect(await relayPolicy(gateway)).toMatchObject({ source: 'default' });
    mock.state.relayPolicy = {
      enabled: true,
      min_cli_version: '0.1.0',
      features: { free_only: true, spend_cap: true, idempotent_send: true },
    };
    expect(await relayPolicy(gateway)).toMatchObject({
      source: 'server',
      minVersion: '0.1.0',
      freeOnly: true,
      spendCap: true,
      idempotentSend: true,
      complianceNotices: false,
    });
  });
});
