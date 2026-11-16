import { randomUUID } from 'node:crypto';

import { ApiError, type Gateway } from '../core/api.js';
import { tr } from '../core/i18n.js';
import {
  count,
  encodeBody,
  flag,
  i64,
  type Json,
  list,
  optionalId,
  optionalObject,
  RawBody,
  text,
} from '../core/json.js';
import { NPC_ENTITY_TYPE } from '../im/models.js';
import { GenRefusal, generationRefusal, loopbackHttpAllowed } from './common.js';

/**
 * Images in an ordinary chat with a published character, as the app makes them: the chat's image
 * settings (`conversation/image/get_config`), a task anchored on one of the character's replies
 * (`conversation/image/create_task`) and its progress (`media/image/get_task`). There is no prompt:
 * the server draws from the conversation up to the anchor. The balance is checked when the task is
 * created and the image is charged when it is delivered into the chat as a message of its own
 * (pushed as `MessagePersisted`, and in history). Conversation answers are flat beside
 * `base_resp`; every ID here is an i64.
 */

/** `ImageGenerationStatus`: 4 and 5 are final. */
export const ImageGeneration = {
  unknown: 0,
  queued: 1,
  running: 2,
  persisting: 3,
  succeeded: 4,
  failed: 5,
} as const;

/** `ImageDeliveryStatus`: Persisted means committed to the chat, pushed or not. */
export const ImageDelivery = {
  notReady: 0,
  pending: 1,
  persisted: 2,
  retryPending: 3,
  skippedConversationDeleted: 4,
} as const;

/** `ImageBillingStatus`. */
export const ImageBilling = {
  notCharged: 0,
  chargePending: 1,
  charged: 2,
  refundPending: 3,
  refunded: 4,
  chargeFailed: 5,
  manualReview: 6,
} as const;

/** Polling, as the app does it: every 2 s, for at most 180 s (the server may still finish later). */
export const CHAT_IMAGE_POLL_MS = 2000;
export const CHAT_IMAGE_TIMEOUT_MS = 180_000;

/** The aspect ratio the app asks for when the chat allows it. */
const PORTRAIT = '3:4';

export type ChatImageConfig = {
  enabled: boolean;
  billingEnabled: boolean;
  coinCost: number;
  remainingFreeQuota: number;
  aspectRatios: string[];
  /** What the next image costs, as the app shows it: the price once the free images are used. */
  cost: number;
  /**
   * What it may cost at worst: the free images are only a snapshot (one made elsewhere meanwhile
   * uses them up, and create_task keeps nothing free), so with billing on it is the full price.
   * Null when billing is on and no price is given: unknown, never free.
   */
  worstCost: number | null;
};

export type MediaFailure = { code: string; message: string; retryable: boolean };

export type ChatImageAsset = {
  assetId: string;
  /** https (or a loopback test server); '' when missing. */
  url: string;
  thumbnailUrl: string;
  mime: string;
  width: number;
  height: number;
  /** 0 when unknown. */
  sizeBytes: number;
  /** Unix ms after which both links must be read again; 0 when stable. */
  accessExpiresAtMs: number;
};

export type ChatImageTask = {
  taskId: string;
  generation: number;
  delivery: number;
  billing: number;
  /** The image's own message in the chat, once delivered. */
  resultMid: string;
  /** The conversation and anchor the task was made from. */
  cid: string;
  anchorMid: string;
  assets: ChatImageAsset[];
  failure: MediaFailure | null;
  billingFailure: MediaFailure | null;
  deliveryFailure: MediaFailure | null;
};

/** A result link the CLI may download: https, or http on a loopback test server. */
export function resultUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.username || url.password) return '';
    return url.protocol === 'https:' || loopbackHttpAllowed(url) ? value : '';
  } catch {
    return '';
  }
}

function failureOf(value: unknown): MediaFailure | null {
  if (value === undefined || value === null) return null;
  const raw = optionalObject(value);
  return { code: text(raw.code), message: text(raw.message), retryable: flag(raw.retryable) };
}

function assetOf(value: unknown): ChatImageAsset {
  const raw = optionalObject(value);
  return {
    assetId: optionalId(raw.asset_id),
    url: resultUrl(raw.original_url),
    thumbnailUrl: resultUrl(raw.thumbnail_url),
    mime: text(raw.mime_type),
    width: count(raw.width),
    height: count(raw.height),
    sizeBytes: count(raw.size_bytes),
    accessExpiresAtMs: count(raw.access_expires_at_ms),
  };
}

/** `ImageGenerationTask` as JSON. */
export function parseChatImageTask(value: unknown): ChatImageTask {
  const raw = optionalObject(value);
  const taskId = optionalId(raw.task_id);
  if (!taskId)
    throw new ApiError(
      ApiError.transport,
      tr('生图回包缺少 task_id', 'The image generation response has no task_id'),
      null,
    );
  const source = optionalObject(raw.source);
  return {
    taskId,
    generation: count(raw.generation_status),
    delivery: count(raw.delivery_status),
    billing: count(raw.billing_status),
    resultMid: optionalId(raw.result_mid),
    cid: optionalId(source.cid),
    anchorMid: optionalId(source.anchor_mid),
    assets: list(raw.assets).map(assetOf),
    failure: failureOf(raw.generation_failure),
    billingFailure: failureOf(raw.billing_failure),
    deliveryFailure: failureOf(raw.delivery_failure),
  };
}

/** The shown price: free while free images are left or billing is off, as the app computes it. */
export function chatImageCost(config: Omit<ChatImageConfig, 'cost' | 'worstCost'>): number {
  return config.billingEnabled && config.remainingFreeQuota <= 0 ? config.coinCost : 0;
}

