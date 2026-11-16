import { readFileSync, type Stats, statSync } from 'node:fs';

import { ApiError, type Gateway } from '../core/api.js';
import { UsageError } from '../core/env.js';
import { tr } from '../core/i18n.js';
import { encodeBody, i64, idOf, type Json, list, optionalObject, RawBody } from '../core/json.js';
import { sha256 } from '../core/state.js';
import { call, postForm, putObject, UgcFailure } from '../ugc/api.js';
import { centreCrop, decode, encodeJpeg, RasterError, resize } from './raster.js';

/**
 * Chat personas (the person's own role in chats) and their AI avatars, on the routes the app and
 * the web use:
 *
 * - `user/get_conversation_persona_list`: the personas (`data.items[].persona`), which one is the
 *   default and which is current, and the creation rules.
 * - `user/get_conversation_persona_avatar_config`: the models (the first is the default; the price
 *   is per *successful* image, none means free), the styles and how many images one run makes.
 * - `user/create_image_upload` with image type 3 and the presigned upload: an optional reference
 *   photo, sent as `source_image_object_key`.
 * - `user/create_conversation_persona_avatar_task`: one media task per image, made idempotent by
 *   `client_request_id` (kept unchanged on a retry). This is the call that can charge.
 * - `user/batch_get_conversation_persona_avatar_tasks`: polled every 2 s; 3 (succeeded), 4
 *   (failed) and 5 (rejected by the content check) are final. Failed and rejected images are not
 *   charged.
 * - `user/update_conversation_persona` / `user/create_conversation_persona`: the picked image is
 *   written as `avatar_media_asset_id` (a bare i64), never its display URL, and never together
 *   with `avatar_object_key`.
 *
 * Bodies here carry no `npc_id`-style fields, so they never go through `wireIds`: i64 IDs are
 * written with `i64()` where the route wants them.
 */

/** Status of one avatar image task. */
export const AvatarStatus = {
  unknown: 0,
  queued: 1,
  generating: 2,
  succeeded: 3,
  failed: 4,
  sensitive: 5,
} as const;

/** Persona genders on the wire. */
export const PersonaGender = { unknown: 0, male: 1, female: 2, other: 3 } as const;

export const GENDER_NAMES: Record<string, number> = {
  male: PersonaGender.male,
  female: PersonaGender.female,
  other: PersonaGender.other,
  男: PersonaGender.male, // i18n-ignore
  女: PersonaGender.female, // i18n-ignore
  其他: PersonaGender.other, // i18n-ignore
};

export const GENDER_LABEL: Record<number, string> = {
  get 0() {
    return tr('未知', 'unknown');
  },
  get 1() {
    return tr('男', 'male');
  },
  get 2() {
    return tr('女', 'female');
  },
  get 3() {
    return tr('其他', 'other');
  },
};
export const GENDER_KEY: Record<number, string> = {
  0: 'unknown',
  1: 'male',
  2: 'female',
  3: 'other',
};

/** The prompt limit the app and the web enforce (code points, after trimming). */
export const MAX_PROMPT = 500;
/** A persona name: 1–50 code points after trimming. */
export const MAX_NAME = 50;
/** Images per run when the server does not say. */
export const DEFAULT_IMAGE_COUNT = 4;
/** The reference photo read from disk: at most this many bytes. */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
/** A generated image downloaded: at most this many bytes. */
export const MAX_RESULT_BYTES = 20 * 1024 * 1024;

/**
 * Polling cadence, as the app polls: every 2 s, at most 90 readings (about 3 minutes). Stopping
 * never cancels anything on the server. Tests shorten it.
 */
export const AVATAR_POLL = { intervalMs: 2000, maxRounds: 90 };

export const CREATE_TASK_METHOD = 'create_conversation_persona_avatar_task';
/** The kind under which runs are kept in the local state. */
export const RUN_KIND = 'persona-avatar';

export type Persona = {
  personaId: string;
  name: string;
  gender: number;
  age: number;
  avatarUrl: string;
  avatarAssetId: string;
};

export type PersonaItem = { persona: Persona; isDefault: boolean; isCurrent: boolean };

