import { randomUUID } from 'node:crypto';

import type { Gateway } from '../core/api.js';
import { tr } from '../core/i18n.js';
import { i64, type Json, idOf } from '../core/json.js';
import type { LocalState } from '../core/state.js';
import { type ImParagraph, parseContent, parseParagraph } from '../im/models.js';
import { call, UgcFailure, wireIds } from './api.js';

/**
 * The preview chat, one character, as the app runs it: a conversation with the character as the
 * file says now, on its own CID, never the real conversations.
 *
 * 1. `ugc/begin_ugc_draft` once per local draft (`client_request_id` = the local draftId).
 * 2. Each entry: `ugc/prepare_ugc_preview` with an ordered entry ID and the whole content → a new
 *    CID, the preview NPC, the free messages (`quota`), the opening.
 * 3. `conversation/send_message` with `preview_cid`; replies stream on business type 5 and are
 *    read back with `ugc/list_ugc_preview_messages`. The server counts the free messages; at 0 a
 *    send goes with `consumption_mode` 1 (paid) only after the person agreed.
 * 4. `ugc/close_ugc_preview` on the way out.
 */

export type PreviewQuota = { limit: number; used: number; remaining: number; version: number };

export function readQuota(value: unknown): PreviewQuota | null {
  const quota = (value ?? null) as Json | null;
  if (!quota) return null;
  const remaining = Number(quota.remaining);
  if (!Number.isInteger(remaining) || remaining < 0) return null;
  return {
    limit: Number(quota.limit) || 0,
    used: Number(quota.used) || 0,
    remaining,
    version: Number(quota.version) || 0,
  };
}

/** The newer of two quota readings (by `version`). */
export const newerQuota = (current: PreviewQuota, next: PreviewQuota | null) =>
  next && next.version >= current.version ? next : current;

export type PreparedPreview = {
  cid: string;
  draftId: string;
  previewNpcId: string;
  quota: PreviewQuota;
  /** `IntroductionPresentation`: 1 text, 2 root HTML, 3 plain fallback. */
  introduction: { mode: number; text: string };
  /** 1 Ready, 2 Unavailable. */
  openingStatus: number;
  openingParagraphs: ImParagraph[];
};

/** `begin_ugc_draft`, kept in the local state from then on. */
export async function ensureServerDraft(gateway: Gateway, state: LocalState, source: string) {
  const draft = state.draft(source);
  if (draft.serverDraftId) return draft.serverDraftId;
  const result = await call(
    gateway,
    'ugc/begin_ugc_draft',
    wireIds({ client_request_id: draft.draftId, kind: 1 }),
  );
  const allocated = (result.draft ?? {}) as Json;
  const id = idOf(allocated.draft_id);
  if (!id || id === '0')
    throw new UgcFailure(
      'PROTOCOL',
      tr('草稿分配回包没有 draft_id', 'The draft response has no draft_id'),
    );
  state.updateDraft(source, {
    serverDraftId: id,
    mutationRevision: idOf(allocated.mutation_revision) || '0',
  });
  return id;
}

