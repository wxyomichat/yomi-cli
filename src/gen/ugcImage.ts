import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';

import { isMap, parseDocument } from 'yaml';

import type { Gateway } from '../core/api.js';
import { UsageError } from '../core/env.js';
import { encodeBody, idOf, type Json, RawBody } from '../core/json.js';
import { type LocalState, sha256 } from '../core/state.js';
import { call, UgcFailure, wireIds } from '../ugc/api.js';
import {
  ImageError,
  type LocalImage,
  MAX_IMAGE_BYTES,
  MAX_SIDE,
  sniffImage,
} from '../ugc/imageFile.js';
import { type ImageReceipt, prepareImage } from '../ugc/upload.js';
import {
  download,
  extensionOf,
  GenRefusal,
  generationRefusal,
  loopbackHttpAllowed,
  saveFile,
} from './common.js';
import { prepare, sniffMime } from './raster.js';

/**
 * AI pictures for a character's cover and avatar, as the app's image studio makes them:
 * `npc/get_ugc_image_generation_config` (models with their per-picture price, styles per model,
 * ratios, the most pictures per batch, and the version that freezes the quote), one paid
 * `npc/create_ugc_image_generation_batch`, then `npc/batch_get_ugc_image_generation_tasks` every
 * 2.5 s until every output is final and no charge or refund is still moving. Each output is
 * charged on its own and a failed one is refunded on its own. A batch is the account's, not a
 * draft's: there is no list of batches, so the CLI keeps each batch ID itself.
 *
 * The request is frozen (body and `client_request_id`) before it goes, and only ever sent again
 * as it was frozen; a clear refusal charges nothing and is forgotten. A succeeded output is
 * downloaded from a freshly read address, kept as it is, and cropped around the centre into the
 * app's cover (1:2, 720×1440) and avatar (1:1, 512×512) JPEGs, ready for a character file.
 *
 * Each request's record goes through: unknown (sent, no batch ID yet) → running (accepted, batch
 * ID kept) → settled (the batch reached the stop rule). As in the app, an unchanged repeat of an
 * unknown request is that request again, and of a running one is that batch shown again; only a
 * settled one lets the same request start a new paid batch. The person can let an unknown request
 * or a running batch go on purpose (`forgottenAt`); the record stays, so it can still be resumed.
 */

export const CONFIG_PATH = 'npc/get_ugc_image_generation_config';
export const CREATE_PATH = 'npc/create_ugc_image_generation_batch';
export const BATCH_PATH = 'npc/batch_get_ugc_image_generation_tasks';
const CREATE_METHOD = 'create_ugc_image_generation_batch';

/** The app's limits and cadence. */
export const PROMPT_LIMIT = 1000;
export const DEFAULT_COUNT = 4;
export const POLL_INTERVAL_MS = 2_500;
export const POLL_ROUNDS = 120;
export const MAX_RESULT_BYTES = 20 * 1024 * 1024;
/** A result address this close to expiring is read again before downloading. */
const FRESH_FOR_MS = 60_000;

/** The local records of this feature (`LocalState.records`). */
export const RECORD_KIND = 'ugc-image-batch';

// ---------------------------------------------------------------------------------------------
// Configuration

export type ImageModel = {
  id: string;
  name: string;
  /** Gems per picture, which is what is charged; null when the answer had no readable price. */
  price: number | null;
  /** The struck-through original per picture, shown only when it is above `price`. */
  originalPrice: number | null;
  description: string;
};

export type ImageStyle = {
  id: string;
  name: string;
  /** The models offering it; null when the server only listed style names (every model). */
  modelIds: string[] | null;
};