export type PersonaPanel = {
  items: PersonaItem[];
  defaultPersonaId: string;
  currentPersonaId: string;
  total: number;
  rules: { canCreate: boolean; unlimited: boolean; maxPersonaCnt: number };
};

export type AvatarModel = {
  modelId: string;
  name: string;
  /** Gems per successful image (0: free); null when the server sent something unreadable. */
  price: number | null;
};

export type AvatarStyle = { styleId: string; name: string };

export type AvatarConfig = {
  models: AvatarModel[];
  styles: AvatarStyle[];
  maxImageCnt: number;
};

export type AvatarTask = {
  /** 1-based position, as shown to the person. */
  index: number;
  taskId: string;
  status: number;
  assetId: string;
  /** A display address for this reading only: never stored. */
  imageUrl: string;
  failureCode: string;
  failureMessage: string;
};

/** What became of one image. */
export type AvatarOutcome = 'succeeded' | 'failed' | 'sensitive' | 'incomplete' | 'running';

/** The request as it is frozen (without its `client_request_id`). */
export type AvatarRequest = {
  prompt: string;
  model_id: string;
  image_cnt: number;
  style_id?: string;
  source_image_object_key?: string;
};

/** Where a picked image goes. */
export type AvatarTarget =
  | { kind: 'current' }
  | { kind: 'persona'; personaId: string }
  | { kind: 'new'; name: string; gender: number; age: number };

/** One image of a saved run: its last known state and where it was saved (no URLs). */
export type SavedTask = {
  index: number;
  taskId: string;
  status: number;
  assetId: string;
  failureCode: string;
  file: string;
};

/**
 * A run kept in the local state, saved before the paying call: the frozen body and its request ID
 * (replayed unchanged by `--resume` while the answer is unknown), then the tasks the server made.
 */
export type AvatarRun = {
  requestId: string;
  /** The receipt's key (with `request`, what `dropReceipt` needs after a refusal). */
  receiptKey: string;
  request: AvatarRequest;
  /** The encoded body, sent byte for byte again on a replay. */
  body: string;
  /** Digest of what was asked (prompt, model, style, count, reference bytes). */
  fingerprint: string;
  modelName: string;
  styleName: string;
  unitPrice: number;
  /** `pending`: sent, answer unknown; `accepted`: the server returned its tasks. */
  state: 'pending' | 'accepted';
  tasks: SavedTask[];
  target: AvatarTarget;
  applied: { personaId: string; assetId: string; index: number; created: boolean } | null;
  /**
   * The per-image price in force each time this request was sent (the first send, then each
   * replay), distinct. With more than one, which applies depends on which send the server accepted:
   * only the wallet says. Older records lack it and mean `[unitPrice]`.
   */
  sentPrices?: number[];
  /**
   * A new persona whose `create_conversation_persona` went out and whose answer is unknown: it may
   * exist. Saved before the call, cleared when the answer is known.
   */
  creating?: PendingCreation | null;
  at: number;
};

/** A persona creation sent without a known answer: what was asked, to recognize it in the list. */
export type PendingCreation = {
  name: string;
  gender: number;
  age: number;
  /** The avatar it was created with (the list shows it as `avatar_media_asset_id`). */
  assetId: string;
  index: number;
  at: number;
};

/** The distinct per-image prices this run was sent at (see `AvatarRun.sentPrices`). */
export function sentPrices(run: Pick<AvatarRun, 'sentPrices' | 'unitPrice'>): number[] {
  const prices = run.sentPrices?.length ? run.sentPrices : [run.unitPrice];
  return [...new Set(prices)];
}

/**
 * A 409 / CONFLICT on the create call. With a request ID made for this request it means the
 * server already holds that ID for another body: an earlier send may have been accepted (and
 * charged), so the outcome is unknown, not a refusal.
 */
export function requestIdConflict(error: unknown): boolean {
  const code =
    error instanceof UgcFailure ? error.code : error instanceof ApiError ? String(error.code) : '';
  return code === '409' || code === 'CONFLICT';
}

