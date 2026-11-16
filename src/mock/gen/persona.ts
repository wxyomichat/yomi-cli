import type { Json } from '../../core/json.js';
import { type MockGenContext, type MockRoutes, solidPngBytes } from './context.js';

/**
 * The mock's chat personas and their AI avatars, answering as the service does for the app and
 * the web:
 *
 * - `user/get_conversation_persona_list` wraps the panel in `data` (items with `is_default` /
 *   `is_current`, the default and current IDs, the count and the creation rules). It replaces the
 *   base mock's one-persona answer and keeps its persona.
 * - `user/get_conversation_persona_avatar_config` is flat: models (the first is the default; no
 *   `price_diamonds` means free), styles, `max_image_cnt`.
 * - `user/create_image_upload` hands out a presigned PUT, or a form POST with fields when
 *   `uploadMode` is `form`; `/blob/<key>` keeps what arrives.
 * - `user/create_conversation_persona_avatar_task` is idempotent on `client_request_id`: the same
 *   ID and payload answer the same tasks and charge nothing; the same ID with another payload is
 *   refused (409). Too few gems refuses with the wallet's insufficient-amount code and creates
 *   nothing. `refuseAtDoor` turns the next create away before that lookup, replays included, as a
 *   rate limiter in front of the service would.
 *   The whole price is held when the tasks are created and each failed or rejected image is
 *   refunded when it ends, so only successes stay charged.
 * - `user/batch_get_conversation_persona_avatar_tasks` takes bare i64 task IDs, answers in request
 *   order, skips unknown IDs, and moves a task on with each reading (`pollsToFinish`).
 * - `user/update_conversation_persona` / `user/create_conversation_persona` answer the persona
 *   flat; `avatar_media_asset_id` must be an asset this mock generated, and never comes with
 *   `avatar_object_key`. `createFailure` breaks the next creation: `lost` creates the persona and
 *   loses the answer, `before` fails before creating anything (both a 500).
 */

export type MockAvatarOutcome = 'ok' | 'fail' | 'sensitive' | 'incomplete';

export type MockPersona = {
  personaId: string;
  name: string;
  gender: number;
  age: number;
  description: string;
  avatarUrl: string;
  avatarAssetId: string;
  createdAt: number;
  updatedAt: number;
};

export type MockAvatarTask = {
  taskId: string;
  requestId: string;
  index: number;
  outcome: MockAvatarOutcome;
  price: number;
  polls: number;
  status: number;
  assetId: string;
  imageUrl: string;
  refunded: boolean;
};

export type MockPersonaState = {
  personas: MockPersona[];
  defaultId: string;
  currentId: string;
  /** Personas a free account may have (0 with `unlimited`). */
  maxPersonas: number;
  unlimited: boolean;
  models: Json[];
  styles: Json[];
  /** `max_image_cnt`, left out when null. */
  maxImageCnt: number | null;
  uploadMode: 'put' | 'form';
  uploads: Map<string, { contentType: string; size: number; fields: Record<string, string> }>;
  /** Accepted requests by `client_request_id`: the payload digest and the tasks made. */
  requests: Map<string, { payload: string; taskIds: string[] }>;
  tasks: Map<string, MockAvatarTask>;
  /** Assets generated (ID → display address). */
  assets: Map<string, string>;
  /** Outcomes of the next images, in order (then `ok`). */
  plan: MockAvatarOutcome[];
  /** Readings before a task ends (1: at the first reading). */
  pollsToFinish: number;
  /** The next accepted create loses its answer (a 500 after the tasks were made and charged). */
  loseNextAnswer: boolean;
  /** The next new create is refused with this code (nothing created, nothing charged). */
  refuseNext: { code: number; message: string } | null;
  /** The next create, replay or not, is refused with this code before the request-ID lookup. */
  refuseAtDoor: { code: number; message: string } | null;
  /** The next `create_conversation_persona` fails with a 500, after or before creating it. */
  createFailure: 'lost' | 'before' | null;
  /** Every gem movement of this module: holds at creation, refunds per failed image. */
  ledger: { requestId: string; taskId: string; amount: number }[];
};

/** The wallet's insufficient-amount refusal. */
const INSUFFICIENT_GEMS = 1503021061;
const INVALID = 400;
const NOT_FOUND = 404;
const CONFLICT = 409;
const CHARACTER_REMOVED = 41001;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const COLOURS: [number, number, number][] = [
  [235, 120, 140],
  [120, 170, 235],
  [140, 210, 150],
  [240, 200, 110],
];

