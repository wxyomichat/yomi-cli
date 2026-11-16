import { randomUUID } from 'node:crypto';

import type { Gateway } from '../core/api.js';
import { type Json, object } from '../core/json.js';
import { type LocalState, sha256 } from '../core/state.js';
import { call, putObject, UgcFailure } from '../ugc/api.js';
import {
  download,
  extensionOf,
  GenRefusal,
  generationRefusal,
  INSUFFICIENT_GEMS,
  pollUntil,
  saveFile,
} from './common.js';

/**
 * AI video for a character (a dynamic cover or an intro video), as the app makes one:
 *
 * 1. `ugc/video/config`: templates, durations and display prices (not a charge basis).
 * 2. The balance against the display price: a video that cannot be paid uploads nothing.
 * 3. The first frame: a 720×1280 JPEG, `ugc/video/frame/prepare` (its request id derived from the
 *    local draft and the picture), a private PUT, `ugc/video/frame/complete` → its asset id.
 * 4. `ugc/video/quote`: the price that will be charged, valid for a while by the server's clock.
 * 5. The whole `CreateVideoReq` saved locally, then `ugc/video/create` with `wait_timeout_ms: 0`.
 *    That call charges. A retry replays the saved request (same id, same body); a request whose
 *    answer was lost is never sent again with a new id.
 * 6. `ugc/video/task` every 2.5 s (at most 120 rounds) until the task and its billing settle.
 * 7. `ugc/video/media` for a short-lived address of the result, downloaded at once.
 *
 * The result's asset id is kept per local draft and use; `yomi create` puts it in
 * `features.dynamic_cover` / `features.intro_video` with `features.draft_id` (a preview does not).
 * Once a character was created with them they belong to it: a later create leaves them out. Every ID on these
 * routes is a string: no body here goes through `wireIds`.
 */

export type VideoUse = 'dynamic-cover' | 'intro-video';

/** What a use is called in the CLI's output. */
export const VIDEO_USE_LABEL: Record<VideoUse, string> = {
  'dynamic-cover': '动态封面',
  'intro-video': '介绍视频',
};

/** `--as`: the use of a new video (default: the dynamic cover). */
export function parseVideoUse(value: string): VideoUse {
  const use = value.trim().toLowerCase();
  if (!use || use === 'dynamic-cover') return 'dynamic-cover';
  if (use === 'intro-video') return 'intro-video';
  throw new Error('--as 只能是 dynamic-cover（动态封面）或 intro-video（介绍视频）');
}

/** How often and how long a task is watched, as the app does (a test may shorten it). */
export const VIDEO_POLL = { intervalMs: 2500, maxRounds: 120 };

/** A quote must have at least this long left when the create goes out. */
const QUOTE_MARGIN_MS = 5000;
/** The first frame's limit (JPEG, 1 byte to 10 MiB). */
export const FRAME_MAX_BYTES = 10 * 1024 * 1024;
/** A result's preview is downloaded up to this size, as the app does. */
const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
/** `custom_prompt` limit in code points. */
export const PROMPT_MAX = 2000;

const STATUSES = new Set(['ACCEPTED', 'QUEUED', 'RUNNING', 'REVIEWING', 'SUCCEEDED', 'FAILED']);
const BILLING = new Set(['PENDING', 'FREE', 'CHARGED', 'REFUNDING', 'REFUNDED', 'FAILED']);

// ---------------------------------------------------------------------------------------------
// Reading answers

function protocol(message: string): UgcFailure {
  return new UgcFailure('PROTOCOL', message);
}

/** A string field (an ID the server may also send as a bare number). */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}

/** A whole number (an i64 the server may send as a decimal string). */
function whole(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed))
    throw protocol(`回包的 ${label} 不是整数`);
  return parsed;
}

function listOf(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw protocol(`回包的 ${label} 不是列表`);
  return value;
}

function objectOf(value: unknown, label: string): Json {
  try {
    return object(value);
  } catch {
    throw protocol(`回包缺少 ${label}`);
  }
}

export type VideoTemplate = {
  id: string;
  version: string;
  name: string;
  description: string;
  durations: number[];
  defaultDuration: number;
  /** Display prices by duration; null when the config gives none. */
  prices: Map<number, number> | null;
};