export type ImageConfig = {
  enabled: boolean;
  models: ImageModel[];
  styles: ImageStyle[];
  ratios: string[];
  maxCount: number;
  /** Sent back with the batch: it freezes the quote. */
  version: string;
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A non-negative whole gem amount (i64 as a number or a decimal string), else null. */
function gemAmount(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** The configuration from a flat answer, read as the app reads it. */
export function parseImageConfig(result: Json): ImageConfig {
  const source =
    result.models === undefined && result.data && typeof result.data === 'object'
      ? (result.data as Json)
      : result;
  const models = (Array.isArray(source.models) ? source.models : []).flatMap((item) => {
    const model = (item ?? {}) as Json;
    const id = text(model.model_id);
    if (!id) return [];
    return [
      {
        id,
        name: text(model.name) || id,
        price: gemAmount(model.price),
        originalPrice: gemAmount(model.original_price),
        description: text(model.description).trim(),
      },
    ];
  });
  const styles: ImageStyle[] = Array.isArray(source.style_options)
    ? source.style_options.flatMap((item) => {
        const style = (item ?? {}) as Json;
        const id = text(style.style_id);
        if (!id) return [];
        const modelIds = Array.isArray(style.model_ids)
          ? style.model_ids.filter((value): value is string => typeof value === 'string')
          : [];
        return [{ id, name: text(style.display_name) || id, modelIds }];
      })
    : (Array.isArray(source.styles) ? source.styles : [])
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .map((id) => ({ id, name: id, modelIds: null }));
  const ratios = (Array.isArray(source.aspect_ratios) ? source.aspect_ratios : []).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  // The app keeps the most pictures per batch within 1–4.
  const max = Number(source.max_count);
  const maxCount = Number.isFinite(max) ? Math.min(4, Math.max(1, Math.floor(max))) : 1;
  return {
    enabled: source.enabled === true,
    models,
    styles,
    ratios,
    maxCount,
    version: text(source.config_version),
  };
}

/** `npc/get_ugc_image_generation_config`. */
export async function loadImageConfig(gateway: Gateway): Promise<ImageConfig> {
  return parseImageConfig(await call(gateway, CONFIG_PATH, {}));
}

/** The styles a model offers, in the server's order. */
export function stylesFor(config: ImageConfig, modelId: string): ImageStyle[] {
  return config.styles.filter(
    (style) => style.modelIds === null || style.modelIds.includes(modelId),
  );
}

/** 9:16 when offered (a portrait, cropped into both cover and avatar), else the first ratio. */
export function defaultRatio(config: ImageConfig): string {
  return config.ratios.includes('9:16') ? '9:16' : (config.ratios[0] ?? '');
}

/** What the person asked for, checked against the configuration. */
export type ImageChoice = {
  prompt: string;
  model: ImageModel;
  style: ImageStyle | null;
  ratio: string;
  count: number;
};

/**
 * The request from the person's options, with the app's defaults: the first model, no style, 9:16
 * (else the first ratio), 4 pictures (at most the server's maximum). Anything the server does not
 * offer is a usage error, before anything is sent.
 */
export function chooseRequest(
  config: ImageConfig,
  input: { prompt: string; model: string; style: string; ratio: string; count: number | null },
): ImageChoice {
  const prompt = input.prompt.trim();
  if (!prompt) throw new UsageError('需要描述：yomi image -p "<描述>"（不能只有空白）');
  const length = [...prompt].length;
  if (length > PROMPT_LIMIT)
    throw new UsageError(`描述最多 ${PROMPT_LIMIT} 个字，现在 ${length} 个`);
  if (!config.models.length) throw new UsageError('服务端现在没有可用的生图模型');
  const model = input.model
    ? config.models.find((item) => item.id === input.model)
    : config.models[0];
  if (!model)
    throw new UsageError(
      `没有模型 ${input.model}；可选：${config.models.map((item) => item.id).join('、')}（yomi image --options 查看）`,
    );
  const offered = stylesFor(config, model.id);
  let style: ImageStyle | null = null;
  if (input.style) {
    style = offered.find((item) => item.id === input.style || item.name === input.style) ?? null;
    if (!style)
      throw new UsageError(
        `模型 ${model.id} 没有风格 ${input.style}；${offered.length ? `可选：${offered.map((item) => item.id).join('、')}` : '这个模型没有可选风格'}（不写 --style 即不选风格）`,
      );
  }
  if (!config.ratios.length) throw new UsageError('服务端现在没有可用的图片比例，暂时不能生成');
  const ratio = input.ratio || defaultRatio(config);
  if (!config.ratios.includes(ratio))
    throw new UsageError(`没有比例 ${ratio}；可选：${config.ratios.join('、')}`);
  const count = input.count ?? Math.min(DEFAULT_COUNT, config.maxCount);
  if (count < 1 || count > config.maxCount)
    throw new UsageError(`--count 只能是 1–${config.maxCount}（服务端当前上限）`);
  return { prompt, model, style, ratio, count };
}

/** The batch's price: per picture × count; the original only when it is higher. */
export function batchPrice(
  model: ImageModel,
  count: number,
): { unit: number; total: number; original: number | null } | null {
  if (model.price === null) return null;
  const original =
    model.originalPrice !== null && model.originalPrice > model.price
      ? model.originalPrice * count
      : null;
  return { unit: model.price, total: model.price * count, original };
}

// ---------------------------------------------------------------------------------------------
// Reference picture

/** A reference picture from disk: JPEG, PNG or WebP, up to 20 MB and 8192 px a side. */
export function loadReference(path: string): LocalImage {
  const label = '参考图';
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new ImageError(`${label}：找不到文件 ${path}`);
  }
  if (size > MAX_IMAGE_BYTES) throw new ImageError(`${label}：文件超过 20 MB`);
  const bytes = readFileSync(path);
  const info = sniffImage(bytes);
  if (!info) throw new ImageError(`${label}：只支持 JPEG、PNG、WebP（${path}）`);
  if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE)
    throw new ImageError(`${label}：尺寸不合法（${info.width}×${info.height}）`);
  return {
    path,
    bytes,
    mime: info.mime,
    width: info.width,
    height: info.height,
    sha256: sha256(bytes),
  };
}

