import { ApiError, type Gateway, NotSignedIn } from '../core/api.js';
import { tr } from '../core/i18n.js';
import {
  count,
  flag,
  i64,
  id,
  type Json,
  list,
  number,
  object,
  optionalId,
  optionalObject,
  text,
} from '../core/json.js';
import {
  type ImMessage,
  type ImParagraph,
  NPC_ENTITY_TYPE,
  parseMessage,
  parseParagraph,
} from '../im/models.js';
import { packet, type Packet, fromBase64 } from '../im/packet.js';

/**
 * Ordinary chat with a published character, as the Yomi web client makes the calls: signed
 * Gateway routes, i64 IDs as bare numbers, conversation answers flat beside `base_resp`.
 * `yomi relay` adds what the relay contract asks of the server (`relay/get_policy` says which are honoured): a
 * `client_request_id` on every send, `consumption_mode`, a spend cap, and the server's own refusal
 * names in `relay_error`.
 */

const entity = (npcId: string): Json => ({ entity_id: i64(npcId), entity_type: NPC_ENTITY_TYPE });

/** `ConsumptionMode` as the preview sends it: 0 free messages only, 1 may pay. */
export const ConsumptionMode = { freeOnly: 0, allowPaid: 1 } as const;

/** Why the server would not do it, in the relay's own words (`refusalOf`). */
export type RefusalKind =
  | 'gems'
  | 'membership'
  | 'freeExhausted'
  | 'spendCap'
  | 'rateLimited'
  | 'busy'
  | 'ageGate'
  | 'unavailable'
  | 'disabled'
  | 'tooOld'
  | 'dialog'
  | 'other';

/** A refusal of a chat call: what the person needs to hear, never a retry. */
export class ChatRefusal extends Error {
  constructor(
    public readonly kind: RefusalKind,
    /** The business code, or the contract's `relay_error` name. */
    public readonly code: string,
    message: string,
    /** The server's own dialog (`model_unavailable_dialog`): title and content, no links. */
    public readonly dialog: { title: string; content: string } | null = null,
    public readonly retryAfterMs = 0,
  ) {
    super(message || code);
    this.name = 'ChatRefusal';
  }
}

/** Codes the web knows. */
export const INSUFFICIENT_GEMS = new Set([40201, 1504011011, 402]);
export const MEMBERSHIP_QUOTA = 1504011021;
/** The character was taken down. */
export const CHARACTER_REMOVED = 41001;

/** `relay_error` names from the relay contract, and what each means here. */
const RELAY_ERRORS: Record<string, RefusalKind> = {
  INSUFFICIENT_GEMS: 'gems',
  FREE_QUOTA_EXHAUSTED: 'freeExhausted',
  SPEND_CAP_EXCEEDED: 'spendCap',
  RATE_LIMITED: 'rateLimited',
  CONVERSATION_BUSY: 'busy',
  AGE_VERIFICATION_REQUIRED: 'ageGate',
  CONTENT_RATING_BLOCKED: 'ageGate',
  CHARACTER_UNAVAILABLE: 'unavailable',
  CHANNEL_DISABLED: 'disabled',
  CLIENT_TOO_OLD: 'tooOld',
};

function dialogOf(body: Json | null): { title: string; content: string } | null {
  const raw = body ? optionalObject(body.model_unavailable_dialog) : {};
  const title = text(raw.title).trim();
  const content = text(raw.content).trim();
  return title || content ? { title, content } : null;
}

/**
 * A Gateway refusal as a `ChatRefusal`, or the error itself (sign-in, transport, abort). The
 * contract's `relay_error` wins over the numeric code; gems win over a dialog, as on the web.
 */
export function refusalOf(error: unknown): unknown {
  if (!(error instanceof ApiError) || error instanceof NotSignedIn) return error;
  const body = error.body;
  const named = body ? text(body.relay_error) : '';
  const retryAfterMs = body ? count(body.retry_after_ms) : 0;
  const dialog = dialogOf(body);
  // A named refusal is one whatever the HTTP status or status_code says (contract §3.5).
  if (named && RELAY_ERRORS[named])
    return new ChatRefusal(RELAY_ERRORS[named], named, error.message, dialog, retryAfterMs);
  // HTTP 429 was turned away at the door: not accepted, not charged.
  if (error.code === ApiError.transport && error.httpStatus === 429)
    return new ChatRefusal('rateLimited', '429', error.message, dialog, retryAfterMs);
  if (error.code === ApiError.transport || error.needsSignIn) return error;
  if (INSUFFICIENT_GEMS.has(error.code))
    return new ChatRefusal('gems', String(error.code), error.message, dialog);
  if (error.code === MEMBERSHIP_QUOTA)
    return new ChatRefusal('membership', String(error.code), error.message, dialog);
  if (error.code === CHARACTER_REMOVED)
    return new ChatRefusal('unavailable', String(error.code), error.message, dialog);
  if (error.code === 429)
    return new ChatRefusal('rateLimited', '429', error.message, dialog, retryAfterMs);
  if (dialog) return new ChatRefusal('dialog', String(error.code), error.message, dialog);
  return new ChatRefusal('other', String(error.code), error.message, null);
}