export type VideoConfig = {
  configVersion: string;
  customVersion: string;
  customDurations: number[];
  customDefaultDuration: number;
  customPrices: Map<number, number> | null;
  templates: VideoTemplate[];
  maxConcurrentTasks: number;
};

function durationsOf(value: unknown, label: string): number[] {
  const durations = listOf(value, label).map((item) => whole(item, label));
  if (!durations.length || durations.some((seconds) => seconds <= 0))
    throw protocol(`配置的 ${label} 不合法`);
  return durations;
}

function pricesOf(value: unknown, label: string): Map<number, number> | null {
  if (value === undefined || value === null) return null;
  const prices = new Map<number, number>();
  for (const item of listOf(value, label)) {
    const entry = objectOf(item, label);
    const amount = whole(entry.diamond_amount, `${label}.diamond_amount`);
    if (amount < 0) throw protocol(`配置的 ${label} 有负数价格`);
    prices.set(whole(entry.duration_seconds, `${label}.duration_seconds`), amount);
  }
  return prices;
}

/** `GetVideoConfigResp`, checked as the app checks it. */
export function readVideoConfig(result: Json): VideoConfig {
  const configVersion = str(result.config_version);
  const customVersion = str(result.custom_version);
  if (!configVersion || !customVersion) throw protocol('视频配置缺少版本');
  const customDurations = durationsOf(result.custom_duration_seconds, 'custom_duration_seconds');
  const customDefaultDuration = whole(
    result.custom_default_duration_seconds,
    'custom_default_duration_seconds',
  );
  if (!customDurations.includes(customDefaultDuration))
    throw protocol('视频配置的自定义默认时长不在可选时长里');
  const templates = listOf(result.templates, 'templates').map((item): VideoTemplate => {
    const entry = objectOf(item, 'templates');
    const template: VideoTemplate = {
      id: str(entry.template_id),
      version: str(entry.version),
      name: str(entry.name),
      description: str(entry.description),
      durations: durationsOf(entry.duration_seconds, 'duration_seconds'),
      defaultDuration: whole(entry.default_duration_seconds, 'default_duration_seconds'),
      prices: pricesOf(entry.duration_prices, 'duration_prices'),
    };
    if (!template.id || !template.version || !template.name)
      throw protocol('视频模板缺少 ID、版本或名称');
    if (!template.durations.includes(template.defaultDuration))
      throw protocol(`模板 ${template.id} 的默认时长不在可选时长里`);
    return template;
  });
  return {
    configVersion,
    customVersion,
    customDurations,
    customDefaultDuration,
    customPrices: pricesOf(result.custom_duration_prices, 'custom_duration_prices'),
    templates,
    maxConcurrentTasks: whole(result.max_concurrent_tasks ?? 0, 'max_concurrent_tasks'),
  };
}

/** `ugc/video/config`. */
export async function loadVideoConfig(gateway: Gateway): Promise<VideoConfig> {
  return readVideoConfig(await call(gateway, 'ugc/video/config', {}));
}

/** The display price of a template (null: custom) at `seconds`; null when the config has none. */
export function displayPrice(
  config: VideoConfig,
  template: VideoTemplate | null,
  seconds: number,
): number | null {
  const prices = template ? template.prices : config.customPrices;
  return prices?.get(seconds) ?? null;
}

/** A template by its ID, else by its exact name (the ID is what is sent). */
export function findTemplate(config: VideoConfig, wanted: string): VideoTemplate | null {
  const byId = config.templates.find((template) => template.id === wanted);
  if (byId) return byId;
  const byName = config.templates.filter(
    (template) => template.name.toLowerCase() === wanted.trim().toLowerCase(),
  );
  return byName.length === 1 ? byName[0] : null;
}

// ---------------------------------------------------------------------------------------------
// The first frame

/** The frame's request ID as the app derives it: the same picture for a draft is one upload. */
export function frameRequestId(draftId: string, jpeg: Buffer): string {
  return 'frame_' + sha256(draftId + sha256(jpeg)).slice(0, 48);
}

/**
 * Uploads a prepared first frame (a 720×1280 JPEG) for the draft and returns its asset ID. The
 * PUT carries the two headers the signature binds: `Content-Type: image/jpeg` and
 * `x-oss-object-acl: private`.
 */