/** Uploads the reference (purpose `reference`) and has it reviewed; only PASSED comes back. */
export function uploadReference(
  gateway: Gateway,
  state: LocalState,
  image: LocalImage,
  fetcher?: typeof fetch,
): Promise<ImageReceipt> {
  return prepareImage(gateway, state, image, 'reference', '参考图', fetcher);
}

// ---------------------------------------------------------------------------------------------
// The paid request

/** The batch request as sent, without its `client_request_id`. */
export type BatchBody = {
  prompt: string;
  model_id: string;
  style_id: string;
  aspect_ratio: string;
  image_count: number;
  reference?: { upload_id: string };
  config_version: string;
};

/** One request as the CLI keeps it (`RECORD_KIND`, by its key). */
export type BatchRecord = {
  /** The intent's key: a fresh UUID for every new request. */
  key: string;
  requestId: string;
  /** What `receipt` was given, so a refused request can be forgotten. */
  receiptBody: BatchBody;
  /** The frozen request text, sent byte for byte every time. */
  body: string;
  /** Digest of what was asked (an unchanged repeat is the same request). */
  intent: string;
  prompt: string;
  modelId: string;
  styleId: string;
  ratio: string;
  count: number;
  unitPrice: number;
  total: number;
  /** The accepted batch; '' while the answer to the create is unknown. */
  batchId: string;
  /**
   * When the batch reached the app's stop rule (`pollingComplete`); 0 (or absent) while it may
   * still change. Until then an unchanged repeat shows this batch again instead of paying anew.
   */
  settledAt?: number;
  /**
   * When the person let this request or batch go (`--forget`); 0 (or absent): never. A forgotten
   * record no longer stands in for an unchanged repeat, which then is a new paid request.
   */
  forgottenAt?: number;
  at: number;
};

/** Where a record stands; see the module comment. */
export type RecordStatus = 'unknown' | 'running' | 'settled' | 'forgotten';

export function recordStatus(record: BatchRecord): RecordStatus {
  if (record.batchId && record.settledAt) return 'settled';
  if (record.forgottenAt) return 'forgotten';
  return record.batchId ? 'running' : 'unknown';
}

/**
 * The person's intent: prompt, model, style, ratio, count and the reference's bytes. As in the
 * app, an unchanged repeat of a request whose answer is unknown is that same request again; any
 * change is a new one. The quote's version is not part of it: a new configuration must not turn
 * a repeat into a second paid request (the frozen body still carries the version it was quoted
 * at; a stale one that was never accepted is refused and forgotten).
 */
export function intentOf(choice: ImageChoice, referenceSha256: string): string {
  return sha256(
    JSON.stringify([
      choice.prompt,
      choice.model.id,
      choice.style?.id ?? '',
      choice.ratio,
      choice.count,
      referenceSha256,
    ]),
  );
}

function recordsIn(state: LocalState, status: RecordStatus): BatchRecord[] {
  return state
    .records<BatchRecord>(RECORD_KIND)
    .map(([, record]) => record)
    .filter((record) => recordStatus(record) === status);
}

/** Requests whose answer is unknown (no batch yet) and that were not let go, oldest first. */
export function pendingRecords(state: LocalState): BatchRecord[] {
  return recordsIn(state, 'unknown');
}

/** Accepted batches that have not settled yet and were not let go, oldest first. */
export function runningRecords(state: LocalState): BatchRecord[] {
  return recordsIn(state, 'running');
}

