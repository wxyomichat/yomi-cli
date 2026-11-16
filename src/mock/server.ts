import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import { encodeBody, type Json, parseGatewayJson } from '../core/json.js';
import {
  compareMid,
  emptyContent,
  type ImMessage,
  type ImParagraph,
  NPC_ENTITY_TYPE,
  ParagraphType,
  SenderType,
} from '../im/models.js';
import { BusinessType, Command, decodePacket, encodePacket, toBase64 } from '../im/packet.js';
import { ConversationPurpose, type StreamEvent, StreamEventType } from '../im/thrift.js';
import { encodeAsideEvent, encodeStreamEvent } from '../im/thriftWriter.js';

/**
 * A stand-in for the Yomi gateway and the web's authorize page, for tests and for trying the CLI
 * without real servers (`pnpm mock`). It checks what the real ones check that matters to the CLI
 * (the request signature, `X-Token`, i64 IDs, idempotent request IDs, the preview's ordered entry
 * IDs, the free messages) and streams preview replies over a real WebSocket with the real packet
 * and Thrift encoding. Shapes follow the service's character and preview interfaces; nothing here
 * reaches the network.
 *
 * Ordinary chat with two published characters (`MOCK_NPCS`) follows the service's conversation
 * interface and what the relay contract asks of it: flat answers, free replies then paid ones,
 * FreeOnly, the spend cap, idempotent sends, replies streamed on business type 1 (with the raw text
 * and thinking a client must never show beside the reviewed paragraphs), the msgbox while offline,
 * replies from "another device", asides, and expired auth tokens.
 */

const SALT = '417b472b';
const USER_ID = '7300000000000000101';
const FREE_LIMIT = 3;
const PAID_PRICE = 10;

export const MOCK_VOICES = [
  {
    voice_id: 'voice_warm_f',
    display_name: 'Warm (F)',
    gender: 'female',
    description: 'Soft, warm',
  },
  {
    voice_id: 'voice_calm_m',
    display_name: 'Calm (M)',
    gender: 'male',
    description: 'Low, steady',
  },
];
export const MOCK_TAGS = [
  { tag_id: 9100000000000000001n, name: 'Romance' },
  { tag_id: 9100000000000000002n, name: 'Fantasy' },
  { tag_id: 9100000000000000003n, name: '校园' },
];

/**
 * The published characters ordinary chat knows: 林夏 alone, the group chat 雾港 (members 阿青 and
 * 小白), and one taken down (every call about it answers 41001, as an unknown id does).
 */
export const MOCK_NPCS = {
  single: '7300000000000009001',
  group: '7300000000000009002',
  removed: '7300000000000009003',
} as const;

type Session = { authToken: string; refreshToken: string; deviceId: string; revoked: boolean };
type Upload = {
  id: string;
  purpose: string;
  mime: string;
  size: number;
  bytes: Buffer | null;
  status: number;
};
type Preview = {
  cid: string;
  draftId: string;
  npcId: string;
  name: string;
  closed: boolean;
  messages: Json[];
};

/** An ordinary chat with a published character. */
export type MockChat = {
  cid: string;
  npcId: string;
  /** `RoamingMessage` JSON, oldest first: the user's messages and the finished replies. */
  messages: Json[];
  /** Free replies used so far. */
  freeUsed: number;
};

export type MockState = {
  sessions: Session[];
  /** Every account/login body (for assertions on not_logout_other_device, device_info). */
  logins: Json[];
  uploads: Map<string, Upload>;
  characters: Map<string, { npcId: string; content: Json; requestId: string }>;
  drafts: Map<string, { draftId: string; quotaUsed: number; counter: bigint; stream: string }>;
  previews: Map<string, Preview>;
  gems: number;
  requests: { path: string; body: Json; headers: Record<string, string | string[] | undefined> }[];
  sockets: number;
  /** Ordinary chats by character id; one is made by the first accepted send. */
  chats: Map<string, MockChat>;
  /** Free replies per chat before a reply costs `replyCost` (default 2). */
  chatFreeLimit: number;
  /** Gems a paid reply costs (default 5); `get_chat_preference` quotes it. */
  replyCost: number;
  /** `relay/get_policy`'s `data`; null (default): the mock has no such route (404). */
  relayPolicy: Json | null;
  /** True: a FreeOnly send past the free replies is charged anyway, as by a server ignoring it. */
  ignoreFreeOnly: boolean;
  /** True: the send answer says what the reply cost (`charged_diamonds`). */
  reportCharge: boolean;
  /** Accepted sends by `client_request_id`: a repeat gets this answer and is not charged again. */
  sendAnswers: Map<string, Json>;
  /** Every accepted `submit_message_feedback` body. */
  feedback: Json[];
  /** Every accepted `submit_npc_report` body. */
  npcReports: Json[];
  /** Pushes kept while offline, as `Message` JSON; `poll_message` hands them out. */
  msgbox: Json[];
  /** True: sockets are refused (503) and pushes wait in `msgbox` (`setOffline`). */
  offline: boolean;
  /** The next ordinary send answers exactly this body, then it is cleared. */
  nextSendFailure: Json | null;
  /** Milliseconds between a reply's stream events (default 15). */
  streamStepMs: number;
  /** Successful `account/refresh_auth_token` calls. */
  refreshes: number;
  /** The next this-many `wallet/get_wallet_page` calls fail (a 503 with no body). */
  walletFailures: number;
};