export async function uploadFrame(
  gateway: Gateway,
  draftId: string,
  jpeg: Buffer,
  fetcher?: typeof fetch,
): Promise<string> {
  if (jpeg.length < 1 || jpeg.length > FRAME_MAX_BYTES)
    throw new UgcFailure('INVALID_ARGUMENT', '首帧 JPEG 超过 10 MiB');
  const prepared = await call(gateway, 'ugc/video/frame/prepare', {
    request_id: frameRequestId(draftId, jpeg),
    draft_id: draftId,
    sha256: sha256(jpeg),
    byte_size: jpeg.length,
  });
  const uploadId = str(prepared.upload_id);
  const url = str(prepared.upload_url);
  if (!uploadId || !url) throw protocol('首帧上传登记回包不完整');
  await putObject(url, jpeg, 'image/jpeg', fetcher, { 'x-oss-object-acl': 'private' });
  const completed = await call(gateway, 'ugc/video/frame/complete', { upload_id: uploadId });
  const assetId = str(completed.asset_id);
  if (!assetId) throw protocol('首帧上传完成回包没有 asset_id');
  return assetId;
}

// ---------------------------------------------------------------------------------------------
// Quote and create

/** `VideoInput`: six fields, exactly as the quote echoes them back. */
export type VideoInput = {
  first_frame_asset_id: string;
  /** '' for a custom video. */
  template_id: string;
  /** The template's version; `custom_version` for a custom video. */
  template_version: string;
  /** Only for a custom video (may be empty); '' with a template. */
  custom_prompt: string;
  duration_seconds: number;
  config_version: string;
};

export type VideoQuote = {
  quoteId: string;
  amount: number;
  input: VideoInput;
  /** Local time (ms) by which the quote runs out, from the server's own clock difference. */
  deadline: number;
};

function readInput(value: unknown): VideoInput {
  const input = objectOf(value, 'quote.input');
  return {
    first_frame_asset_id: str(input.first_frame_asset_id),
    template_id: str(input.template_id),
    template_version: str(input.template_version),
    custom_prompt: typeof input.custom_prompt === 'string' ? input.custom_prompt : '',
    duration_seconds: whole(input.duration_seconds, 'input.duration_seconds'),
    config_version: str(input.config_version),
  };
}

export function sameInput(a: VideoInput, b: VideoInput): boolean {
  return (
    a.first_frame_asset_id === b.first_frame_asset_id &&
    a.template_id === b.template_id &&
    a.template_version === b.template_version &&
    a.custom_prompt === b.custom_prompt &&
    a.duration_seconds === b.duration_seconds &&
    a.config_version === b.config_version
  );
}

/**
 * `ugc/video/quote`: no task, no charge. The echoed input must be the one sent. How long the quote
 * is good for is `expires_at_ms − server_time_ms`, counted from when the answer arrived here (the
 * two clocks are never compared).
 */
export async function quoteVideo(
  gateway: Gateway,
  draftId: string,
  input: VideoInput,
  now: () => number = Date.now,
): Promise<VideoQuote> {
  const result = await call(gateway, 'ugc/video/quote', { draft_id: draftId, input });
  const received = now();
  const quote = objectOf(result.quote, 'quote');
  const quoteId = str(quote.quote_id);
  const amount = whole(quote.diamond_amount, 'diamond_amount');
  const expiresAt = whole(quote.expires_at_ms, 'expires_at_ms');
  const serverTime = whole(quote.server_time_ms, 'server_time_ms');
  if (!quoteId || amount < 0) throw protocol('报价回包不完整');
  if (expiresAt <= serverTime) throw protocol('报价已过期');
  if (!sameInput(readInput(quote.input), input))
    throw protocol('报价对应的参数与发送的不一致，无法确认价格');
  return { quoteId, amount, input, deadline: received + (expiresAt - serverTime) };
}

/** True while the quote still has enough time left to be used. */
export function quoteUsable(quote: VideoQuote, now = Date.now()): boolean {
  return now + QUOTE_MARGIN_MS < quote.deadline;
}

/** The frozen `CreateVideoReq` (without `wait_timeout_ms`, which is not part of the request). */
export type CreateVideoBody = {
  request_id: string;
  draft_id: string;
  input: VideoInput;
  quote_id: string;
};

/** A new request ID for one video (one intent; never reused for another body). */
export function newVideoRequestId(): string {
  return 'video_' + randomUUID().replace(/-/g, '');
}