/** Changes the saved record (read again first: another process may have changed it). */
function patchRecord(
  state: LocalState,
  key: string,
  patch: Partial<BatchRecord>,
): BatchRecord | null {
  const current = state.record<BatchRecord>(RECORD_KIND, key);
  if (!current) return null;
  const next = { ...current, ...patch };
  state.setRecord(RECORD_KIND, key, next);
  return next;
}

/** The batch reached the stop rule: an unchanged repeat may now start a new paid batch. */
export function markSettled(state: LocalState, key: string): BatchRecord | null {
  return patchRecord(state, key, { settledAt: Date.now() });
}

/**
 * Lets a request or batch go on purpose: an unchanged repeat no longer resends or shows it, but
 * starts a new paid request. Nothing is cancelled or refunded on the server; the record stays,
 * so `--resume` still finds it.
 */
export function forgetRecord(state: LocalState, key: string): BatchRecord | null {
  return patchRecord(state, key, { forgottenAt: Date.now() });
}

/** Takes a forgotten request back (it is being resent on purpose). */
export function adoptRecord(state: LocalState, key: string): BatchRecord | null {
  return patchRecord(state, key, { forgottenAt: 0 });
}

/** The record with this batch ID, request ID or key. */
export function findRecord(state: LocalState, id: string): BatchRecord | null {
  return (
    state
      .records<BatchRecord>(RECORD_KIND)
      .map(([, record]) => record)
      .find((record) => record.batchId === id || record.requestId === id || record.key === id) ??
    null
  );
}

/**
 * Freezes a new request: a fresh key, the `client_request_id` from its receipt, the encoded body
 * (the reference's `upload_id` as a bare i64), saved before anything is sent. The check for the
 * same request already unknown or running and the save are one locked step: when another `yomi`
 * process froze it in the meantime, that record comes back (`existing`) and nothing new is saved.
 */
export function freezeRequest(
  state: LocalState,
  choice: ImageChoice,
  version: string,
  unitPrice: number,
  reference: { uploadId: string; sha256: string } | null,
): { record: BatchRecord; existing: boolean } {
  const key = randomUUID();
  const receiptBody: BatchBody = {
    prompt: choice.prompt,
    model_id: choice.model.id,
    style_id: choice.style?.id ?? '',
    aspect_ratio: choice.ratio,
    image_count: choice.count,
    ...(reference ? { reference: { upload_id: reference.uploadId } } : {}),
    config_version: version,
  };
  const requestId = state.receipt(CREATE_METHOD, key, receiptBody);
  const record: BatchRecord = {
    key,
    requestId,
    receiptBody,
    body: encodeBody(wireIds({ client_request_id: requestId, ...receiptBody })),
    intent: intentOf(choice, reference?.sha256 ?? ''),
    prompt: choice.prompt,
    modelId: choice.model.id,
    styleId: choice.style?.id ?? '',
    ratio: choice.ratio,
    count: choice.count,
    unitPrice,
    total: unitPrice * choice.count,
    batchId: '',
    settledAt: 0,
    forgottenAt: 0,
    at: Date.now(),
  };
  const claimed = state.claimRecord<BatchRecord>(
    RECORD_KIND,
    (records) =>
      [...records].reverse().find(([, other]) => {
        const status = recordStatus(other);
        return other.intent === record.intent && (status === 'unknown' || status === 'running');
      }) ?? null,
    () => [key, record],
  );
  if (claimed.existing) state.dropReceipt(CREATE_METHOD, key, receiptBody);
  return { record: claimed.value, existing: claimed.existing };
}

/**
 * The answers the app takes as a clear refusal of a batch (nothing accepted, nothing charged):
 * 400, 409 and the wallet's too-few-gems codes. Anything else leaves the outcome unknown.
 */
const REFUSED = new Set(['400', '409', '402', '1503021061']);

/**
 * A resend of a request whose first answer never came was refused. The refusal covers this resend
 * only: the first send may have been accepted and charged, so the request stays saved.
 */
export class ReplayRefused extends Error {
  constructor(readonly refusal: GenRefusal) {
    super(refusal.message);
    this.name = 'ReplayRefused';
  }
}

/**
 * Sends the frozen request (the paid call). Accepted: the batch, its ID saved. A clear refusal
 * (`GenRefusal`, nothing charged) of the first send forgets the request and is thrown; a refused
 * resend (`replay`) keeps it and throws `ReplayRefused`; any other failure leaves it saved, its
 * outcome unknown, and is thrown as it is.
 */