/** `3:4` when the chat allows it (or names nothing), else '' (no options sent), as the app does. */
export function chatImageAspectRatio(allowed: string[]): string {
  return allowed.length === 0 || allowed.includes(PORTRAIT) ? PORTRAIT : '';
}

/** `conversation/image/get_config` for the chat with `npcId`. */
export async function getChatImageConfig(
  gateway: Gateway,
  npcId: string,
): Promise<ChatImageConfig> {
  const result = await gateway.request(
    'conversation/image/get_config',
    { entity_id: i64(npcId), entity_type: NPC_ENTITY_TYPE },
    { timeoutMs: 30_000 },
  );
  const raw = optionalObject(result.config);
  const config = {
    enabled: flag(raw.enabled),
    billingEnabled: flag(raw.billing_enabled),
    coinCost: count(raw.coin_cost),
    remainingFreeQuota: count(raw.remaining_free_quota),
    aspectRatios: list(raw.allowed_aspect_ratios).filter(
      (item): item is string => typeof item === 'string',
    ),
  };
  const priced = typeof raw.coin_cost === 'number' || typeof raw.coin_cost === 'string';
  return {
    ...config,
    cost: chatImageCost(config),
    worstCost: !config.billingEnabled ? 0 : priced ? config.coinCost : null,
  };
}

/**
 * The idempotency key of one request for an image, as the app makes it: one per request, the
 * same one when that request is sent again.
 */
export function chatImageRequestId(npcId: string, anchorMid: string): string {
  return `chat-image-${NPC_ENTITY_TYPE}-${npcId}-${anchorMid || '0'}-${randomUUID()}`;
}

/**
 * The `create_task` body, frozen as text: a resend must be byte for byte the same. The anchor is a
 * reply's mid, or none with `is_prologue` (the character's opening line).
 */
export function chatImageRequest(input: {
  npcId: string;
  anchorMid: string;
  requestId: string;
  aspectRatio: string;
}): string {
  const body: Json = {
    entity_id: i64(input.npcId),
    entity_type: NPC_ENTITY_TYPE,
    client_request_id: input.requestId,
  };
  if (input.anchorMid) body.anchor_mid = i64(input.anchorMid);
  else body.is_prologue = true;
  if (input.aspectRatio) body.options = { aspect_ratio: input.aspectRatio };
  return encodeBody(body);
}

/**
 * `conversation/image/create_task` with a frozen body. Never retried here: a failure goes to
 * `chatImageRefusal`. A success without a task is a refusal only with `model_unavailable_dialog`
 * (the server's admission-only dialog: no task, nothing charged), else an unknown outcome.
 */
export async function createChatImageTask(
  gateway: Gateway,
  body: string,
): Promise<{ task: ChatImageTask; replay: boolean }> {
  const path = 'conversation/image/create_task';
  const result = await gateway.request(path, new RawBody(body), { timeoutMs: 30_000 });
  if (result.task === undefined || result.task === null) {
    const dialog = optionalObject(result.model_unavailable_dialog);
    const content = text(dialog.content) || text(dialog.title);
    if (content) throw new GenRefusal('rejected', 'NO_TASK', content);
    throw new ApiError(
      ApiError.transport,
      tr('生图回包缺少 task', 'The image generation response has no task'),
      result,
      path,
    );
  }
  return { task: parseChatImageTask(result.task), replay: flag(result.idempotent_replay) };
}

/**
 * A failed `create_task` the server clearly turned away (nothing accepted, nothing charged), or
 * null when its outcome is unknown and the request must be kept to be resent as is. Only the
 * known refusals count (`generationRefusal`: not enough gems, invalid, conflicting, rate
 * limited…, and the dialog without a task above). An unrecognised business code, a 5xx, an HTTP
 * error without an answer (but 429) or no answer at all may each have been accepted, and an
 * answer that still carries a task was, whatever its code.
 */
export function chatImageRefusal(error: unknown): GenRefusal | null {
  if (error instanceof ApiError && error.body?.task != null) return null;
  const refusal = generationRefusal(error);
  return refusal instanceof GenRefusal ? refusal : null;
}

/** `media/image/get_task`: the task as it is now (fresh links when they expire). */
export async function getChatImageTask(gateway: Gateway, taskId: string): Promise<ChatImageTask> {
  const result = await gateway.request(
    'media/image/get_task',
    { task_id: i64(taskId) },
    { timeoutMs: 30_000 },
  );
  return parseChatImageTask(result.task);
}

/** Nothing more will happen to the picture: failed, or delivered (or its chat was deleted). */
export function chatImageDone(task: ChatImageTask): boolean {
  if (task.generation === ImageGeneration.failed) return true;
  return (
    task.generation === ImageGeneration.succeeded &&
    (task.delivery === ImageDelivery.persisted ||
      task.delivery === ImageDelivery.skippedConversationDeleted)
  );
}

/**
 * Whether the gems are where they will stay: no charge or refund under way. A delivered image
 * that should cost something and still reads "not charged" is waited for too (the charge comes
 * with delivery).
 */
export function chatImageBillingSettled(task: ChatImageTask, expectCharge: boolean): boolean {
  if (task.billing === ImageBilling.chargePending || task.billing === ImageBilling.refundPending)
    return false;
  const delivered =
    task.generation === ImageGeneration.succeeded && task.delivery === ImageDelivery.persisted;
  return !(expectCharge && delivered && task.billing === ImageBilling.notCharged);
}

/**
 * A failure that reads as the content checks turning the picture down. The server names no list
 * of failure codes, so this goes by the code's wording.
 */
export function contentRejected(failure: MediaFailure | null): boolean {
  return Boolean(failure && /SENSITIVE|REJECT|MODERAT|AUDIT|REVIEW|UNSAFE/i.test(failure.code));
}