export type VideoTask = {
  requestId: string;
  taskId: string;
  draftId: string;
  version: number;
  status: string;
  billing: string;
  charged: number;
  resultAssetId: string;
  errorCode: string;
  /** The provider's real progress (0–99), null when unknown. */
  progress: number | null;
  createdAtMs: number;
};

/** `VideoTask`, checked as the app checks it. */
export function readVideoTask(value: unknown): VideoTask {
  const task = objectOf(value, 'task');
  const status = str(task.status);
  const billing = str(task.billing_status);
  if (!STATUSES.has(status) || !BILLING.has(billing)) throw protocol('视频任务的状态不认识');
  const resultAssetId = str(task.result_asset_id);
  if ((status === 'SUCCEEDED') !== Boolean(resultAssetId))
    throw protocol('视频任务的结果与状态不一致');
  const progress =
    task.progress_percent === undefined || task.progress_percent === null
      ? null
      : whole(task.progress_percent, 'progress_percent');
  if (progress !== null && (progress < 0 || progress > 99)) throw protocol('视频任务的进度不合法');
  const parsed: VideoTask = {
    requestId: str(task.request_id),
    taskId: str(task.task_id),
    draftId: str(task.draft_id),
    version: whole(task.version, 'version'),
    status,
    billing,
    charged: whole(task.charged_diamonds ?? 0, 'charged_diamonds'),
    resultAssetId,
    errorCode: str(task.error_code),
    progress,
    createdAtMs: whole(task.created_at_ms ?? 0, 'created_at_ms'),
  };
  if (!parsed.requestId || !parsed.taskId) throw protocol('视频任务缺少 ID');
  return parsed;
}

/** The newer of two readings of one task (the version only grows). */
export function newerTask(current: VideoTask | null, next: VideoTask): VideoTask {
  return current && current.version > next.version ? current : next;
}

/**
 * True while something can still change: the task is not finished, or its billing is pending or
 * being refunded, or it failed but is still charged (the refund has not started yet).
 */
export function stillChanging(task: VideoTask): boolean {
  if (task.status !== 'SUCCEEDED' && task.status !== 'FAILED') return true;
  if (task.billing === 'PENDING' || task.billing === 'REFUNDING') return true;
  return task.status === 'FAILED' && task.billing === 'CHARGED';
}

/**
 * Named answers that do not show the request was left alone: NOT_FOUND does not prove an unknown
 * create was not accepted, and CONFLICT means the request ID is known with another body.
 */
const NOT_REFUSALS = new Set(['NOT_FOUND', 'CONFLICT']);

/**
 * A failed `ugc/video/create` as a refusal that charged nothing, or null when its outcome is
 * unknown. Only a named `ugc_error` (or the wallet's insufficient-balance code) with no task in
 * the answer is a refusal; a bare numeric failure (the gateway's own timeout or RPC error),
 * network errors and 5xx are unknown.
 */
export function createRefusal(error: unknown): GenRefusal | null {
  if (!(error instanceof UgcFailure)) return null;
  const body = error.body ?? {};
  if (body.task) return null;
  const named = typeof body.ugc_error === 'string' && body.ugc_error !== '';
  if (!named && !INSUFFICIENT_GEMS.has(error.code)) return null;
  if (NOT_REFUSALS.has(error.code)) return null;
  const refusal = generationRefusal(error);
  return refusal instanceof GenRefusal ? refusal : null;
}

/**
 * The task a failed answer still carries (the request was accepted), or null; an unreadable one is
 * null too, and `createRefusal` then treats the answer as unknown (it has a task).
 */
export function taskOfFailure(error: unknown): VideoTask | null {
  if (!(error instanceof UgcFailure) || !error.body?.task) return null;
  try {
    return readVideoTask(error.body.task);
  } catch {
    return null;
  }
}

/** `ugc/video/create` with the frozen body and no server-side wait. Charges once per request ID. */
export async function createVideo(gateway: Gateway, body: CreateVideoBody): Promise<VideoTask> {
  const result = await call(gateway, 'ugc/video/create', { ...body, wait_timeout_ms: 0 });
  const task = readVideoTask(result.task);
  if (task.requestId !== body.request_id) throw protocol('创建回包的 request_id 不一致');
  return task;
}

