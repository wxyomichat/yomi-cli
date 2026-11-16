import type { Gateway } from '../core/api.js';
import { encodeBody, type Json, idOf, RawBody } from '../core/json.js';
import { type LocalState, sha256 } from '../core/state.js';
import { markVideosBound } from '../gen/ugcVideo.js';
import { call, UgcFailure, wireIds } from './api.js';
import { contentForSubmission, type ResolvedCharacter } from './character.js';

/**
 * `npc/create_ugc_character` as the app submits: the whole request frozen with its
 * `client_request_id` before it goes; an unknown answer (network) is retried with the same frozen
 * request, even if the file changed since; a clear refusal (400 / 403 / 409 / 422 / 42201 / 50301)
 * frees it.
 * Create makes a Pending review version at once (no separate submit). The server runs the text
 * review synchronously: 42201 refused, 50301 unavailable.
 */

export const ReviewState: Record<number, string> = { 1: '审核中', 2: '已通过', 3: '未通过' };

export type CreateOutcome = {
  npcId: string;
  version: string;
  reviewState: number;
  reasonCode: string;
  /** The earlier unconfirmed request was sent again instead of the current file. */
  recovered: boolean;
};

export class AlreadyCreated extends Error {
  constructor(public readonly npcId: string) {
    super(`这个文件的当前内容已经创建过角色 ${npcId}`);
    this.name = 'AlreadyCreated';
  }
}

const REFUSED = new Set(['400', '403', '409', '422', '42201', '50301']);

export function failureMessage(code: string, recovering: boolean): string {
  if (code === '42201')
    return recovering
      ? '之前未确认的提交被文本审核拒绝；文件内容未改动，请修改后重新提交'
      : '角色文本没有通过审核，请修改后重试';
  if (code === '50301') return '文本审核暂时不可用，请稍后重试';
  if (code === '409') return '角色已被修改，请重新读取后再提交';
  if (code === '402' || code === '40201' || code === '1503021061') return '钻石不足';
  if (code === 'NETWORK')
    return '网络错误，提交结果未知；再次运行同一命令会用原请求重试，不会重复创建';
  return `提交失败（${code}）`;
}

export function readCharacter(result: Json) {
  const character = (result.character ??
    (result.data as Json | undefined)?.character ??
    {}) as Json;
  const npcId = idOf(character.npc_id);
  if (!npcId || npcId === '0') throw new UgcFailure('PROTOCOL', '创建回包没有角色 ID');
  return {
    npcId,
    version: idOf(character.version) || '0',
    reviewState: Number(character.review_state) || 0,
    reasonCode: typeof character.reason_code === 'string' ? character.reason_code : '',
  };
}

export async function submitCharacter(
  gateway: Gateway,
  state: LocalState,
  character: ResolvedCharacter,
  options: { fresh?: boolean; dryRun?: (body: string) => void } = {},
): Promise<CreateOutcome | null> {
  const draft = state.draft(character.spec.source);
  const key = `create:${draft.draftId}`;
  const record = state.submission(key);
  const pending = record?.pending ?? null;
  const content = contentForSubmission(character, true);
  // The file's own content: the videos go with the first character only (see markVideosBound), so
  // they are not part of what tells an unchanged file from an edited one.
  const digest = sha256(JSON.stringify(contentForSubmission({ ...character, video: null }, true)));
  if (!pending && record?.npcId && !options.fresh && record.version === digest)
    throw new AlreadyCreated(record.npcId);
  let requestId: string;
  let body: string;
  const recovering = Boolean(pending);
  if (pending) {
    requestId = pending.requestId;
    body = pending.body;
  } else {
    requestId = state.receipt(
      'create_ugc_character',
      options.fresh ? key + ':' + Date.now() : key,
      content,
    );
    body = encodeBody(wireIds({ client_request_id: requestId, content }));
  }
  if (options.dryRun) {
    options.dryRun(body);
    return null;
  }
  state.setSubmission(key, {
    npcId: record?.npcId ?? '',
    version: record?.version ?? '',
    reviewState: record?.reviewState ?? 0,
    at: Date.now(),
    pending: { method: 'create_ugc_character', body, requestId },
  });
  let result: Json;
  try {
    // The frozen text is sent as it was frozen (its IDs already bare i64).
    result = await call(gateway, 'npc/create_ugc_character', new RawBody(body));
  } catch (error) {
    if (error instanceof UgcFailure && REFUSED.has(error.code)) {
      state.setSubmission(key, record ? { ...record, pending: null } : null);
      if (!recovering) state.dropReceipt('create_ugc_character', key, content);
    }
    throw error;
  }
  const outcome = readCharacter(result);
  // The sent body carried this draft's videos (features.draft_id): they now belong to this character.
  if (body.includes(draft.draftId)) markVideosBound(state, draft.draftId, outcome.npcId);
  // `version` here keeps the content digest: the same file again is recognized as created.
  state.setSubmission(key, {
    npcId: outcome.npcId,
    version: recovering ? '' : digest,
    reviewState: outcome.reviewState,
    at: Date.now(),
    pending: null,
  });
  return { ...outcome, recovered: recovering };
}