function readPrice(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  const price = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof price === 'number' && Number.isSafeInteger(price) && price >= 0 ? price : null;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readInt(value: unknown): number {
  const result = typeof value === 'string' ? Number(value) : value;
  return typeof result === 'number' && Number.isFinite(result) ? Math.trunc(result) : 0;
}

/** An i64 ID from a response; '' when absent or zero. */
function readId(value: unknown): string {
  const result = idOf(value);
  return result === '0' ? '' : result;
}

function readPersona(value: unknown): Persona {
  const persona = optionalObject(value);
  return {
    personaId: readId(persona.persona_id),
    name: readText(persona.name),
    gender: readInt(persona.gender),
    age: readInt(persona.age),
    avatarUrl: readText(persona.avatar_url),
    avatarAssetId: readId(persona.avatar_media_asset_id),
  };
}

/**
 * `user/get_conversation_persona_list` without a character: the current persona is then the
 * default one.
 */
export async function readPersonaPanel(gateway: Gateway): Promise<PersonaPanel> {
  const result = await call(gateway, 'user/get_conversation_persona_list', {});
  const data = optionalObject(result.data);
  const items = list(data.items).map((value) => {
    const item = optionalObject(value);
    return {
      persona: readPersona(item.persona),
      isDefault: item.is_default === true,
      isCurrent: item.is_current === true,
    };
  });
  const rules = optionalObject(data.rules);
  return {
    items: items.filter((item) => item.persona.personaId),
    defaultPersonaId: readId(data.default_persona_id),
    currentPersonaId: readId(data.current_persona_id),
    total: data.total_cnt === undefined ? items.length : readInt(data.total_cnt),
    rules: {
      // Absent rules leave the decision to the server.
      canCreate: rules.can_create !== false,
      unlimited: rules.unlimited === true,
      maxPersonaCnt: readInt(rules.max_persona_cnt),
    },
  };
}

/** The persona in use when no character is given: the current one, else the default. */
export function currentPersona(panel: PersonaPanel): PersonaItem | null {
  return (
    panel.items.find((item) => item.isCurrent) ??
    panel.items.find((item) => item.persona.personaId === panel.currentPersonaId) ??
    panel.items.find((item) => item.isDefault) ??
    null
  );
}

/**
 * The persona a creation with an unknown answer made, when the list shows it: the same name with
 * the same AI avatar. Null when it is not there (it may still appear later).
 */
export function createdPersona(panel: PersonaPanel, pending: PendingCreation): Persona | null {
  const found = panel.items.find(
    (item) => item.persona.avatarAssetId === pending.assetId && item.persona.name === pending.name,
  );
  return found?.persona ?? null;
}

/** `user/get_conversation_persona_avatar_config`: models, styles and the per-run limit. */
export async function readAvatarConfig(gateway: Gateway): Promise<AvatarConfig> {
  const result = await call(gateway, 'user/get_conversation_persona_avatar_config', {});
  const models = list(result.models)
    .map((value) => {
      const model = optionalObject(value);
      return {
        modelId: readText(model.model_id),
        name: readText(model.display_name) || readText(model.model_id),
        price: readPrice(model.price_diamonds),
      };
    })
    .filter((model) => model.modelId);
  const styles = list(result.styles)
    .map((value) => {
      const style = optionalObject(value);
      return {
        styleId: readText(style.style_id),
        name: readText(style.display_name) || readText(style.style_id),
      };
    })
    .filter((style) => style.styleId);
  const max = result.max_image_cnt;
  return {
    models,
    styles,
    // As the app: 4 when the server does not say, never below 1.
    maxImageCnt: Math.max(
      1,
      max === undefined || max === null ? DEFAULT_IMAGE_COUNT : readInt(max),
    ),
  };
}

/**
 * A reference photo from disk, prepared as the web prepares one: cropped around the centre to
 * 3:4, scaled down to at most 1024 px high, JPEG. JPEG and PNG only.
 */
export function prepareReference(path: string): { jpeg: Buffer; sha256: string } {
  let info: Stats;
  try {
    info = statSync(path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error)))
      throw new UsageError(tr(`找不到参考图：${path}`, `Reference image not found: ${path}`));
    throw new UsageError(
      tr(
        `参考图读不出来：${path}（${accessHint(error)}）`,
        `Cannot read the reference image: ${path} (${accessHint(error)})`,
      ),
    );
  }
  if (info.isDirectory())
    throw new UsageError(
      tr(
        `--reference 要指向一张图片，${path} 是文件夹（JPEG 或 PNG）`,
        `--reference must point to an image; ${path} is a folder (JPEG or PNG)`,
      ),
    );
  // A pipe or a device could block or never end: only regular files.
  if (!info.isFile())
    throw new UsageError(
      tr(
        `--reference 要指向一张图片文件（JPEG 或 PNG）：${path}`,
        `--reference must point to an image file (JPEG or PNG): ${path}`,
      ),
    );
  if (info.size > MAX_REFERENCE_BYTES)
    throw new UsageError(
      tr('参考图不能超过 20 MB', 'The reference image cannot be larger than 20 MB'),
    );
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new UsageError(
      tr(
        `参考图读不出来：${path}（${accessHint(error)}）`,
        `Cannot read the reference image: ${path} (${accessHint(error)})`,
      ),
    );
  }
  if (!bytes.length)
    throw new UsageError(
      tr(`参考图是空文件：${path}`, `The reference image is an empty file: ${path}`),
    );
  try {
    const cropped = centreCrop(decode(bytes), 3 / 4);
    const scale = Math.min(1, 1024 / cropped.height);
    const scaled = resize(
      cropped,
      Math.max(1, Math.round(cropped.width * scale)),
      Math.max(1, Math.round(cropped.height * scale)),
    );
    return { jpeg: encodeJpeg(scaled, 90), sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof RasterError)
      throw new UsageError(tr(`参考图：${error.message}`, `Reference image: ${error.message}`));
    throw new UsageError(
      tr(
        '参考图读不出来，请换一张 JPEG 或 PNG',
        'Cannot read the reference image; use another JPEG or PNG',
      ),
    );
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : '';
}