/** `ugc/video/task`: the task's current snapshot (no waiting on the server). */
export async function readTask(
  gateway: Gateway,
  requestId: string,
  draftId: string,
): Promise<VideoTask> {
  const result = await call(gateway, 'ugc/video/task', {
    request_id: requestId,
    draft_id: draftId,
    wait_timeout_ms: 0,
  });
  const task = readVideoTask(result.task);
  if (task.requestId !== requestId) throw protocol('任务回包的 request_id 不一致');
  return task;
}

/** `ugc/video/tasks`: a draft's tasks (pending, refunding and finished), newest first. */
export async function listVideoTasks(
  gateway: Gateway,
  draftId: string,
  limit = 50,
): Promise<{ tasks: VideoTask[]; nextCursor: string }> {
  const result = await call(gateway, 'ugc/video/tasks', { draft_id: draftId, limit });
  return {
    tasks: listOf(result.tasks, 'tasks').map(readVideoTask),
    nextCursor: str(result.next_cursor),
  };
}

/**
 * Watches a task until it settles or the rounds run out: one reading per interval, the first an
 * interval after a snapshot already in hand (the create's answer). A failed reading is reported
 * once and watching goes on; stopping never cancels the task on the server.
 */
export async function watchTask(
  gateway: Gateway,
  requestId: string,
  draftId: string,
  initial: VideoTask | null,
  hooks: { onTick?: (task: VideoTask) => void; onError?: (error: unknown) => void } = {},
): Promise<{ task: VideoTask | null; settled: boolean }> {
  let latest = initial;
  if (latest && !stillChanging(latest)) return { task: latest, settled: true };
  let wait = Boolean(initial);
  const polled = await pollUntil(
    async () => {
      if (wait) {
        wait = false;
        await new Promise((done) => setTimeout(done, VIDEO_POLL.intervalMs));
      }
      latest = newerTask(latest, await readTask(gateway, requestId, draftId));
      return latest;
    },
    {
      intervalMs: VIDEO_POLL.intervalMs,
      maxRounds: VIDEO_POLL.maxRounds,
      done: (task) => !stillChanging(task),
      onTick: (task) => hooks.onTick?.(task),
      onError: hooks.onError,
    },
  );
  return { task: latest, settled: polled.done };
}

// ---------------------------------------------------------------------------------------------
// Results

export type VideoMedia = {
  url: string;
  mime: string;
  byteSize: number;
  sha256: string;
};

/** `ugc/video/media`: a short-lived address (never stored, never printed). */
export async function resolveVideoMedia(
  gateway: Gateway,
  assetId: string,
  purpose: 'POSTER' | 'PREVIEW' | 'ORIGINAL',
): Promise<VideoMedia> {
  const result = await call(gateway, 'ugc/video/media', { asset_id: assetId, purpose });
  const url = str(result.url);
  if (!url || str(result.asset_id) !== assetId) throw protocol('视频地址回包不完整');
  return {
    url,
    mime: str(result.mime_type),
    byteSize: result.byte_size === undefined ? 0 : whole(result.byte_size, 'byte_size'),
    sha256: str(result.sha256).toLowerCase(),
  };
}

/**
 * Downloads a result's preview into `dir` and returns the file's path. The address is resolved
 * right before the download and once more if the download fails (it may have expired); size and
 * SHA-256 are checked against what the server said.
 */