export async function submitBatch(
  gateway: Gateway,
  state: LocalState,
  record: BatchRecord,
  options: { replay?: boolean } = {},
): Promise<ImageBatch> {
  let result: Json;
  try {
    result = await call(gateway, CREATE_PATH, new RawBody(record.body));
  } catch (error) {
    // A failure that still carries a batch was accepted: it is not a refusal.
    const accepted = error instanceof UgcFailure && Boolean(error.body && batchOf(error.body));
    const refusal = accepted ? error : generationRefusal(error);
    if (refusal instanceof GenRefusal && options.replay) throw new ReplayRefused(refusal);
    if (refusal instanceof GenRefusal && (refusal.kind === 'gems' || REFUSED.has(refusal.code))) {
      state.dropReceipt(CREATE_METHOD, record.key, record.receiptBody);
      state.setRecord(RECORD_KIND, record.key, null);
      throw refusal;
    }
    throw error;
  }
  const batch = parseBatch(batchOf(result));
  const current = state.record<BatchRecord>(RECORD_KIND, record.key) ?? record;
  state.setRecord(RECORD_KIND, record.key, { ...current, batchId: batch.id });
  return batch;
}

// ---------------------------------------------------------------------------------------------
// The batch

export const Generation = { queued: 1, running: 2, persisting: 3, succeeded: 4, failed: 5 };

export type ImageOutput = {
  /** 1-based, in request order. */
  index: number;
  taskId: string;
  generationStatus: number;
  assetId: string;
  /** The result's signed address (https, or the loopback mock): never printed or kept. */
  url: string;
  mime: string;
  /** When `url` stops working (ms); null for a stable address. */
  expiresAt: number | null;
  failure: { code: string; message: string; retryable: boolean | null } | null;
  /** pending / free / charged / refunding / refunded / failed. */
  billing: string;
};

export type ImageBatch = { id: string; outputs: ImageOutput[] };

function batchOf(result: Json): unknown {
  return result.batch ?? (result.data as Json | undefined)?.batch;
}

/** A downloadable address: https, or http on the loopback mock; never with credentials. */
function resultUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.username || url.password) return '';
    return url.protocol === 'https:' || loopbackHttpAllowed(url) ? value : '';
  } catch {
    return '';
  }
}

/** A batch from an answer: outputs in request order, each with its charge state. */
export function parseBatch(value: unknown): ImageBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UgcFailure('PROTOCOL', '回包里没有生成批次');
  const batch = value as Json;
  const id = text(batch.batch_id);
  if (!id) throw new UgcFailure('PROTOCOL', '回包里没有批次 ID');
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const billing = Array.isArray(batch.billing_status) ? batch.billing_status : [];
  const outputs = tasks.map((item, position): ImageOutput => {
    const task = (item ?? {}) as Json;
    const assets = (Array.isArray(task.assets) ? task.assets : []) as Json[];
    const asset =
      assets.find((entry) => Number(entry?.output_index ?? 0) === 0) ?? assets[0] ?? ({} as Json);
    const failure =
      task.generation_failure && typeof task.generation_failure === 'object'
        ? (task.generation_failure as Json)
        : null;
    const expires = Number(asset.access_expires_at_ms);
    return {
      index: position + 1,
      taskId: idOf(task.task_id),
      generationStatus: Number(task.generation_status) || 0,
      assetId: idOf(asset.asset_id),
      url: resultUrl(asset.original_url),
      mime: text(asset.mime_type),
      expiresAt: Number.isFinite(expires) && expires > 0 ? expires : null,
      failure: failure
        ? {
            code: text(failure.code),
            message: text(failure.message),
            retryable: typeof failure.retryable === 'boolean' ? failure.retryable : null,
          }
        : null,
      billing: text(billing[position]),
    };
  });
  return { id, outputs };
}

/** `npc/batch_get_ugc_image_generation_tasks`: the batch now (never charges). */
export async function readBatch(gateway: Gateway, batchId: string): Promise<ImageBatch> {
  return parseBatch(batchOf(await call(gateway, BATCH_PATH, { batch_id: batchId })));
}

/** Not final yet, but stopped for good (a non-retryable failure): the app says it is checking. */
export function interrupted(output: ImageOutput): boolean {
  return (
    output.generationStatus !== Generation.succeeded &&
    output.generationStatus !== Generation.failed &&
    Boolean(output.failure?.code) &&
    output.failure?.retryable === false
  );
}