function initialState(): MockPersonaState {
  const now = Date.now();
  return {
    personas: [
      {
        // The base mock's persona, so chat and relay keep their `{{user}}` name.
        personaId: '7300000000000009201',
        name: '旅人',
        gender: 1,
        age: 24,
        description: '',
        avatarUrl: '',
        avatarAssetId: '',
        createdAt: now,
        updatedAt: now,
      },
    ],
    defaultId: '7300000000000009201',
    currentId: '7300000000000009201',
    maxPersonas: 3,
    unlimited: false,
    models: [
      { model_id: 'persona-standard', display_name: '标准', price_diamonds: 3 },
      { model_id: 'persona-lite', display_name: '轻量' },
    ],
    styles: [
      { style_id: 'anime', display_name: '动漫' },
      { style_id: 'portrait', display_name: '写真' },
    ],
    maxImageCnt: 4,
    uploadMode: 'put',
    uploads: new Map(),
    requests: new Map(),
    tasks: new Map(),
    assets: new Map(),
    plan: [],
    pollsToFinish: 1,
    loseNextAnswer: false,
    refuseNext: null,
    refuseAtDoor: null,
    createFailure: null,
    ledger: [],
  };
}

const bigId = (value: string) => BigInt(value);

function codePoints(value: string): number {
  return [...value].length;
}

/** An i64 from a parsed body (bare numbers past 2^53 arrive as digit strings); '' otherwise. */
function idOf(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return '';
}