async function chat(gateway: Gateway, path: string, body: unknown, signal?: AbortSignal) {
  try {
    return await gateway.request(path, body, { signal, timeoutMs: 30_000 });
  } catch (error) {
    throw refusalOf(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Sending

export type SendRequest = {
  npcId: string;
  text: string;
  /** Unique per user message; the same one on a retry (the contract's idempotency key). */
  clientRequestId: string;
  consumptionMode: number;
  /** The most this reply may cost (contract `max_cost_diamonds`); left out when unknown. */
  maxCostDiamonds?: number;
  signal?: AbortSignal;
};

export type SendAnswer = {
  /** The user message. */
  mid: string;
  streamId: string;
  assistantMid: string;
  cid: string;
  /** What the server charged for this reply, when it says (contract `charged_diamonds`). */
  chargedDiamonds: number | null;
  /** Notices the server wants shown with this turn, verbatim (contract `notices`). */
  notices: string[];
};

/** `conversation/send_message` for a published character. Never retried here. */
export async function sendMessage(gateway: Gateway, request: SendRequest): Promise<SendAnswer> {
  const body: Json = {
    ...entity(request.npcId),
    text: request.text,
    client_request_id: request.clientRequestId,
    consumption_mode: request.consumptionMode,
  };
  if (request.maxCostDiamonds !== undefined) body.max_cost_diamonds = request.maxCostDiamonds;
  const result = await chat(gateway, 'conversation/send_message', body, request.signal);
  const named = text(result.relay_error);
  if (named && RELAY_ERRORS[named])
    throw new ChatRefusal(
      RELAY_ERRORS[named],
      named,
      '',
      dialogOf(result),
      count(result.retry_after_ms),
    );
  const mid = optionalId(result.mid);
  const streamId = text(result.stream_id);
  if (!mid || !streamId)
    throw new ApiError(
      ApiError.transport,
      tr(
        '发送回包缺少 mid 或 stream_id',
        'The send response has no mid or stream_id',
        'La respuesta del envío no tiene mid ni stream_id',
        'A resposta do envio não tem mid nem stream_id',
      ),
      result,
      'conversation/send_message',
    );
  const charged = result.charged_diamonds;
  return {
    mid,
    streamId,
    assistantMid: optionalId(result.assistant_mid),
    cid: optionalId(result.cid),
    chargedDiamonds: charged === undefined || charged === null ? null : count(charged),
    notices: noticesOf(result.notices),
  };
}

/** The contract's `notices`: `[{scene, text}]`, verbatim texts only. */
export function noticesOf(value: unknown): string[] {
  return list(value)
    .map((item) => text(optionalObject(item).text).trim())
    .filter(Boolean)
    .slice(0, 5);
}

// ---------------------------------------------------------------------------------------------
// Reading

/** `conversation/list_roaming_messages`: newest first, at most `limit`. */
export async function listMessages(
  gateway: Gateway,
  cid: string,
  limit = 20,
): Promise<ImMessage[]> {
  const result = await chat(gateway, 'conversation/list_roaming_messages', {
    cid: i64(cid),
    limit: Math.min(Math.max(limit, 1), 100),
  });
  return list(result.messages).map(parseMessage);
}

/** `get_conversation_info_by_entity`: the conversation with `npcId`, '' when there is none yet. */
export async function conversationId(gateway: Gateway, npcId: string): Promise<string> {
  const result = await chat(gateway, 'conversation/get_conversation_info_by_entity', entity(npcId));
  return flag(result.has_conversation) ? optionalId(result.conversation_id) : '';
}

/** The conversation with `npcId` (`list_roaming_conversation_infos`), '' when there is none yet. */
export async function findConversation(
  gateway: Gateway,
  npcId: string,
  pages = 10,
): Promise<string> {
  let cursor = '';
  for (let page = 0; page < pages; page++) {
    const body: Json = { limit: 100 };
    if (cursor) body.cursor = cursor;
    const result = await chat(gateway, 'conversation/list_roaming_conversation_infos', body);
    for (const info of list(result.conversation_infos)) {
      const raw = optionalObject(info);
      if (count(raw.entity_type) === NPC_ENTITY_TYPE && optionalId(raw.entity_id) === npcId)
        return optionalId(raw.conversation_id);
    }
    const next = text(result.next_cursor);
    if (!flag(result.has_more) || !next || next === cursor) return '';
    cursor = next;
  }
  return '';
}

/** `connection/poll_message`: packets kept while no socket was open (base64 payloads). */
export async function pollMessages(
  gateway: Gateway,
  size = 50,
): Promise<{ packets: Packet[]; hasMore: boolean }> {
  const result = await chat(gateway, 'connection/poll_message', { size });
  const numeric = (value: unknown) =>
    typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : count(value);
  const packets = list(result.messages).map((value) => {
    const raw = optionalObject(value);
    return packet({
      command: numeric(raw.cmd),
      businessType: numeric(raw.biz_type),
      traceId: text(raw.trace_id),
      sid: numeric(raw.sid),
      sentAt: numeric(raw.send_at),
      userId: text(raw.user_id),
      deviceId: text(raw.device_id),
      sequenceId:
        raw.seq_id === undefined || raw.seq_id === null ? '0' : String(raw.seq_id).trim() || '0',
      payload: fromBase64(text(raw.payload)),
    });
  });
  return { packets, hasMore: flag(result.has_more) };
}

export type CharacterProfile = {
  npcId: string;
  name: string;
  /** A group chat (WorldView: `worldview_info` present): lines name their speakers. */
  group: boolean;
  /** `OpeningStatus`: 1 Ready, 2 Unavailable (no opening, no fallback). */
  openingStatus: number;
  openingParagraphs: ImParagraph[];
  /** `PrivacySetting`: 1 public, 2 private, 3 unlisted; 0 when absent. */
  visibility: number;
};

/** `npc/get_npc_profile` → `{data: NpcProfile}`. */
export async function characterProfile(gateway: Gateway, npcId: string): Promise<CharacterProfile> {
  let data: Json;
  try {
    data = await gateway.requestData(
      'npc/get_npc_profile',
      { npc_id: i64(npcId) },
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    throw refusalOf(error);
  }
  const name = text(data.name).trim();
  return {
    npcId: optionalId(data.npc_id) || npcId,
    name: name || tr('角色', 'Character', 'Personaje', 'Personagem'),
    group: data.worldview_info !== undefined && data.worldview_info !== null,
    openingStatus: count(data.opening_status),
    openingParagraphs: list(data.opening_paragraphs).map(parseParagraph),
    visibility: count(data.visibility),
  };
}

/** The opening the app shows: Ready with paragraphs, else none. */
export function openingOf(profile: CharacterProfile): ImParagraph[] {
  if (profile.openingStatus !== 1) return [];
  return profile.openingParagraphs.filter((paragraph) => paragraph.text.trim());
}

/** The persona name the app uses for `{{user}}` with this character, '' when none. */
export async function personaName(gateway: Gateway, npcId: string): Promise<string> {
  let data: Json;
  try {
    data = await gateway.requestData('user/get_conversation_persona_list', {
      context: { npc_id: i64(npcId) },
    });
  } catch {
    return '';
  }
  const items = list(data.items).map((item) => optionalObject(item));
  const wanted = optionalId(data.current_persona_id) || optionalId(data.default_persona_id);
  const chosen =
    items.find((item) => flag(item.is_current)) ??
    items.find((item) => optionalId(optionalObject(item.persona).persona_id) === wanted);
  return text(optionalObject(chosen?.persona).name).trim();
}

/** `get_chat_preference.reply_cost_diamonds`: display only; null when the server left it out. */
export async function replyCost(gateway: Gateway, npcId: string): Promise<number | null> {
  const result = await chat(gateway, 'conversation/get_chat_preference', entity(npcId));
  const preference = optionalObject(result.user_chat_preference);
  const value = preference.reply_cost_diamonds;
  if (value === undefined || value === null) return null;
  const cost = number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

// ---------------------------------------------------------------------------------------------
// Reporting

export type FeedbackReason = { key: string; label: string; section: string; isReport: boolean };

function reasonsOf(result: Json): FeedbackReason[] {
  const reasons: FeedbackReason[] = [];
  for (const value of list(result.sections)) {
    const section = optionalObject(value);
    for (const tag of list(section.tags)) {
      const raw = optionalObject(tag);
      const key = text(raw.key);
      if (key)
        reasons.push({
          key,
          label: text(raw.label) || key,
          section: text(section.title),
          isReport: flag(section.is_report),
        });
    }
  }
  return reasons;
}

/** `conversation/get_message_feedback_config`: the reasons the app offers for one reply. */
export async function feedbackReasons(gateway: Gateway): Promise<FeedbackReason[]> {
  return reasonsOf(await chat(gateway, 'conversation/get_message_feedback_config', {}));
}

/** `conversation/get_npc_report_config`: the reasons for reporting a character. */
export async function characterReportReasons(gateway: Gateway): Promise<FeedbackReason[]> {
  return reasonsOf(await chat(gateway, 'conversation/get_npc_report_config', {}));
}

/** `conversation/submit_npc_report`: one per (person, character); a resubmit replaces it. */
export async function submitCharacterReport(
  gateway: Gateway,
  npcId: string,
  tagKeys: string[],
  comment = '',
): Promise<void> {
  const body: Json = { npc_id: i64(npcId), tag_keys: tagKeys };
  if (comment) body.comment = comment.slice(0, 500);
  await chat(gateway, 'conversation/submit_npc_report', body);
}

/** `conversation/submit_message_feedback` on one assistant message. */
export async function submitFeedback(
  gateway: Gateway,
  npcId: string,
  mid: string,
  tagKeys: string[],
  comment = '',
): Promise<void> {
  const body: Json = { ...entity(npcId), mid: i64(mid), tag_keys: tagKeys };
  if (comment) body.comment = comment.slice(0, 500);
  await chat(gateway, 'conversation/submit_message_feedback', body);
}

export { id, object };
