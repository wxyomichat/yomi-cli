import { createHash } from 'node:crypto';

import type { Json } from '../../core/json.js';
import { decode } from '../../gen/raster.js';
import { type MockGenContext, type MockRoutes, solidPngBytes } from './context.js';

/**
 * The mock's character video (`ugc/video/*`), following the service's video interface: every ID a
 * string, flat answers with a named `ugc_error`, display prices in the config and the price that
 * is charged in a quote that runs out by the server's own clock (set apart from the local one, so
 * a client comparing the two clocks goes wrong), a private first-frame upload, and a create that
 * charges once per `request_id`: the same ID with the same body answers the original task (looked
 * up before the quote's validity), another body is a CONFLICT. A refusal without a task charges
 * nothing. Tasks move one step per `ugc/video/task` reading; a failed one is refunded a reading or
 * two later (REFUNDING, then REFUNDED).
 *
 * A custom prompt steers a test:
 * - `FAIL_VIDEO`: generation fails, then the charge is refunded.
 * - `REJECT_VIDEO`: the result fails the content check (CONTENT_REJECTED), then it is refunded.
 * - `LOSE_ANSWER`: the create is accepted, but its answer is lost on the way back, answered as a
 *   gateway timeout is: a bare numeric code, no `ugc_error`, no task.
 * - `DROP_REQUEST`: the same lost answer, but the first create never reached the service (a
 *   resend of the same request gets through).
 * - `SLOW_VIDEO`: generation never finishes.
 */

type Scenario = 'ok' | 'fail' | 'reject' | 'lose' | 'drop' | 'slow';

type Frame = {
  uploadId: string;
  requestId: string;
  draftId: string;
  sha256: string;
  size: number;
  assetId: string;
};

type Asset = { kind: 'frame' | 'result' | 'template'; draftId: string; color: number };

type Quote = { quoteId: string; draftId: string; input: Json; amount: number; expiresAt: number };

export type MockVideoTask = {
  /** The create's body as accepted (without `wait_timeout_ms`), canonical JSON. */
  frozen: string;
  requestId: string;
  taskId: string;
  draftId: string;
  version: number;
  status: string;
  billing: string;
  amount: number;
  charged: number;
  resultAssetId: string;
  errorCode: string;
  progress: number | null;
  createdAtMs: number;
  scenario: Scenario;
};

export type MockVideoStore = {
  configVersion: string;
  customVersion: string;
  maxConcurrentTasks: number;
  /** The server's clock minus the local one. */
  clockSkewMs: number;
  /** How long a quote is good for. */
  quoteTtlMs: number;
  /** Lifetimes for the next quotes, used first, one each. */
  ttlPlan: number[];
  /** Added to every quoted price (a quote that differs from the display price). */
  priceDelta: number;
  /** Additions for the next quotes, used first, one each (then `priceDelta`). */
  pricePlan: number[];
  /** Request IDs whose first create was dropped (`DROP_REQUEST`): a resend gets through. */
  dropped: Set<string>;
  frames: Map<string, Frame>;
  assets: Map<string, Asset>;
  quotes: Map<string, Quote>;
  /** Accepted creates by `request_id`. */
  tasks: Map<string, MockVideoTask>;
  /** Every charge and refund, in order. */
  ledger: { requestId: string; kind: 'charge' | 'refund'; amount: number }[];
  /** Every create body received (with `wait_timeout_ms`). */
  creates: Json[];
};

/** The mock's display prices: custom 5 s / 10 s, and two templates. */
export const MOCK_VIDEO = {
  customPrices: { 5: 100, 10: 180 } as Record<number, number>,
  dawn: { id: 'tpl_dawn', version: 'v3', name: 'Dawn', seconds: 7, price: 150 },
  ripple: { id: 'tpl_ripple', version: 'v1', name: 'Ripple' },
};

const MAX_FRAME = 10 * 1024 * 1024;
const DRAFT = /^draft_[0-9a-f]{32}$/;
const REQUEST = /^[A-Za-z0-9_-]{1,64}$/;

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** JSON with sorted keys: what the service compares a replay against. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Json)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function scenarioOf(prompt: string): Scenario {
  if (prompt.includes('FAIL_VIDEO')) return 'fail';
  if (prompt.includes('REJECT_VIDEO')) return 'reject';
  if (prompt.includes('LOSE_ANSWER')) return 'lose';
  if (prompt.includes('DROP_REQUEST')) return 'drop';
  if (prompt.includes('SLOW_VIDEO')) return 'slow';
  return 'ok';
}