/**
 * The app's stop rule: every output succeeded, failed or was interrupted, and no charge is pending
 * and no refund is still under way.
 */
export function pollingComplete(batch: ImageBatch): boolean {
  return (
    batch.outputs.length > 0 &&
    batch.outputs.every(
      (output) =>
        output.generationStatus === Generation.succeeded ||
        output.generationStatus === Generation.failed ||
        interrupted(output),
    ) &&
    !batch.outputs.some((output) => output.billing === 'pending' || output.billing === 'refunding')
  );
}

/**
 * The content checks' refusal. The server has no dedicated code for it; a failure whose code
 * names sensitive content or a review is read as one.
 */
const CONTENT_REFUSAL = /SENSITIVE|CONTENT|MODERAT|AUDIT|REVIEW|RISK|UNSAFE|POLICY|NSFW/i;

export type OutputOutcome = 'succeeded' | 'failed' | 'rejected' | 'interrupted' | 'working';

/** What became of one output, as the person is told. */
export function outcomeOf(output: ImageOutput): OutputOutcome {
  if (output.generationStatus === Generation.succeeded) return 'succeeded';
  if (output.generationStatus === Generation.failed)
    return CONTENT_REFUSAL.test(output.failure?.code ?? '') ? 'rejected' : 'failed';
  return interrupted(output) ? 'interrupted' : 'working';
}

const STAGE: Record<number, string> = {
  [Generation.queued]: '排队中',
  [Generation.running]: '生成中',
  [Generation.persisting]: '保存中',
};

/** One output's charge in words; refunding is never called refunded. */
export function billingText(billing: string, unitPrice: number | null): string {
  switch (billing) {
    case 'charged':
      return unitPrice === null ? '已扣费' : `已扣 ${unitPrice} 钻石`;
    case 'free':
      return '免费';
    case 'pending':
      return '扣费确认中';
    case 'refunding':
      return '退款中…';
    case 'refunded':
      return '钻石已退回';
    case 'failed':
      return '扣费失败';
    default:
      return '';
  }
}

/** One output's line: succeeded, failed or rejected by the content checks, with its charge. */
export function describeOutput(output: ImageOutput, unitPrice: number | null): string {
  const billing = billingText(output.billing, unitPrice);
  const label = `#${output.index}`;
  const code = output.failure?.code ? `（${output.failure.code}）` : '';
  // A failed output still charged: its refund has not started yet.
  const refund =
    output.billing === 'charged' ? `${billing}，退款还没有开始，稍后可再查看` : billing;
  switch (outcomeOf(output)) {
    case 'succeeded':
      return `${label} ✓ 成功${billing ? `（${billing}）` : ''}`;
    case 'failed':
      return `${label} ✗ 生成失败${code}。${refund}`;
    case 'rejected':
      return `${label} ✗ 未通过内容检查${code}。${refund}`;
    case 'interrupted':
      return `${label} … 生成已中断，正在确认结果${billing ? `（${billing}）` : ''}`;
    default:
      return `${label} … ${STAGE[output.generationStatus] ?? '处理中'}${billing ? `（${billing}）` : ''}`;
  }
}

/** A one-line progress summary, e.g. 「进度：成功 2 · 生成中 2」. */
export function progressLine(batch: ImageBatch): string {
  const counts = new Map<string, number>();
  const money = new Map<string, number>();
  const add = (into: Map<string, number>, label: string) =>
    into.set(label, (into.get(label) ?? 0) + 1);
  for (const output of batch.outputs) {
    const outcome = outcomeOf(output);
    if (outcome === 'succeeded') add(counts, '成功');
    else if (outcome === 'failed') add(counts, '失败');
    else if (outcome === 'rejected') add(counts, '未通过内容检查');
    else if (outcome === 'interrupted') add(counts, '已中断');
    else add(counts, STAGE[output.generationStatus] ?? '处理中');
    if (output.billing === 'pending') add(money, '扣费确认中');
    if (output.billing === 'refunding') add(money, '退款中');
  }
  if (!counts.size) return '进度：等待服务端创建任务';
  return `进度：${[...counts, ...money].map(([label, count]) => `${label} ${count}`).join(' · ')}`;
}