function accessHint(error: unknown): string {
  const code = errorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return tr('没有读取权限', 'no read permission');
  if (code === 'EISDIR') return tr('这是文件夹', 'it is a folder');
  return code ? tr(`系统错误 ${code}`, `system error ${code}`) : tr('读取失败', 'read failed');
}

/**
 * Uploads a reference photo: `user/create_image_upload` (image type 3) and the presigned upload
 * the ticket asks for (a PUT, or a form POST when it carries form fields). Returns the object key.
 */
export async function uploadReference(
  gateway: Gateway,
  jpeg: Buffer,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const ticket = await call(gateway, 'user/create_image_upload', {
    image_type: 3,
    content_type: 'image/jpeg',
    size_bytes: jpeg.length,
  });
  const objectKey = readText(ticket.object_key);
  const url = readText(ticket.upload_url);
  if (!objectKey || !url)
    throw new UgcFailure(
      'PROTOCOL',
      tr(
        '服务端没有给出参考图的上传地址',
        'The server gave no upload address for the reference image',
      ),
    );
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(optionalObject(ticket.form_fields)))
    fields[key] = String(value);
  const method = (readText(ticket.method) || 'PUT').toUpperCase();
  if (Object.keys(fields).length > 0) await postForm(url, fields, jpeg, 'image/jpeg', fetcher);
  else if (method === 'PUT') await putObject(url, jpeg, 'image/jpeg', fetcher);
  else
    throw new UgcFailure(
      'PROTOCOL',
      tr(
        `参考图的上传方式（${method}）CLI 暂不支持`,
        `The CLI does not support this reference image upload method yet (${method})`,
      ),
    );
  return objectKey;
}

/** The frozen body of a create request: its ID first, then what was asked. */
export function avatarTaskBody(request: AvatarRequest, requestId: string): string {
  return encodeBody({ client_request_id: requestId, ...request });
}