export async function preparePreview(
  gateway: Gateway,
  state: LocalState,
  source: string,
  content: Json,
): Promise<PreparedPreview> {
  const serverDraftId = await ensureServerDraft(gateway, state, source);
  const draft = state.draft(source);
  const entryRequestId = state.nextPreviewId(source);
  const character: Json = { member_key: 'single', content };
  if (draft.previewNpcId) character.preview_npc_id = draft.previewNpcId;
  const response = await call(
    gateway,
    'ugc/prepare_ugc_preview',
    wireIds({ draft_id: serverDraftId, entry_request_id: entryRequestId, character }),
  );
  const preview = (response.preview ?? {}) as Json;
  const cid = idOf(preview.cid);
  const npc = idOf(preview.preview_npc_id);
  const quota = readQuota(preview.quota);
  if (
    idOf(preview.draft_id) !== serverDraftId ||
    !cid ||
    cid === '0' ||
    !npc ||
    npc === '0' ||
    Number(preview.state) !== 2 ||
    !quota
  )
    throw new UgcFailure('PROTOCOL', tr('预演回包不完整', 'The preview response is incomplete'));
  state.updateDraft(source, {
    previewNpcId: npc,
    mutationRevision: idOf(preview.mutation_revision) || draft.mutationRevision,
  });
  const intro = (response.introduction_presentation ?? null) as Json | null;
  const mode = Number(intro?.mode);
  const text = typeof intro?.text === 'string' ? intro.text : null;
  const status = Number(response.opening_status ?? 1);
  const paragraphs =
    status === 2
      ? []
      : (Array.isArray(response.opening_paragraphs) ? response.opening_paragraphs : []).map(
          parseParagraph,
        );
  const usable = status === 2 || (status === 1 && paragraphs.some((paragraph) => paragraph.text));
  // A server without the shared presentation cannot show this preview: close the CID it made.
  if (text === null || ![1, 2, 3].includes(mode) || !usable) {
    await closePreview(gateway, cid);
    throw new UgcFailure(
      'VERSION_MISMATCH',
      tr(
        '服务端版本与预演协议不匹配，请稍后再试',
        "The server's version doesn't match the preview protocol; try again later",
      ),
    );
  }
  return {
    cid,
    draftId: serverDraftId,
    previewNpcId: npc,
    quota,
    introduction: { mode, text },
    openingStatus: status,
    openingParagraphs: paragraphs,
  };
}

export function closePreview(gateway: Gateway, cid: string) {
  return call(gateway, 'ugc/close_ugc_preview', wireIds({ cid })).then(
    () => true,
    () => false,
  );
}

export type PreviewMessage = {
  mid: string;
  user: boolean;
  text: string;
  paragraphs: ImParagraph[];
};

/** `list_ugc_preview_messages`: what the CID holds now (the server's truth). */
export async function listPreviewMessages(gateway: Gateway, cid: string) {
  const result = await call(gateway, 'ugc/list_ugc_preview_messages', wireIds({ cid, limit: 100 }));
  const messages: PreviewMessage[] = [];
  for (const value of Array.isArray(result.messages) ? result.messages : []) {
    const message = value as Json;
    const mid = idOf(message.mid);
    const sender = Number(message.sender_type);
    if (idOf(message.cid) !== cid || !mid || mid === '0' || (sender !== 1 && sender !== 2))
      throw new UgcFailure(
        'PROTOCOL',
        tr('预演消息回包不合法', 'The preview messages response is invalid'),
      );
    const content = parseContent(message.content);
    messages.push({ mid, user: sender === 1, text: content.text, paragraphs: content.paragraphs });
  }
  return { messages, quota: readQuota(result.quota) };
}

export type SendAck = {
  mid: string;
  assistantMid: string;
  streamId: string;
  quota: PreviewQuota | null;
};

/** Codes that mean the gems ran out (`GenerationRefusal`). */
export const INSUFFICIENT_GEMS = new Set(['402', '40201', '1504011011']);

/** One turn (`send_message` with `preview_cid`); paid only once the person allowed it. */
export async function sendPreviewMessage(
  gateway: Gateway,
  cid: string,
  text: string,
  paid: boolean,
  requestId = randomUUID(),
): Promise<SendAck> {
  const ack = await call(gateway, 'conversation/send_message', {
    preview_cid: i64(cid),
    client_request_id: requestId,
    text,
    consumption_mode: paid ? 1 : 0,
  });
  const data = (ack.data ?? ack) as Json;
  const mid = idOf(data.mid);
  const assistant = idOf(data.assistant_mid);
  const stream = typeof data.stream_id === 'string' ? data.stream_id : '';
  if (idOf(data.cid) !== cid || !mid || !assistant || !stream)
    throw new UgcFailure('PROTOCOL', tr('发送回包不完整', 'The send response is incomplete'));
  return { mid, assistantMid: assistant, streamId: stream, quota: readQuota(data.preview_quota) };
}