/** A few bytes that start like an MP4 (what the mock "generates"). */
function fakeMp4(marker: string): Buffer {
  const ftyp = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 2, 0]);
  return Buffer.concat([ftyp, Buffer.from('isomiso2'), Buffer.from(`mdat:${marker}`)]);
}

export function videoRoutes(context: MockGenContext): MockRoutes {
  const store: MockVideoStore = {
    configVersion: 'video-config-7',
    customVersion: 'custom-v2',
    maxConcurrentTasks: 3,
    clockSkewMs: -2 * 60 * 60 * 1000,
    quoteTtlMs: 10 * 60 * 1000,
    ttlPlan: [],
    priceDelta: 0,
    pricePlan: [],
    dropped: new Set(),
    frames: new Map(),
    assets: new Map(),
    quotes: new Map(),
    tasks: new Map(),
    ledger: [],
    creates: [],
  };
  context.store.video = store;
  const now = () => Date.now() + store.clockSkewMs;
  const refuse = (code: string, extra: Json = {}) => context.ok({ ...extra, ugc_error: code });
  const isText = (value: unknown): value is string => typeof value === 'string';

  const dawnPoster = context.nextId();
  const dawnPreview = context.nextId();
  store.assets.set(dawnPoster, { kind: 'template', draftId: '', color: 0x334455 });
  store.assets.set(dawnPreview, { kind: 'template', draftId: '', color: 0x334455 });

  const templates = () => [
    {
      template_id: MOCK_VIDEO.dawn.id,
      version: MOCK_VIDEO.dawn.version,
      name: MOCK_VIDEO.dawn.name,
      description: '清晨的光慢慢铺开，角色抬头看向镜头。',
      poster_asset_id: dawnPoster,
      preview_asset_id: dawnPreview,
      duration_seconds: [MOCK_VIDEO.dawn.seconds],
      default_duration_seconds: MOCK_VIDEO.dawn.seconds,
      duration_prices: [
        { duration_seconds: MOCK_VIDEO.dawn.seconds, diamond_amount: MOCK_VIDEO.dawn.price },
      ],
    },
    {
      template_id: MOCK_VIDEO.ripple.id,
      version: MOCK_VIDEO.ripple.version,
      name: MOCK_VIDEO.ripple.name,
      description: '水面的波纹从脚下散开。',
      poster_asset_id: dawnPoster,
      preview_asset_id: dawnPreview,
      duration_seconds: [5, 7],
      default_duration_seconds: 7,
    },
  ];

  function priceOf(templateId: string, seconds: number): number | null {
    if (!templateId) return MOCK_VIDEO.customPrices[seconds] ?? null;
    if (templateId === MOCK_VIDEO.dawn.id)
      return seconds === MOCK_VIDEO.dawn.seconds ? MOCK_VIDEO.dawn.price : null;
    // Ripple shows no display price; its quote is 120 at either duration.
    return 120;
  }

  /** `ResolveVideoMediaResp` fields for an asset, served under /media/. */
  function media(assetId: string, purpose: string): Json {
    const asset = store.assets.get(assetId)!;
    const poster = purpose === 'POSTER';
    const bytes = poster
      ? solidPngBytes(72, 128, [asset.color >> 16, (asset.color >> 8) & 255, asset.color & 255])
      : fakeMp4(`${assetId}:${purpose}`);
    const mime = poster ? 'image/png' : 'video/mp4';
    return {
      asset_id: assetId,
      url: context.serveMedia(`video-${assetId}-${purpose}`, bytes, mime),
      mime_type: mime,
      byte_size: bytes.length,
      sha256: hash(bytes),
      expires_at_ms: now() + 10 * 60 * 1000,
    };
  }

  /** The input as the service normalizes it, or the refusal it gets. */
  function checkInput(value: unknown, draftId: string): { input: Json } | { code: string } {
    const input = (value ?? {}) as Json;
    const fields = [
      'first_frame_asset_id',
      'template_id',
      'template_version',
      'custom_prompt',
      'config_version',
    ];
    if (!fields.every((key) => isText(input[key])) || !Number.isInteger(input.duration_seconds))
      return { code: 'INVALID_ARGUMENT' };
    if (input.config_version !== store.configVersion) return { code: 'CONFIG_CHANGED' };
    const frame = store.assets.get(String(input.first_frame_asset_id));
    if (!frame || frame.kind !== 'frame' || frame.draftId !== draftId)
      return { code: 'INVALID_ARGUMENT' };
    const seconds = Number(input.duration_seconds);
    const prompt = String(input.custom_prompt);
    if (input.template_id === '') {
      if (input.template_version !== store.customVersion) return { code: 'CONFIG_CHANGED' };
      if ([...prompt].length > 2000) return { code: 'INVALID_ARGUMENT' };
      if (!(seconds in MOCK_VIDEO.customPrices)) return { code: 'INVALID_ARGUMENT' };
    } else {
      const template = templates().find((item) => item.template_id === input.template_id);
      if (!template || template.version !== input.template_version)
        return { code: 'CONFIG_CHANGED' };
      if (prompt !== '') return { code: 'INVALID_ARGUMENT' };
      if (!template.duration_seconds.includes(seconds)) return { code: 'INVALID_ARGUMENT' };
    }
    return {
      input: {
        first_frame_asset_id: input.first_frame_asset_id,
        template_id: input.template_id,
        template_version: input.template_version,
        custom_prompt: prompt,
        duration_seconds: seconds,
        config_version: input.config_version,
      },
    };
  }

  const taskJson = (task: MockVideoTask): Json => ({
    request_id: task.requestId,
    task_id: task.taskId,
    draft_id: task.draftId,
    version: task.version,
    status: task.status,
    billing_status: task.billing,
    charged_diamonds: task.charged,
    ...(task.resultAssetId ? { result_asset_id: task.resultAssetId } : {}),
    ...(task.errorCode ? { error_code: task.errorCode } : {}),
    ...(task.progress === null ? {} : { progress_percent: task.progress }),
    created_at_ms: task.createdAtMs,
  });

  const settled = (task: MockVideoTask) => task.status === 'SUCCEEDED' || task.status === 'FAILED';

  /** One step of the background work, observed by a reading. */
  function advance(task: MockVideoTask) {
    if (task.billing === 'PENDING') {
      // The charge, against the quote the create froze.
      if (task.amount === 0) {
        task.billing = 'FREE';
        task.status = 'QUEUED';
      } else if (context.gems() < task.amount) {
        task.status = 'FAILED';
        task.billing = 'FAILED';
        task.errorCode = 'INSUFFICIENT_BALANCE';
      } else {
        context.setGems(context.gems() - task.amount);
        store.ledger.push({ requestId: task.requestId, kind: 'charge', amount: task.amount });
        task.billing = 'CHARGED';
        task.charged = task.amount;
        task.status = 'QUEUED';
      }
    } else if (task.status === 'FAILED') {
      if (task.billing === 'CHARGED') task.billing = 'REFUNDING';
      else if (task.billing === 'REFUNDING') {
        context.setGems(context.gems() + task.charged);
        store.ledger.push({ requestId: task.requestId, kind: 'refund', amount: task.charged });
        task.billing = 'REFUNDED';
      } else return;
    } else if (task.status === 'SUCCEEDED') return;
    else if (task.status === 'ACCEPTED' || task.status === 'QUEUED') {
      task.status = 'RUNNING';
      task.progress = task.scenario === 'slow' ? 10 : 35;
    } else if (task.status === 'RUNNING') {
      if (task.scenario === 'slow') task.progress = Math.min(99, (task.progress ?? 0) + 1);
      else if (task.scenario === 'fail') {
        task.status = 'FAILED';
        task.errorCode = 'GENERATION_FAILED';
        task.progress = null;
      } else if ((task.progress ?? 0) < 80) task.progress = 80;
      else {
        task.status = 'REVIEWING';
        task.progress = null;
      }
    } else if (task.status === 'REVIEWING') {
      if (task.scenario === 'reject') {
        task.status = 'FAILED';
        task.errorCode = 'CONTENT_REJECTED';
        if (task.billing === 'CHARGED') task.billing = 'REFUNDING';
      } else {
        task.status = 'SUCCEEDED';
        task.resultAssetId = context.nextId();
        store.assets.set(task.resultAssetId, {
          kind: 'result',
          draftId: task.draftId,
          color: 0x8844aa,
        });
      }
    }
    task.version += 1;
  }

  return {
    'ugc/video/config': () =>
      context.ok({
        config_version: store.configVersion,
        custom_version: store.customVersion,
        custom_duration_seconds: [5, 10],
        custom_default_duration_seconds: 5,
        templates: templates().map((template, index) =>
          index === 0 ? { ...template, poster_media: media(dawnPoster, 'POSTER') } : template,
        ),
        max_concurrent_tasks: store.maxConcurrentTasks,
        server_time_ms: now(),
        custom_duration_prices: Object.entries(MOCK_VIDEO.customPrices).map(
          ([seconds, amount]) => ({ duration_seconds: Number(seconds), diamond_amount: amount }),
        ),
      }),

    'ugc/video/frame/prepare': (body) => {
      const { request_id: requestId, draft_id: draftId, sha256, byte_size: size } = body;
      if (
        !isText(requestId) ||
        !/^frame_[0-9a-f]{48}$/.test(requestId) ||
        !isText(draftId) ||
        !DRAFT.test(draftId) ||
        !isText(sha256) ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        typeof size !== 'number' ||
        size < 1 ||
        size > MAX_FRAME
      )
        return refuse('INVALID_ARGUMENT');
      let frame = [...store.frames.values()].find((item) => item.requestId === requestId);
      if (frame && (frame.sha256 !== sha256 || frame.size !== size || frame.draftId !== draftId))
        return refuse('CONFLICT');
      if (!frame) {
        frame = { uploadId: context.nextId(), requestId, draftId, sha256, size, assetId: '' };
        store.frames.set(frame.uploadId, frame);
      }
      return context.ok({
        upload_id: frame.uploadId,
        upload_url: context.blobUrl(`video-frame-${frame.uploadId}`),
        expires_at_ms: now() + 15 * 60 * 1000,
      });
    },

    'ugc/video/frame/complete': (body) => {
      if (!isText(body.upload_id)) return refuse('INVALID_ARGUMENT');
      const frame = store.frames.get(body.upload_id);
      if (!frame) return refuse('NOT_FOUND');
      if (frame.assetId) return context.ok({ asset_id: frame.assetId });
      const blob = context.blobs.get(`video-frame-${frame.uploadId}`);
      // The signature binds both headers: without them the object store refuses the PUT.
      if (
        !blob ||
        blob.method !== 'PUT' ||
        blob.contentType !== 'image/jpeg' ||
        blob.headers['x-oss-object-acl'] !== 'private'
      )
        return refuse('INVALID_ARGUMENT');
      if (blob.bytes.length !== frame.size || hash(blob.bytes) !== frame.sha256)
        return refuse('INVALID_ARGUMENT');
      try {
        const picture = decode(blob.bytes);
        if (picture.width !== 720 || picture.height !== 1280) return refuse('INVALID_ARGUMENT');
      } catch {
        return refuse('INVALID_ARGUMENT');
      }
      frame.assetId = context.nextId();
      store.assets.set(frame.assetId, { kind: 'frame', draftId: frame.draftId, color: 0 });
      return context.ok({ asset_id: frame.assetId });
    },

    'ugc/video/quote': (body) => {
      const draftId = body.draft_id;
      if (!isText(draftId) || !DRAFT.test(draftId)) return refuse('INVALID_ARGUMENT');
      const checked = checkInput(body.input, draftId);
      if ('code' in checked) return refuse(checked.code);
      const price = priceOf(
        String(checked.input.template_id),
        Number(checked.input.duration_seconds),
      );
      if (price === null) return refuse('INVALID_ARGUMENT');
      const serverTime = now();
      const quote: Quote = {
        quoteId: context.nextId(),
        draftId,
        input: checked.input,
        amount: price + (store.pricePlan.shift() ?? store.priceDelta),
        expiresAt: serverTime + (store.ttlPlan.shift() ?? store.quoteTtlMs),
      };
      store.quotes.set(quote.quoteId, quote);
      return context.ok({
        quote: {
          quote_id: quote.quoteId,
          diamond_amount: quote.amount,
          expires_at_ms: quote.expiresAt,
          server_time_ms: serverTime,
          input: quote.input,
        },
      });
    },

    'ugc/video/create': (body) => {
      store.creates.push(body);
      const { request_id: requestId, draft_id: draftId, quote_id: quoteId } = body;
      const wait = body.wait_timeout_ms;
      if (
        !isText(requestId) ||
        !REQUEST.test(requestId) ||
        !isText(draftId) ||
        !DRAFT.test(draftId) ||
        !isText(quoteId) ||
        (wait !== undefined && (typeof wait !== 'number' || wait < 0 || wait > 90_000))
      )
        return refuse('INVALID_ARGUMENT');
      const frozen = canonical({
        request_id: requestId,
        draft_id: draftId,
        input: body.input,
        quote_id: quoteId,
        npc_id: body.npc_id,
      });
      // Idempotency comes before the quote's validity: a replay gets its original task.
      const existing = store.tasks.get(requestId);
      if (existing)
        return existing.frozen === frozen
          ? context.ok({ task: taskJson(existing) })
          : refuse('CONFLICT');
      const prompt = isText((body.input as Json | undefined)?.custom_prompt)
        ? String((body.input as Json).custom_prompt)
        : '';
      const scenario = scenarioOf(prompt);
      if (scenario === 'drop' && !store.dropped.has(requestId)) {
        store.dropped.add(requestId);
        return context.fail(10001, 'downstream timeout');
      }
      const quote = store.quotes.get(quoteId);
      const checked = checkInput(body.input, draftId);
      if ('code' in checked) return refuse(checked.code);
      if (
        !quote ||
        quote.draftId !== draftId ||
        canonical(quote.input) !== canonical(checked.input)
      )
        return refuse('INVALID_ARGUMENT');
      if (now() > quote.expiresAt) return refuse('QUOTE_EXPIRED');
      const active = [...store.tasks.values()].filter((task) => !settled(task)).length;
      if (active >= store.maxConcurrentTasks) return refuse('CONCURRENCY_LIMIT');
      if (context.gems() < quote.amount) return refuse('INSUFFICIENT_BALANCE');
      const task: MockVideoTask = {
        frozen,
        requestId,
        taskId: context.nextId(),
        draftId,
        version: 1,
        status: 'ACCEPTED',
        billing: 'PENDING',
        amount: quote.amount,
        charged: 0,
        resultAssetId: '',
        errorCode: '',
        progress: null,
        createdAtMs: now(),
        scenario,
      };
      store.tasks.set(requestId, task);
      if (scenario === 'lose') return context.fail(10001, 'downstream timeout');
      return context.ok({ task: taskJson(task) });
    },

    'ugc/video/task': (body) => {
      if (!isText(body.request_id) || !isText(body.draft_id)) return refuse('INVALID_ARGUMENT');
      const task = store.tasks.get(body.request_id);
      if (!task || task.draftId !== body.draft_id) return refuse('NOT_FOUND');
      advance(task);
      return context.ok({ task: taskJson(task) });
    },

    'ugc/video/tasks': (body) => {
      const limit = body.limit;
      if (
        !isText(body.draft_id) ||
        !Number.isInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 100
      )
        return refuse('INVALID_ARGUMENT');
      const all = [...store.tasks.values()]
        .filter((task) => task.draftId === body.draft_id)
        .reverse();
      const start = isText(body.cursor) && body.cursor ? Number(body.cursor) : 0;
      const page = all.slice(start, start + Number(limit));
      const more = start + page.length < all.length;
      return context.ok({
        tasks: page.map(taskJson),
        ...(more ? { next_cursor: String(start + page.length) } : {}),
      });
    },

    'ugc/video/media': (body) => {
      if (
        !isText(body.asset_id) ||
        !['POSTER', 'PREVIEW', 'ORIGINAL'].includes(String(body.purpose))
      )
        return refuse('INVALID_ARGUMENT');
      const asset = store.assets.get(body.asset_id);
      if (!asset || asset.kind === 'frame') return refuse('NOT_FOUND');
      return context.ok(media(body.asset_id, String(body.purpose)));
    },

    'ugc/video/feedback': (body) => {
      if (
        !isText(body.request_id) ||
        !isText(body.asset_id) ||
        !['NONE', 'LIKE', 'DISLIKE'].includes(String(body.feedback))
      )
        return refuse('INVALID_ARGUMENT');
      if (store.assets.get(body.asset_id)?.kind !== 'result') return refuse('NOT_FOUND');
      return context.ok({ feedback: body.feedback });
    },
  };
}