export async function saveVideoPreview(
  gateway: Gateway,
  assetId: string,
  dir: string,
  name: string,
  fetcher?: typeof fetch,
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const media = await resolveVideoMedia(gateway, assetId, 'PREVIEW');
    try {
      const file = await download(media.url, { maxBytes: MEDIA_MAX_BYTES, fetcher });
      if (media.byteSize && file.bytes.length !== media.byteSize)
        throw new Error('下载的视频大小与服务端不一致');
      if (media.sha256 && sha256(file.bytes) !== media.sha256)
        throw new Error('下载的视频校验不一致');
      return saveFile(dir, `${name}.${extensionOf(media.mime || file.mime)}`, file.bytes);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------------------------
// What the CLI keeps (LocalState records)

const REQUESTS = 'video-request';
const RESULTS = 'video-result';

/** One paid request, saved before it is sent. */
export type VideoRequestRecord = {
  /** Exactly what `ugc/video/create` gets (plus `wait_timeout_ms: 0`), every time. */
  request: CreateVideoBody;
  /** The character file it is for. */
  source: string;
  use: VideoUse;
  /** The quoted price the person agreed to. */
  amount: number;
  /** `sent`: the create went out and its answer is unknown; `accepted`: the server has the task. */
  state: 'sent' | 'accepted';
  /** The last snapshot seen. */
  task: VideoTask | null;
  at: number;
};

export function saveVideoRequest(state: LocalState, record: VideoRequestRecord) {
  state.setRecord(REQUESTS, record.request.request_id, record);
}

export function videoRequest(state: LocalState, requestId: string): VideoRequestRecord | null {
  return state.record<VideoRequestRecord>(REQUESTS, requestId);
}

/** Forgets a request the server clearly refused (nothing was charged). */
export function dropVideoRequest(state: LocalState, requestId: string) {
  state.setRecord(REQUESTS, requestId, null);
}

/** The saved requests of a draft, oldest first. */
export function videoRequests(state: LocalState, draftId: string): VideoRequestRecord[] {
  return state
    .records<VideoRequestRecord>(REQUESTS)
    .map(([, record]) => record)
    .filter((record) => record.request.draft_id === draftId);
}

/**
 * A draft's finished videos by use, oldest first. `boundTo`: the character created with them (an
 * asset bound to one character cannot go with another, so they are not sent again).
 */
export type VideoResults = {
  source: string;
  dynamicCover: string[];
  introVideo: string[];
  boundTo?: string;
};

export function videoResults(state: LocalState, draftId: string): VideoResults | null {
  return state.record<VideoResults>(RESULTS, draftId);
}

/** Keeps a finished video for its draft and use (once). */
export function addVideoResult(
  state: LocalState,
  draftId: string,
  source: string,
  use: VideoUse,
  assetId: string,
) {
  // One locked step: two `yomi video` runs finishing at once both keep their result.
  state.updateRecord<VideoResults>(RESULTS, draftId, (current) => {
    const results = current ?? { source, dynamicCover: [], introVideo: [] };
    const list = use === 'intro-video' ? results.introVideo : results.dynamicCover;
    if (!list.includes(assetId)) list.push(assetId);
    return results;
  });
}

/** The character a draft's videos went with, '' while they are still to be submitted. */
export function videosBoundTo(state: LocalState, draftId: string): string {
  return videoResults(state, draftId)?.boundTo ?? '';
}

/** Records that a create carrying this draft's videos made `npcId` (they are not sent again). */
export function markVideosBound(state: LocalState, draftId: string, npcId: string) {
  state.updateRecord<VideoResults>(RESULTS, draftId, (current) =>
    current && !current.boundTo ? { ...current, boundTo: npcId } : current,
  );
}

function binding(assetIds: string[]): Json {
  return {
    enabled: true,
    selected_dynamic_video_asset_id: assetIds[assetIds.length - 1],
    dynamic_video_asset_ids: [...assetIds],
  };
}

/**
 * The video part of `CharacterContent.features` for a character file: `dynamic_cover` /
 * `intro_video` (the newest result selected, every result listed) and `features.draft_id`, only
 * when at least one video finished; null otherwise, as the app sends nothing then.
 */
export function videoFeatures(state: LocalState, source: string): Json | null {
  const draftId = state.draft(source).draftId;
  const results = videoResults(state, draftId);
  if (!results || results.boundTo) return null;
  if (!results.dynamicCover.length && !results.introVideo.length) return null;
  const features: Json = {};
  if (results.dynamicCover.length) features.dynamic_cover = binding(results.dynamicCover);
  if (results.introVideo.length) features.intro_video = binding(results.introVideo);
  features.draft_id = draftId;
  return features;
}

/** One line about the videos `videoFeatures` adds (for `yomi create`), '' when there are none. */
export function describeVideoFeatures(features: Json | null | undefined): string {
  if (!features) return '';
  const count = (key: string) =>
    ((features[key] as Json | undefined)?.dynamic_video_asset_ids as unknown[] | undefined)
      ?.length ?? 0;
  const parts = [
    count('dynamic_cover') ? `动态封面 ${count('dynamic_cover')} 条` : '',
    count('intro_video') ? `介绍视频 ${count('intro_video')} 条` : '',
  ].filter(Boolean);
  return parts.length ? `AI 视频：${parts.join('、')}（选用最新一条）` : '';
}