export type MockServer = {
  origin: string;
  port: number;
  state: MockState;
  /** A Firebase-like ID token the mock's account/login accepts (what the web page would pass). */
  idToken(email?: string): string;
  /** Terminates every open socket; clients reconnect on their own. */
  dropSockets(): void;
  /**
   * True: drops the sockets, refuses new ones with 503 and keeps every push in the msgbox; false:
   * accepts sockets again (the msgbox stays until `poll_message` takes it).
   */
  setOffline(offline: boolean): void;
  /**
   * Streams a whole reply for `npcId` as if the same account chatted in the app on another device:
   * the same encoding, a stream id no send of this client returned, nothing charged.
   */
  replyFromAnotherDevice(npcId: string, text: string): { streamId: string; assistantMid: string };
  /** Pushes an aside (business type 4) for `npcId`; returns its `aside_id`. */
  pushAside(
    npcId: string,
    aside: { scene: string; text: string; anchorMid?: string; cid?: string },
  ): string;
  /** Every session gets a new auth token: old X-Tokens answer 401, refresh tokens still work. */
  expireAuthTokens(): void;
  close(): Promise<void>;
};

let counter = 1000n;
const nextId = () => {
  counter += 1n;
  return (7300000000000000000n + counter).toString();
};

function sign(uri: string, body: string, timestamp: string) {
  const url = new URL(uri, 'http://mock');
  const keys = [...new Set([...url.searchParams.keys()])].sort();
  const parts = keys.map((key) => key + '=' + (url.searchParams.get(key) ?? ''));
  return createHash('sha1')
    .update(parts.join('&') + body + 'x-timestamp=' + timestamp + 'salt=' + SALT)
    .digest('hex');
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
  type = 'application/json',
) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(type === 'application/json' ? encodeBody(body) : String(body));
}

const ok = (data: Json = {}) => ({ ...data, base_resp: { status_code: 0, status_msg: 'success' } });
const fail = (code: number, message: string, extra: Json = {}) => ({
  ...extra,
  base_resp: { status_code: code, status_msg: message },
});

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** The opening as the server renders it: quoted lines are dialogue, the rest narration. */
export function openingParagraphs(text: string, npcId: string, name: string): ImParagraph[] {
  const paragraphs: ImParagraph[] = [];
  const pattern = /["“]([^"”]+)["”]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(last, match.index).trim();
    if (before)
      paragraphs.push({ type: ParagraphType.narration, text: before, npcId: '', npcName: '' });
    paragraphs.push({ type: ParagraphType.dialogue, text: match[1], npcId, npcName: name });
    last = (match.index ?? 0) + match[0].length;
  }
  const after = text.slice(last).trim();
  if (after)
    paragraphs.push({ type: ParagraphType.narration, text: after, npcId: '', npcName: '' });
  return paragraphs;
}

const paragraphJson = (paragraph: ImParagraph) => ({
  type: paragraph.type,
  text: paragraph.text,
  ...(paragraph.npcId ? { npc_id: BigInt(paragraph.npcId) } : {}),
  ...(paragraph.npcName ? { npc_name: paragraph.npcName } : {}),
});

// ---------------------------------------------------------------------------------------------
// Ordinary chat

/** The character was taken down; unknown ids answer it too. */
const CHARACTER_REMOVED = 41001;
const PERSONA_ID = 7300000000000009201n;

type MockNpc = {
  npcId: string;
  name: string;
  opening: ImParagraph[];
  /** A group chat's members (`worldview_info.npc_list`); empty for a single character. */
  members: { npcId: string; name: string }[];
};

const narration = (text: string): ImParagraph => ({
  type: ParagraphType.narration,
  text,
  npcId: '',
  npcName: '',
});
const line = (text: string, speaker: { npcId: string; name: string }): ImParagraph => ({
  type: ParagraphType.dialogue,
  text,
  npcId: speaker.npcId,
  npcName: speaker.name,
});

const LIN_XIA = { npcId: MOCK_NPCS.single, name: '林夏' };
const MEMBERS = [
  { npcId: '7300000000000009101', name: '阿青' },
  { npcId: '7300000000000009102', name: '小白' },
];

/** The published characters; the removed one is not here, so it answers 41001 everywhere. */
const NPCS = new Map<string, MockNpc>([
  [
    MOCK_NPCS.single,
    {
      ...LIN_XIA,
      opening: [narration('雨停了，书店的门铃响了一声。'), line('你来了。', LIN_XIA)],
      members: [],
    },
  ],
  [
    MOCK_NPCS.group,
    {
      npcId: MOCK_NPCS.group,
      name: '雾港',
      opening: [narration('雾港的码头上，灯一盏盏亮起来。'), line('新来的？', MEMBERS[0])],
      members: MEMBERS,
    },
  ],
]);

/** `npc/get_npc_profile`'s `NpcProfile`; `worldview_info` only for a group chat. */
function profileJson(npc: MockNpc): Json {
  return {
    npc_id: BigInt(npc.npcId),
    name: npc.name,
    opening_status: 1,
    opening_paragraphs: npc.opening.map(paragraphJson),
    ...(npc.members.length
      ? {
          worldview_info: {
            npc_list: npc.members.map((member) => ({
              npc_id: BigInt(member.npcId),
              name: member.name,
            })),
          },
        }
      : {}),
    visibility: 1,
  };
}

/** The reviewed reply: 林夏 echoes the first 40 characters; in the group both members speak. */
function replyParagraphs(npc: MockNpc, userText: string): ImParagraph[] {
  const echo = [...userText].slice(0, 40).join('');
  const [first, second] = npc.members;
  if (first && second) return [line(`${echo}？我先说两句。`, first), line('我也在听。', second)];
  return [narration('她合上书，看着你。'), line(`${echo}？这个问题，我想了很久。`, npc)];
}