export function personaRoutes(context: MockGenContext): MockRoutes {
  const state = initialState();
  context.store.persona = state;

  const personaJson = (persona: MockPersona): Json => ({
    persona_id: bigId(persona.personaId),
    name: persona.name,
    ...(persona.avatarUrl ? { avatar_url: persona.avatarUrl } : {}),
    gender: persona.gender,
    age: persona.age,
    description: persona.description,
    last_used_time_ms: persona.updatedAt,
    created_time_ms: persona.createdAt,
    updated_time_ms: persona.updatedAt,
    ...(persona.avatarAssetId ? { avatar_media_asset_id: bigId(persona.avatarAssetId) } : {}),
  });

  const taskJson = (task: MockAvatarTask): Json => ({
    image_index: task.index,
    media_task_id: bigId(task.taskId),
    status: task.status,
    ...(task.assetId ? { media_asset_id: bigId(task.assetId) } : {}),
    ...(task.imageUrl ? { image_url: task.imageUrl } : {}),
    ...(task.outcome === 'fail' && task.status === 4
      ? { failure_code: 'model_error', failure_message: '生成失败，请换个描述再试' }
      : {}),
    ...(task.outcome === 'sensitive' && task.status === 5
      ? { failure_code: 'content_rejected' }
      : {}),
  });

  const refund = (task: MockAvatarTask) => {
    if (task.refunded || task.price <= 0) return;
    task.refunded = true;
    context.setGems(context.gems() + task.price);
    state.ledger.push({ requestId: task.requestId, taskId: task.taskId, amount: task.price });
  };

  const finish = (task: MockAvatarTask) => {
    if (task.outcome === 'ok') {
      task.status = 3;
      task.assetId = context.nextId();
      task.imageUrl = context.serveMedia(
        `persona-avatar/${task.taskId}.png`,
        solidPngBytes(512, 512, COLOURS[task.index % COLOURS.length]),
        'image/png',
      );
      state.assets.set(task.assetId, task.imageUrl);
    } else if (task.outcome === 'incomplete') {
      // Marked succeeded without its asset: the clients treat it as failed.
      task.status = 3;
    } else {
      task.status = task.outcome === 'fail' ? 4 : 5;
      refund(task);
    }
  };

  const advance = (task: MockAvatarTask) => {
    if (task.status >= 3) return;
    task.polls += 1;
    if (task.polls >= state.pollsToFinish) finish(task);
    else task.status = 2;
  };

  /** The rules of the avatar fields both persona writes share. */
  const avatarProblem = (fields: Json): string => {
    const objectKey = fields.avatar_object_key;
    const assetId = fields.avatar_media_asset_id;
    if (objectKey !== undefined && assetId !== undefined)
      return 'avatar_object_key and avatar_media_asset_id are exclusive';
    if (assetId !== undefined && !state.assets.has(idOf(assetId)))
      return 'avatar_media_asset_id is not a generated asset of this user';
    return '';
  };

  return {
    'user/get_conversation_persona_list': (body) => {
      const scope = (body.context ?? {}) as Json;
      if (scope.npc_id !== undefined && !context.character(String(scope.npc_id)))
        return context.fail(CHARACTER_REMOVED, 'character removed');
      const ordered = [
        ...state.personas.filter((persona) => persona.personaId === state.currentId),
        ...state.personas
          .filter((persona) => persona.personaId !== state.currentId)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      ];
      return context.ok({
        data: {
          items: ordered.map((persona) => ({
            persona: personaJson(persona),
            is_default: persona.personaId === state.defaultId,
            is_current: persona.personaId === state.currentId,
          })),
          default_persona_id: bigId(state.defaultId),
          current_persona_id: bigId(state.currentId),
          total_cnt: state.personas.length,
          rules: {
            can_create: state.unlimited || state.personas.length < state.maxPersonas,
            unlimited: state.unlimited,
            max_persona_cnt: state.unlimited ? 0 : state.maxPersonas,
            description_max_chars: 1000,
          },
        },
      });
    },

    'user/get_conversation_persona_avatar_config': () =>
      context.ok({
        models: state.models,
        styles: state.styles,
        ...(state.maxImageCnt === null ? {} : { max_image_cnt: state.maxImageCnt }),
      }),

    'user/create_image_upload': (body) => {
      const type = Number(body.image_type);
      const contentType = typeof body.content_type === 'string' ? body.content_type : '';
      const size = Number(body.size_bytes);
      if (![1, 2, 3].includes(type)) return context.fail(INVALID, 'invalid image_type');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType))
        return context.fail(INVALID, 'unsupported content_type');
      if (!Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES)
        return context.fail(INVALID, 'invalid size_bytes');
      const key = `user/persona/${context.nextId()}.jpg`;
      const fields: Record<string, string> =
        state.uploadMode === 'form'
          ? {
              key,
              policy: 'bW9jay1wb2xpY3k=',
              signature: 'mock-signature',
              'Content-Type': contentType,
            }
          : {};
      state.uploads.set(key, { contentType, size, fields });
      return context.ok({
        object_key: key,
        method: state.uploadMode === 'form' ? 'POST' : 'PUT',
        upload_url: context.blobUrl(key),
        ...(state.uploadMode === 'form' ? { form_fields: fields } : {}),
        expires_at_ms: Date.now() + 15 * 60_000,
      });
    },

    'user/create_conversation_persona_avatar_task': (body) => {
      const requestId = typeof body.client_request_id === 'string' ? body.client_request_id : '';
      if (!requestId) return context.fail(INVALID, 'client_request_id required');
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const modelId = typeof body.model_id === 'string' ? body.model_id : '';
      const styleId = typeof body.style_id === 'string' ? body.style_id : '';
      const objectKey =
        typeof body.source_image_object_key === 'string' ? body.source_image_object_key : '';
      const count = Number(body.image_cnt);
      const payload = JSON.stringify([prompt, modelId, styleId, objectKey, count]);
      if (state.refuseAtDoor) {
        const refusal = state.refuseAtDoor;
        state.refuseAtDoor = null;
        return context.fail(refusal.code, refusal.message);
      }
      const seen = state.requests.get(requestId);
      if (seen) {
        if (seen.payload !== payload)
          return context.fail(CONFLICT, 'client_request_id was used for another request');
        // A replay: the same tasks, nothing charged again.
        return context.ok({
          tasks: seen.taskIds.map((id) => taskJson(state.tasks.get(id)!)),
        });
      }
      if (state.refuseNext) {
        const refusal = state.refuseNext;
        state.refuseNext = null;
        return context.fail(refusal.code, refusal.message);
      }
      if (!prompt) return context.fail(INVALID, 'prompt must not be empty');
      const model = state.models.find((item) => item.model_id === modelId);
      if (!model) return context.fail(INVALID, 'unknown model_id');
      if (styleId && !state.styles.some((item) => item.style_id === styleId))
        return context.fail(INVALID, 'unknown style_id');
      const max = state.maxImageCnt ?? 4;
      if (!Number.isInteger(count) || count < 1 || count > max)
        return context.fail(INVALID, 'invalid image_cnt');
      if (objectKey) {
        const ticket = state.uploads.get(objectKey);
        const blob = context.blobs.get(objectKey);
        const uploaded =
          ticket &&
          blob &&
          blob.bytes.length > 0 &&
          (state.uploadMode === 'form'
            ? blob.method === 'POST' &&
              Object.entries(ticket.fields).every(([key, value]) => blob.fields[key] === value)
            : blob.method === 'PUT' && blob.contentType === ticket.contentType);
        if (!uploaded) return context.fail(INVALID, 'source image was not uploaded');
      }
      const price = typeof model.price_diamonds === 'number' ? model.price_diamonds : 0;
      const total = price * count;
      if (context.gems() < total) return context.fail(INSUFFICIENT_GEMS, 'insufficient gems');
      context.setGems(context.gems() - total);
      const taskIds: string[] = [];
      for (let index = 0; index < count; index++) {
        const task: MockAvatarTask = {
          taskId: context.nextId(),
          requestId,
          index,
          outcome: state.plan.shift() ?? 'ok',
          price,
          polls: 0,
          status: 1,
          assetId: '',
          imageUrl: '',
          refunded: false,
        };
        state.tasks.set(task.taskId, task);
        state.ledger.push({ requestId, taskId: task.taskId, amount: -price });
        taskIds.push(task.taskId);
      }
      state.requests.set(requestId, { payload, taskIds });
      if (state.loseNextAnswer) {
        state.loseNextAnswer = false;
        throw new Error('answer lost after the tasks were created');
      }
      return context.ok({ tasks: taskIds.map((id) => taskJson(state.tasks.get(id)!)) });
    },

    'user/batch_get_conversation_persona_avatar_tasks': (body) => {
      if (!Array.isArray(body.media_task_ids) || body.media_task_ids.length === 0)
        return context.fail(INVALID, 'media_task_ids required');
      if (body.media_task_ids.length > (state.maxImageCnt ?? 4))
        return context.fail(INVALID, 'too many media_task_ids');
      const tasks: MockAvatarTask[] = [];
      for (const value of body.media_task_ids) {
        const task = state.tasks.get(idOf(value));
        if (!task) continue;
        advance(task);
        tasks.push(task);
      }
      return context.ok({ tasks: tasks.map(taskJson) });
    },

    'user/update_conversation_persona': (body) => {
      const persona = state.personas.find((item) => item.personaId === idOf(body.persona_id));
      if (!persona) return context.fail(NOT_FOUND, 'persona not found');
      const patch = (body.patch ?? {}) as Json;
      const problem = avatarProblem(patch);
      if (problem) return context.fail(INVALID, problem);
      if (patch.avatar_media_asset_id !== undefined) {
        persona.avatarAssetId = idOf(patch.avatar_media_asset_id);
        persona.avatarUrl = state.assets.get(persona.avatarAssetId) ?? '';
      }
      if (typeof patch.name === 'string') {
        const name = patch.name.trim();
        if (!name || codePoints(name) > 50) return context.fail(INVALID, 'invalid name');
        persona.name = name;
      }
      persona.updatedAt = Date.now();
      return context.ok({ persona: personaJson(persona) });
    },

    'user/create_conversation_persona': (body) => {
      const failure = state.createFailure;
      state.createFailure = null;
      if (failure === 'before') return context.fail(500, 'internal error');
      const input = (body.input ?? {}) as Json;
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const gender = Number(input.gender);
      const age = Number(input.age);
      if (!name || codePoints(name) > 50) return context.fail(INVALID, 'invalid name');
      if (![1, 2, 3].includes(gender)) return context.fail(INVALID, 'invalid gender');
      if (!Number.isInteger(age) || age < 18) return context.fail(INVALID, 'invalid age');
      const problem = avatarProblem(input);
      if (problem) return context.fail(INVALID, problem);
      if (!state.unlimited && state.personas.length >= state.maxPersonas)
        return context.fail(INVALID, 'persona limit reached');
      const now = Date.now();
      const assetId = idOf(input.avatar_media_asset_id);
      const persona: MockPersona = {
        personaId: context.nextId(),
        name,
        gender,
        age,
        description: typeof input.description === 'string' ? input.description : '',
        avatarUrl: assetId ? (state.assets.get(assetId) ?? '') : '',
        avatarAssetId: assetId,
        createdAt: now,
        updatedAt: now,
      };
      // Created, not made default or current.
      state.personas.push(persona);
      if (failure === 'lost') throw new Error('answer lost after the persona was created');
      return context.ok({ persona: personaJson(persona) });
    },
  };
}