/** What a run asked for, to recognize the same request again. */
export function requestFingerprint(
  request: Omit<AvatarRequest, 'source_image_object_key'>,
  referenceDigest: string,
): string {
  return sha256(
    JSON.stringify([
      request.prompt,
      request.model_id,
      request.style_id ?? '',
      request.image_cnt,
      referenceDigest,
    ]),
  );
}

function readTask(value: unknown, position: number): AvatarTask {
  const task = optionalObject(value);
  const taskId = readId(task.media_task_id);
  if (!taskId)
    throw new UgcFailure('PROTOCOL', tr('生成任务缺少 ID', 'A generation task has no ID'));
  const index = task.image_index === undefined ? position : readInt(task.image_index);
  return {
    index: index + 1,
    taskId,
    status: readInt(task.status),
    assetId: readId(task.media_asset_id),
    imageUrl: readText(task.image_url),
    failureCode: readText(task.failure_code),
    failureMessage: readText(task.failure_message),
  };
}

function readTasks(result: Json): AvatarTask[] {
  return list(result.tasks).map((value, position) => readTask(value, position));
}

/**
 * `user/create_conversation_persona_avatar_task` with a frozen body (sent unchanged, so a replay
 * keeps its request ID): the tasks in image order.
 */
export async function createAvatarTasks(gateway: Gateway, body: string): Promise<AvatarTask[]> {
  const result = await call(
    gateway,
    'user/create_conversation_persona_avatar_task',
    new RawBody(body),
  );
  return readTasks(result).sort((a, b) => a.index - b.index);
}

/** The poll body: the task IDs as bare i64. */
export function batchBody(taskIds: string[]): Json {
  return { media_task_ids: taskIds.map((id) => i64(id)) };
}

/** `user/batch_get_conversation_persona_avatar_tasks`. */
export async function readAvatarTasks(gateway: Gateway, taskIds: string[]): Promise<AvatarTask[]> {
  const result = await call(
    gateway,
    'user/batch_get_conversation_persona_avatar_tasks',
    batchBody(taskIds),
  );
  return readTasks(result);
}

/** Final: succeeded, failed, or rejected by the content check. */
export function isFinal(status: number): boolean {
  return (
    status === AvatarStatus.succeeded ||
    status === AvatarStatus.failed ||
    status === AvatarStatus.sensitive
  );
}

/**
 * What became of an image. A success counts only with both its asset ID and an image address, as
 * the app and the web require; otherwise it cannot be picked.
 */
export function outcomeOf(
  task: Pick<AvatarTask, 'status' | 'assetId' | 'imageUrl'>,
): AvatarOutcome {
  if (task.status === AvatarStatus.succeeded)
    return task.assetId && task.imageUrl ? 'succeeded' : 'incomplete';
  if (task.status === AvatarStatus.failed) return 'failed';
  if (task.status === AvatarStatus.sensitive) return 'sensitive';
  return 'running';
}

/** The update body: only the AI avatar's asset ID, never with an object key. */
export function updateAvatarBody(personaId: string, assetId: string): Json {
  return { persona_id: i64(personaId), patch: { avatar_media_asset_id: i64(assetId) } };
}

/** The create body: a new persona with the AI avatar (an empty description, as the app sends). */
export function createPersonaBody(
  target: { name: string; gender: number; age: number },
  assetId: string,
): Json {
  return {
    input: {
      name: target.name,
      gender: target.gender,
      age: target.age,
      description: '',
      avatar_media_asset_id: i64(assetId),
    },
  };
}

/** Writes the picked image as the persona's avatar; returns the saved persona. */
export async function setPersonaAvatar(
  gateway: Gateway,
  personaId: string,
  assetId: string,
): Promise<Persona> {
  const result = await call(
    gateway,
    'user/update_conversation_persona',
    updateAvatarBody(personaId, assetId),
  );
  return readPersona(result.persona);
}

/** Creates a persona with the picked image as its avatar (it is not made default or current). */
export async function createPersona(
  gateway: Gateway,
  target: { name: string; gender: number; age: number },
  assetId: string,
): Promise<Persona> {
  const result = await call(
    gateway,
    'user/create_conversation_persona',
    createPersonaBody(target, assetId),
  );
  return readPersona(result.persona);
}