/** `MessageContent.text`: the paragraphs' plain projection. */
const projection = (paragraphs: ImParagraph[]) => paragraphs.map((p) => p.text).join('\n');

/** The first `length` characters of the paragraphs, in order: a cumulative reviewed snapshot. */
function revealed(paragraphs: ImParagraph[], length: number): ImParagraph[] {
  const result: ImParagraph[] = [];
  let left = length;
  for (const paragraph of paragraphs) {
    if (left <= 0) break;
    const characters = [...paragraph.text];
    result.push({ ...paragraph, text: characters.slice(0, left).join('') });
    left -= characters.length;
  }
  return result;
}

const userMessage = (mid: string, text: string): ImMessage => ({
  mid,
  parentMid: '',
  content: emptyContent({ text }),
  timestamp: Date.now(),
  senderType: SenderType.user,
  semantic: 0,
  sourceMid: '',
});

const replyMessage = (mid: string, parentMid: string, paragraphs: ImParagraph[]): ImMessage => ({
  mid,
  parentMid,
  content: emptyContent({ text: projection(paragraphs), paragraphs }),
  timestamp: Date.now(),
  senderType: SenderType.assistant,
  semantic: 0,
  sourceMid: '',
});

/** `RoamingMessage` JSON, as history answers it. */
function roamingJson(message: ImMessage): Json {
  const content: Json = { text: message.content.text };
  if (message.content.paragraphs.length)
    content.paragraphs = message.content.paragraphs.map(paragraphJson);
  return {
    mid: BigInt(message.mid),
    sender_type: message.senderType,
    ...(message.parentMid ? { parent_mid: BigInt(message.parentMid) } : {}),
    content,
    timestamp: message.timestamp,
    semantic: message.semantic,
  };
}

/** History's order: timestamp DESC, mid DESC. */
const newestFirst = (a: Json, b: Json) =>
  Number(b.timestamp) - Number(a.timestamp) || compareMid(String(b.mid), String(a.mid));

type ReasonConfig = {
  sections: {
    key: string;
    title: string;
    max_select: number;
    is_report: boolean;
    tags: { key: string; label: string }[];
  }[];
  min_select: number;
};

const FEEDBACK_CONFIG: ReasonConfig = {
  sections: [
    {
      key: 'report',
      title: '举报',
      max_select: 1,
      is_report: true,
      tags: [
        { key: 'sexual_minor', label: '涉及未成年人' },
        { key: 'harassment', label: '骚扰' },
      ],
    },
    {
      key: 'quality',
      title: '不喜欢',
      max_select: 3,
      is_report: false,
      tags: [{ key: 'boring', label: '无聊' }],
    },
  ],
  min_select: 1,
};

const REPORT_CONFIG: ReasonConfig = {
  sections: [
    {
      key: 'report',
      title: '举报',
      max_select: 1,
      is_report: true,
      tags: [{ key: 'npc_inappropriate', label: '不当内容' }],
    },
  ],
  min_select: 1,
};

/** At least one tag key, and every one offered by `config`. */
function offered(keys: unknown, config: ReasonConfig): boolean {
  const known = new Set(config.sections.flatMap((section) => section.tags.map((tag) => tag.key)));
  return (
    Array.isArray(keys) &&
    keys.length > 0 &&
    keys.every((key) => typeof key === 'string' && known.has(key))
  );
}

/**
 * The mock authorize page. As the web's `/cli/auth`, it reads `port` and `state` from the
 * fragment (which the server never sees), fills both forms and drops the fragment.
 */