/** Gems by charge state (null without a known unit price), and pictures by charge state. */
export function billingTotals(batch: ImageBatch, unitPrice: number | null) {
  const pictures = (billing: string) =>
    batch.outputs.filter((output) => output.billing === billing).length;
  const gems = (count: number) => (unitPrice === null ? null : count * unitPrice);
  const counts = {
    charged: pictures('charged'),
    refunded: pictures('refunded'),
    refunding: pictures('refunding'),
    pending: pictures('pending'),
  };
  return {
    pictures: counts,
    charged: gems(counts.charged),
    refunded: gems(counts.refunded),
    refunding: gems(counts.refunding),
    pending: gems(counts.pending),
  };
}

/** True when the output's address expires soon (or has expired): read the batch again first. */
export function expiresSoon(output: ImageOutput, now = Date.now()): boolean {
  return output.expiresAt !== null && output.expiresAt - now < FRESH_FOR_MS;
}

// ---------------------------------------------------------------------------------------------
// Results on disk

export type SavedImage = {
  /** The original as generated. */
  original: string;
  /** The prepared cover (1:2) and avatar (1:1) JPEGs; '' when the original cannot be decoded. */
  cover: string;
  avatar: string;
  mime: string;
  /** Why it could not be cropped (WebP, undecodable); '' when it was. */
  note: string;
};

/**
 * Downloads one succeeded output (at most 20 MiB, no credentials, no redirects) into `dir`, keeps
 * the original, and writes the cropped cover and avatar beside it. An original that cannot be
 * decoded here (WebP, damaged) is kept alone; its asset reference still works in a character file.
 */
export async function saveOutput(
  dir: string,
  batchId: string,
  output: ImageOutput,
  fetcher?: typeof fetch,
): Promise<SavedImage> {
  const { bytes, mime: served } = await download(output.url, {
    maxBytes: MAX_RESULT_BYTES,
    fetcher,
  });
  const mime = sniffMime(bytes) || output.mime || served;
  const base = `yomi-image-${batchId}-${output.index}`;
  const original = saveFile(dir, `${base}.${extensionOf(mime)}`, bytes);
  let cover: Buffer;
  let avatar: Buffer;
  try {
    cover = prepare(bytes, 'cover');
    avatar = prepare(bytes, 'avatar');
  } catch (error) {
    return {
      original,
      cover: '',
      avatar: '',
      mime,
      note: error instanceof Error ? error.message : '无法解码',
    };
  }
  return {
    original,
    cover: saveFile(dir, `${base}-cover.jpg`, cover),
    avatar: saveFile(dir, `${base}-avatar.jpg`, avatar),
    mime,
    note: '',
  };
}

/** A picture for a character file: a local path, or the generated asset itself. */
export type CharacterImage = { path: string } | { assetId: string };

/** The YAML character file `--into` names, checked before anything is spent. */
export function checkCharacterFile(file: string): string {
  const absolute = resolve(file);
  if (extname(absolute).toLowerCase() === '.json')
    throw new UsageError('--into 只支持 YAML 角色文件（.yaml / .yml）');
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch {
    throw new UsageError(`读不到角色文件：${file}`);
  }
  const document = parseDocument(raw);
  if (document.errors.length)
    throw new UsageError(`角色文件格式错误：${document.errors[0].message}`);
  if (!isMap(document.contents)) throw new UsageError('角色文件的顶层必须是键值对象');
  return absolute;
}

/**
 * Writes `cover` / `avatar` into a YAML character file, keeping its comments and key order: a
 * path relative to the file's folder, or `{ asset_id: "<id>" }` (quoted: a bare 19-digit number
 * would lose digits when read). Returns what each key now holds.
 */
export function writeCharacterImages(
  file: string,
  images: { cover?: CharacterImage; avatar?: CharacterImage },
): Record<string, string> {
  const absolute = checkCharacterFile(file);
  const document = parseDocument(readFileSync(absolute, 'utf8'));
  const written: Record<string, string> = {};
  for (const key of ['cover', 'avatar'] as const) {
    const image = images[key];
    if (!image) continue;
    if ('path' in image) {
      let path = relative(dirname(absolute), image.path).split(sep).join('/');
      if (!path.startsWith('../') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path))
        path = './' + path;
      document.set(key, path);
      written[key] = path;
    } else {
      document.set(key, document.createNode({ asset_id: image.assetId }));
      written[key] = `{ asset_id: "${image.assetId}" }`;
    }
  }
  writeFileSync(absolute, document.toString());
  return written;
}