const WEB_PAGE = (token: string) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Mock · 授权 Yomi CLI</title>
<style>body{font:16px/1.6 sans-serif;max-width:480px;margin:48px auto;padding:0 16px}button{font-size:16px;padding:8px 16px;margin-right:8px}</style>
</head><body><h1>授权 Yomi CLI（mock）</h1>
<p>mock 账号 mock@example.com 将授权给本机的 Yomi CLI。确认码：<b id="code">…</b></p>
<form method="POST" data-kind="authorize">
<input type="hidden" name="state" value="">
<input type="hidden" name="id_token" value="${token}">
<input type="hidden" name="email" value="mock@example.com">
<button type="submit">授权</button></form>
<form method="POST" data-kind="cancel">
<input type="hidden" name="state" value="">
<input type="hidden" name="error" value="access_denied"><button type="submit">取消</button></form>
<script>
const params = new URLSearchParams(location.hash.slice(1));
const port = params.get('port') || '';
const state = params.get('state') || '';
history.replaceState(null, '', location.pathname);
if (!/^[0-9]{4,5}$/.test(port) || !/^[A-Za-z0-9_-]{43}$/.test(state)) document.body.textContent = '链接无效';
for (const form of document.forms) {
  form.action = 'http://127.0.0.1:' + port + '/callback';
  form.elements.state.value = state;
}
crypto.subtle.digest('SHA-256', new TextEncoder().encode('yomi-cli-auth:' + state)).then((d) => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let bits = 0n;
  for (const b of new Uint8Array(d).slice(0, 5)) bits = (bits << 8n) | BigInt(b);
  let c = '';
  for (let i = 0; i < 8; i++) c += a[Number((bits >> BigInt(35 - i * 5)) & 31n)];
  document.getElementById('code').textContent = c.slice(0, 4) + '-' + c.slice(4);
});
</script></body></html>`;

export async function startMockServer(options: { port?: number } = {}): Promise<MockServer> {
  const state: MockState = {
    sessions: [],
    logins: [],
    uploads: new Map(),
    characters: new Map(),
    drafts: new Map(),
    previews: new Map(),
    gems: 25,
    requests: [],
    sockets: 0,
    chats: new Map(),
    chatFreeLimit: 2,
    replyCost: 5,
    relayPolicy: null,
    ignoreFreeOnly: false,
    reportCharge: false,
    sendAnswers: new Map(),
    feedback: [],
    npcReports: [],
    msgbox: [],
    offline: false,
    nextSendFailure: null,
    streamStepMs: 15,
    refreshes: 0,
    walletFailures: 0,
  };
  const sockets = new Set<WebSocket>();
  const uploadRequests = new Map<string, string>();
  let origin = '';

  const idToken = (email = 'mock@example.com') =>
    [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ email, aud: 'mock' })).toString('base64url'),
      randomBytes(16).toString('base64url'),
    ].join('.');

  const session = (token: string | undefined) =>
    state.sessions.find((item) => item.authToken === token && !item.revoked) ?? null;

  let sid = 1;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** Runs `task` after `ms`, unless the server is closed first. */
  const later = (task: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      task();
    }, ms);
    timers.add(timer);
  };

  /**
   * One push to the account: to every open socket, or while offline into the msgbox as
   * `Message` JSON (base64 payload), which `poll_message` hands out.
   */
  const deliver = (businessType: number, command: number, payload: Uint8Array) => {
    const fields = {
      command,
      businessType,
      sid: sid++,
      sequenceId: nextId(),
      sentAt: Date.now(),
      payload,
    };
    if (state.offline) {
      state.msgbox.push({
        cmd: fields.command,
        biz_type: fields.businessType,
        trace_id: '',
        sid: fields.sid,
        send_at: fields.sentAt,
        user_id: USER_ID,
        device_id: '',
        seq_id: BigInt(fields.sequenceId),
        payload: toBase64(payload),
      });
      return;
    }
    const packet = encodePacket(fields);
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(packet);
  };

  /** A stream event: chunks as BusinessStreaming, the rest as Business. */
  const pushStream = (event: Parameters<typeof encodeStreamEvent>[0], businessType: number) =>
    deliver(
      businessType,
      event.type === StreamEventType.messageChunk ? Command.businessStreaming : Command.business,
      encodeStreamEvent(event),
    );
  const push = (event: Parameters<typeof encodeStreamEvent>[0]) =>
    pushStream(event, BusinessType.ugcPreviewStream);
  /** Ordinary chat's stream (type 1); purpose Normal, which is left out on the wire. */
  const pushChat = (event: Parameters<typeof encodeStreamEvent>[0]) =>
    pushStream(event, BusinessType.conversationStream);

  const streamReply = (
    preview: Preview,
    userText: string,
    assistantMid: string,
    streamId: string,
  ) => {
    const reply = `她合上书，看着你。"${userText.slice(0, 40)}？这个问题，我想了很久。" 窗外的雨停了。`;
    const paragraphs = openingParagraphs(reply, preview.npcId, preview.name);
    const steps = [8, 20, reply.length];
    let seq = 0;
    steps.forEach((length, index) => {
      setTimeout(
        () => {
          seq += 1;
          push({
            type: StreamEventType.messageChunk,
            entityId: preview.npcId,
            entityType: 1,
            streamId,
            seq,
            chunk: {
              mid: assistantMid,
              text: reply.slice(0, length),
              parentMid: '',
              paragraphs: null,
            },
            message: null,
            error: null,
            cid: preview.cid,
            purpose: ConversationPurpose.ugcPreview,
          });
        },
        20 * (index + 1),
      );
    });
    setTimeout(
      () => {
        const message = {
          mid: assistantMid,
          parentMid: '',
          content: { text: reply, images: [], paragraphs, audio: null, aside: null },
          timestamp: Date.now(),
          senderType: 2,
          semantic: 0,
          sourceMid: '',
        };
        push({
          type: StreamEventType.messageCompleted,
          entityId: preview.npcId,
          entityType: 1,
          streamId,
          seq: seq + 1,
          chunk: null,
          message,
          error: null,
          cid: preview.cid,
          purpose: ConversationPurpose.ugcPreview,
        });
        preview.messages.push({
          mid: BigInt(assistantMid),
          cid: BigInt(preview.cid),
          sender_type: 2,
          content: { text: reply, paragraphs: paragraphs.map(paragraphJson) },
          timestamp: Date.now(),
        });
      },
      20 * (steps.length + 1),
    );
  };

  /** The published character `value` names, or null (unknown or taken down). */
  const npcOf = (value: unknown) => NPCS.get(String(value ?? '')) ?? null;
  const removed = () => fail(CHARACTER_REMOVED, 'character removed');

  const chatOf = (npcId: string): MockChat => {
    let chat = state.chats.get(npcId);
    if (!chat) {
      chat = { cid: nextId(), npcId, messages: [], freeUsed: 0 };
      state.chats.set(npcId, chat);
    }
    return chat;
  };

  /**
   * One accepted turn: the user's message goes into history and the reply streams on the
   * conversation stream (type 1, purpose Normal, so left out): chunks of cumulative reviewed
   * paragraphs beside the raw text and thinking a client must never show, then the final message,
   * which history gets too. A text with SILENT streams nothing (the reply lands in history after
   * 300 ms), FAIL fails after one chunk, SLOW takes 12 chunks 120 ms apart.
   */
  const startTurn = (chat: MockChat, text: string) => {
    const npc = NPCS.get(chat.npcId)!;
    const user = userMessage(nextId(), text);
    const assistantMid = nextId();
    const streamId = 'st_' + randomBytes(6).toString('hex');
    chat.messages.push(roamingJson(user));
    const paragraphs = replyParagraphs(npc, text);
    const complete = () => {
      const message = replyMessage(assistantMid, user.mid, paragraphs);
      chat.messages.push(roamingJson(message));
      return message;
    };
    const turn = { userMid: user.mid, assistantMid, streamId, timestamp: user.timestamp };
    if (text.includes('SILENT')) {
      later(complete, 300);
      return turn;
    }
    const failing = text.includes('FAIL');
    const slow = text.includes('SLOW');
    const parts = slow ? 12 : 3;
    const chunks = failing ? 1 : parts;
    const stepMs = slow ? 120 : state.streamStepMs;
    const total = paragraphs.reduce((sum, paragraph) => sum + [...paragraph.text].length, 0);
    const base: Omit<StreamEvent, 'type' | 'seq'> = {
      entityId: chat.npcId,
      entityType: NPC_ENTITY_TYPE,
      streamId,
      chunk: null,
      message: null,
      error: null,
      cid: chat.cid,
    };
    for (let seq = 1; seq <= chunks; seq++) {
      const shown = revealed(paragraphs, Math.ceil((total * seq) / parts));
      const chunk = {
        mid: assistantMid,
        text: 'RAW-UNREVIEWED ' + projection(shown),
        parentMid: user.mid,
        paragraphs: shown,
      };
      const event = { ...base, type: StreamEventType.messageChunk, seq, chunk };
      later(() => pushChat({ ...event, chunkThinking: 'THINKING-SECRET' }), stepMs * seq);
    }
    later(
      () => {
        const seq = chunks + 1;
        if (failing) {
          const error = { code: 'GENERATION_FAILED', message: '模型开小差了' };
          pushChat({ ...base, type: StreamEventType.error, seq, error });
          return;
        }
        pushChat({ ...base, type: StreamEventType.messageCompleted, seq, message: complete() });
      },
      stepMs * (chunks + 1),
    );
    return turn;
  };

  /**
   * `send_message` with `entity_id`: the character must be published; `nextSendFailure` answers
   * once; a repeated `client_request_id` gets its first answer, uncharged. Past the free replies
   * FreeOnly is refused (unless `ignoreFreeOnly`), a `max_cost_diamonds` below the price is
   * refused uncharged, and too few gems is the gems refusal with its dialog. Answers are flat.
   */
  const sendOrdinary = (body: Json) => {
    const npc = npcOf(body.entity_id);
    if (!npc) return removed();
    const failure = state.nextSendFailure;
    if (failure) {
      state.nextSendFailure = null;
      return failure;
    }
    const requestId = typeof body.client_request_id === 'string' ? body.client_request_id : '';
    const replay = requestId ? state.sendAnswers.get(requestId) : undefined;
    if (replay) return replay;
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return fail(400, 'text required');
    const free = (state.chats.get(npc.npcId)?.freeUsed ?? 0) < state.chatFreeLimit;
    let charged = 0;
    if (!free) {
      // ConsumptionMode: 0 FreeOnly, 1 AllowPaid (absent: may pay, as the app's sends).
      if (body.consumption_mode === 0 && !state.ignoreFreeOnly)
        return fail(1504011041, 'free replies used up', { relay_error: 'FREE_QUOTA_EXHAUSTED' });
      const cap = body.max_cost_diamonds;
      if (typeof cap === 'number' && state.replyCost > cap)
        return fail(1504011051, 'reply costs more than allowed', {
          relay_error: 'SPEND_CAP_EXCEEDED',
        });
      if (state.gems < state.replyCost)
        return fail(1504011011, 'insufficient gems', {
          model_unavailable_dialog: { title: '钻石不足', content: '充值后继续' },
        });
      state.gems -= state.replyCost;
      charged = state.replyCost;
    }
    const chat = chatOf(npc.npcId);
    if (free) chat.freeUsed += 1;
    const turn = startTurn(chat, text);
    const answer = ok({
      mid: BigInt(turn.userMid),
      server_timestamp: turn.timestamp,
      stream_id: turn.streamId,
      cid: BigInt(chat.cid),
      assistant_mid: BigInt(turn.assistantMid),
      ...(state.reportCharge ? { charged_diamonds: charged } : {}),
    });
    if (requestId) state.sendAnswers.set(requestId, answer);
    return answer;
  };

  const quotaOf = (draft: { quotaUsed: number }, version: number) => ({
    limit: FREE_LIMIT,
    used: Math.min(draft.quotaUsed, FREE_LIMIT),
    remaining: Math.max(0, FREE_LIMIT - draft.quotaUsed),
    version,
    policy_version: 1,
  });

  const routes: Record<string, (body: Json, user: Session | null) => unknown> = {
    'account/login': (body) => {
      state.logins.push(body);
      const token = String(body.firebase_token ?? '');
      if (body.login_type !== 3 || token.split('.').length !== 3) return fail(400, 'bad login');
      const created: Session = {
        authToken: 'at_' + randomBytes(12).toString('hex'),
        refreshToken: 'rt_' + randomBytes(12).toString('hex'),
        deviceId: nextId(),
        revoked: false,
      };
      if (body.not_logout_other_device !== true)
        for (const item of state.sessions) item.revoked = true;
      state.sessions.push(created);
      return ok({
        data: {
          user_id: BigInt(USER_ID),
          device_id: BigInt(created.deviceId),
          auth_token: created.authToken,
          refresh_token: created.refreshToken,
          is_new: false,
          email: 'mock@example.com',
        },
      });
    },
    'account/get_account': (_body, user) =>
      ok({ data: { user_id: BigInt(USER_ID), is_anonymous: false, ...(user ? {} : {}) } }),
    'account/refresh_auth_token': (body) => {
      const found = state.sessions.find(
        (item) => item.refreshToken === body.refresh_token && !item.revoked,
      );
      if (!found) return fail(1101010111, 'refresh expired');
      found.authToken = 'at_' + randomBytes(12).toString('hex');
      found.refreshToken = 'rt_' + randomBytes(12).toString('hex');
      state.refreshes += 1;
      return ok({ data: { auth_token: found.authToken, refresh_token: found.refreshToken } });
    },
    'account/logout': (body) => {
      const found = state.sessions.find((item) => item.refreshToken === body.refresh_token);
      if (found) found.revoked = true;
      return ok();
    },
    'user/get_my_homepage': () =>
      ok({
        data: {
          profile: { name: 'Mock Creator', unique_id: '10086' },
          wallet_info: { gem_balance: state.gems },
        },
      }),
    'wallet/get_wallet_page': () => {
      if (state.walletFailures > 0) {
        state.walletFailures -= 1;
        return fail(50300, 'wallet unavailable');
      }
      return ok({ data: { balance: { total_amount: state.gems } } });
    },
    'ugc/voice/catalog': () => ok({ catalog_version: 'mock-v1', voices: MOCK_VOICES }),
    'npc/list_ugc_tags': (body) => {
      const start = body.cursor === 'page2' ? 2 : 0;
      const page = MOCK_TAGS.slice(start, start + 2);
      return ok({
        tags: page,
        next_cursor: start === 0 ? 'page2' : '',
        has_more: start === 0,
        max_select: 10,
      });
    },
    'npc/create_ugc_image_upload': (body) => {
      if (typeof body.client_request_id !== 'string') return fail(400, 'client_request_id');
      const id = uploadRequests.get(body.client_request_id) ?? nextId();
      uploadRequests.set(body.client_request_id, id);
      const upload: Upload = state.uploads.get(id) ?? {
        id,
        purpose: String(body.purpose),
        mime: String(body.mime_type),
        size: Number(body.size_bytes),
        bytes: null,
        status: 0,
      };
      state.uploads.set(id, upload);
      return ok({
        upload: {
          upload_id: BigInt(id),
          purpose: upload.purpose,
          mime_type: upload.mime,
          size_bytes: upload.size,
          review_status: 0,
        },
        upload_url: `${origin}/upload/${id}`,
        expires_at_ms: Date.now() + 600_000,
      });
    },
    'npc/review_ugc_image': (body) => {
      const upload = state.uploads.get(String(body.upload_id));
      if (!upload) return fail(404, 'upload not found');
      if (!upload.bytes || upload.bytes.length !== upload.size) return fail(409, 'not uploaded');
      upload.status = upload.bytes.includes(Buffer.from('REJECT')) ? 2 : 1;
      return ok({
        upload: {
          upload_id: BigInt(upload.id),
          purpose: upload.purpose,
          mime_type: upload.mime,
          size_bytes: upload.size,
          review_status: upload.status,
          ...(upload.status === 1
            ? { image_url: `https://cdn.example.test/ugc/${upload.id}` }
            : { reason_code: 'unsafe' }),
        },
      });
    },
    'npc/create_ugc_character': (body) => {
      const requestId = String(body.client_request_id ?? '');
      const content = (body.content ?? {}) as Json;
      if (!requestId) return fail(400, 'client_request_id');
      const replay = [...state.characters.values()].find((item) => item.requestId === requestId);
      if (replay)
        return ok({
          character: {
            npc_id: BigInt(replay.npcId),
            version: 1,
            review_state: 1,
            published_version: 0,
          },
        });
      if (content.declaration_accepted !== true) return fail(400, 'declaration');
      for (const key of ['cover', 'avatar']) {
        const ref = (content[key] ?? {}) as Json;
        const upload = state.uploads.get(String(ref.upload_id));
        if (!upload || upload.status !== 1 || upload.purpose !== key)
          return fail(400, `${key} not passed`);
      }
      if (String(content.description ?? '').includes('REJECT_TEXT'))
        return fail(42201, 'text rejected');
      const voices = (
        (content.features as Json | undefined)?.voice_configuration as Json | undefined
      )?.voices;
      if (
        !Array.isArray(voices) ||
        !voices.every((v) => MOCK_VOICES.some((m) => m.voice_id === (v as Json).voice_id))
      )
        return fail(400, 'voice');
      const npcId = nextId();
      state.characters.set(npcId, { npcId, content, requestId });
      return ok({
        character: { npc_id: BigInt(npcId), version: 1, review_state: 1, published_version: 0 },
      });
    },
    'ugc/begin_ugc_draft': (body) => {
      const key = String(body.client_request_id ?? '');
      if (!/^draft_[0-9a-f]{32}$/.test(key)) return fail(400, 'client_request_id');
      let draft = state.drafts.get(key);
      if (!draft) {
        draft = { draftId: nextId(), quotaUsed: 0, counter: 0n, stream: '' };
        state.drafts.set(key, draft);
      }
      return ok({
        draft: { draft_id: BigInt(draft.draftId), kind: 1, state: 1, mutation_revision: 1 },
      });
    },
    'ugc/prepare_ugc_preview': (body) => {
      const draft = [...state.drafts.values()].find(
        (item) => item.draftId === String(body.draft_id),
      );
      if (!draft) return fail(404, 'draft');
      const match = /^pv2_([0-9a-f]{32})_([1-9][0-9]*)_([0-9a-f]{32})$/.exec(
        String(body.entry_request_id ?? ''),
      );
      if (!match) return fail(400, 'entry_request_id');
      const entryCounter = BigInt(match[2]);
      if ((draft.stream && draft.stream !== match[1]) || entryCounter <= draft.counter)
        return fail(409, 'stale entry');
      draft.stream = match[1];
      draft.counter = entryCounter;
      const character = (body.character ?? {}) as Json;
      const content = (character.content ?? {}) as Json;
      const npcId = character.preview_npc_id ? String(character.preview_npc_id) : nextId();
      const preview: Preview = {
        cid: nextId(),
        draftId: draft.draftId,
        npcId,
        name: String(content.name ?? ''),
        closed: false,
        messages: [],
      };
      state.previews.set(preview.cid, preview);
      return ok({
        preview: {
          cid: BigInt(preview.cid),
          draft_id: BigInt(draft.draftId),
          preview_npc_id: BigInt(npcId),
          state: 2,
          entry_request_id: body.entry_request_id,
          quota: quotaOf(draft, 1),
          mutation_revision: 2,
          kind: 1,
        },
        opening_paragraphs: openingParagraphs(
          String(content.opening_message ?? ''),
          npcId,
          preview.name,
        ).map(paragraphJson),
        introduction_presentation: { mode: 1, text: String(content.description ?? '') },
        opening_status: 1,
      });
    },
    'conversation/send_message': (body) => {
      if (body.preview_cid === undefined && body.entity_id !== undefined) return sendOrdinary(body);
      const preview = state.previews.get(String(body.preview_cid));
      if (!preview || preview.closed) return fail(404, 'preview');
      const draft = [...state.drafts.values()].find((item) => item.draftId === preview.draftId)!;
      const free = draft.quotaUsed < FREE_LIMIT;
      if (!free) {
        if (body.consumption_mode !== 1) return fail(402, 'free messages used up');
        if (state.gems < PAID_PRICE) return fail(1504011011, 'insufficient gems');
        state.gems -= PAID_PRICE;
      }
      draft.quotaUsed += 1;
      const mid = nextId();
      const assistantMid = nextId();
      const streamId = 'st_' + randomBytes(6).toString('hex');
      preview.messages.push({
        mid: BigInt(mid),
        cid: BigInt(preview.cid),
        sender_type: 1,
        content: { text: String(body.text ?? '') },
        timestamp: Date.now(),
      });
      streamReply(preview, String(body.text ?? ''), assistantMid, streamId);
      return ok({
        data: {
          cid: BigInt(preview.cid),
          mid: BigInt(mid),
          assistant_mid: BigInt(assistantMid),
          stream_id: streamId,
          preview_quota: quotaOf(draft, 1 + draft.quotaUsed),
        },
      });
    },
    'ugc/list_ugc_preview_messages': (body) => {
      const preview = state.previews.get(String(body.cid));
      if (!preview) return fail(404, 'preview');
      const draft = [...state.drafts.values()].find((item) => item.draftId === preview.draftId)!;
      return ok({
        messages: preview.messages,
        has_more: false,
        quota: quotaOf(draft, 1 + draft.quotaUsed),
      });
    },
    'ugc/close_ugc_preview': (body) => {
      const preview = state.previews.get(String(body.cid));
      if (preview) preview.closed = true;
      return ok({ preview: { cid: body.cid, state: 3 } });
    },
    // Ordinary chat: conversation answers are flat beside base_resp; the profile and the
    // persona list are wrapped in `data`.
    'npc/get_npc_profile': (body) => {
      const npc = npcOf(body.npc_id);
      return npc ? ok({ data: profileJson(npc) }) : removed();
    },
    'user/get_conversation_persona_list': (body) => {
      const context = (body.context ?? {}) as Json;
      if (context.npc_id !== undefined && !npcOf(context.npc_id)) return removed();
      return ok({
        data: {
          items: [{ persona: { persona_id: PERSONA_ID, name: '旅人' }, is_current: true }],
          current_persona_id: PERSONA_ID,
        },
      });
    },
    'conversation/get_conversation_info_by_entity': (body) => {
      const npc = npcOf(body.entity_id);
      if (!npc) return removed();
      const chat = state.chats.get(npc.npcId);
      return ok(
        chat
          ? { has_conversation: true, conversation_id: BigInt(chat.cid) }
          : { has_conversation: false },
      );
    },
    'conversation/list_roaming_messages': (body) => {
      const chat = [...state.chats.values()].find((item) => item.cid === String(body.cid));
      if (!chat) return fail(404, 'conversation not found');
      const limit = Math.min(Math.max(Math.trunc(Number(body.limit)) || 30, 1), 100);
      return ok({
        messages: [...chat.messages].sort(newestFirst).slice(0, limit),
        has_more: false,
      });
    },
    'conversation/list_roaming_conversation_infos': () =>
      ok({
        conversation_infos: [...state.chats.values()].map((chat) => ({
          conversation_id: BigInt(chat.cid),
          entity_id: BigInt(chat.npcId),
          entity_type: NPC_ENTITY_TYPE,
          latest_message: [...chat.messages].sort(newestFirst)[0],
        })),
        has_more: false,
      }),
    'conversation/get_chat_preference': (body) =>
      npcOf(body.entity_id)
        ? ok({ user_chat_preference: { reply_cost_diamonds: state.replyCost } })
        : removed(),
    'conversation/get_message_feedback_config': () => ok(FEEDBACK_CONFIG),
    'conversation/submit_message_feedback': (body) => {
      const npc = npcOf(body.entity_id);
      if (!npc) return removed();
      const reply = state.chats
        .get(npc.npcId)
        ?.messages.find(
          (message) =>
            String(message.mid) === String(body.mid) &&
            message.sender_type === SenderType.assistant,
        );
      if (!reply || !offered(body.tag_keys, FEEDBACK_CONFIG)) return fail(400, 'invalid feedback');
      state.feedback.push(body);
      return ok({ feedback_id: BigInt(nextId()), created: true });
    },
    'conversation/get_npc_report_config': () => ok(REPORT_CONFIG),
    'conversation/submit_npc_report': (body) => {
      if (!npcOf(body.npc_id)) return removed();
      if (!offered(body.tag_keys, REPORT_CONFIG)) return fail(400, 'invalid report');
      state.npcReports.push(body);
      return ok({ report_id: BigInt(nextId()), created: true });
    },
    'relay/get_policy': () => ok({ data: state.relayPolicy }),
    'connection/poll_message': (body) => {
      const size = Math.min(Math.max(Math.trunc(Number(body.size)) || 50, 1), 100);
      const messages = state.msgbox.splice(0, size);
      return ok({ messages, has_more: state.msgbox.length > 0 });
    },
  };
  /** Routes the mock has only while a test sets them up. */
  const present = (path: string) => path !== 'relay/get_policy' || state.relayPolicy !== null;

  const PUBLIC = new Set(['account/login', 'account/refresh_auth_token']);

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/cli/auth')
        return respond(response, 200, WEB_PAGE(idToken()), 'text/html; charset=utf-8');
      if (request.method === 'PUT' && url.pathname.startsWith('/upload/')) {
        const upload = state.uploads.get(url.pathname.slice('/upload/'.length));
        if (!upload) return respond(response, 404, 'no upload', 'text/plain');
        if (request.headers['x-token'])
          return respond(response, 400, 'credentials on a presigned PUT', 'text/plain');
        upload.bytes = await readBody(request);
        return respond(response, 200, '', 'text/plain');
      }
      if (request.method !== 'POST' || !url.pathname.startsWith('/ember/api/v1/'))
        return respond(response, 404, fail(404, 'not found'));
      const raw = (await readBody(request)).toString('utf8');
      const timestamp = String(request.headers['x-timestamp'] ?? '');
      if (!timestamp || request.headers['x-sign'] !== sign(request.url ?? '', raw, timestamp))
        return respond(response, 400, fail(400, 'invalid request signature'));
      if (url.searchParams.get('app_id') !== '50010')
        return respond(response, 400, fail(400, 'valid app_id required'));
      const path = url.pathname.slice('/ember/api/v1/'.length);
      const body = (raw ? parseGatewayJson(raw) : {}) as Json;
      state.requests.push({ path, body, headers: request.headers });
      const handler = present(path) ? routes[path] : undefined;
      if (!handler) return respond(response, 404, fail(404, `mock has no ${path}`));
      const user = session(request.headers['x-token'] as string | undefined);
      if (!PUBLIC.has(path)) {
        if (!user) return respond(response, 401, fail(401, 'X-Token required'));
        if (
          url.searchParams.get('user_id') !== USER_ID ||
          url.searchParams.get('device_id') !== user.deviceId
        )
          return respond(response, 401, fail(40103, 'identity mismatch'));
      }
      return respond(response, 200, handler(body, user));
    } catch (error) {
      return respond(
        response,
        500,
        fail(500, error instanceof Error ? error.message : 'mock error'),
      );
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://mock');
    if (state.offline) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const found = state.sessions.find(
      (item) => item.refreshToken === url.searchParams.get('token') && !item.revoked,
    );
    if (
      url.pathname !== '/connection/ws' ||
      !found ||
      url.searchParams.get('user_id') !== USER_ID
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      state.sockets += 1;
      ws.send(
        encodePacket({
          command: Command.loginSuccess,
          payload: new TextEncoder().encode(
            JSON.stringify({
              conn_id: 'mock-conn',
              user_id: USER_ID,
              device_id: found.deviceId,
              hb_interval: 30,
            }),
          ),
        }),
      );
      ws.on('message', (data: Buffer) => {
        try {
          decodePacket(new Uint8Array(data));
        } catch {
          ws.close();
        }
      });
      ws.on('close', () => sockets.delete(ws));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  const dropSockets = () => {
    for (const socket of sockets) socket.terminate();
  };
  return {
    origin,
    port,
    state,
    idToken,
    dropSockets,
    setOffline: (offline) => {
      state.offline = offline;
      if (offline) dropSockets();
    },
    replyFromAnotherDevice: (npcId, text) => {
      const npc = npcOf(npcId);
      if (!npc) throw new Error(`mock has no published character ${npcId}`);
      const turn = startTurn(chatOf(npc.npcId), text);
      return { streamId: turn.streamId, assistantMid: turn.assistantMid };
    },
    pushAside: (npcId, aside) => {
      const asideId = 'aside_' + randomBytes(6).toString('hex');
      const payload = encodeAsideEvent({
        asideId,
        entityId: npcId,
        entityType: NPC_ENTITY_TYPE,
        cid: aside.cid ?? state.chats.get(npcId)?.cid ?? '',
        anchorMid: aside.anchorMid ?? '',
        aside: {
          scene: aside.scene,
          style: 1,
          texts: [{ text: aside.text, schema: '' }],
          title: '',
          iconUrl: '',
          buttons: [],
        },
        createdAt: Date.now(),
      });
      deliver(BusinessType.conversationAside, Command.business, payload);
      return asideId;
    },
    expireAuthTokens: () => {
      for (const item of state.sessions) item.authToken = 'at_' + randomBytes(12).toString('hex');
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const socket of sockets) socket.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
