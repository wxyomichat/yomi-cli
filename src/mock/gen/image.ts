import { createHash } from 'node:crypto';

import type { Json } from '../../core/json.js';
import { type MockGenContext, type MockRoutes, solidPngBytes } from './context.js';

/**
 * The mock's character images (`npc/*ugc_image_generation*`), after the service's interface:
 * a flat configuration (models with per-picture price and an optional struck original, styles per
 * model, ratios, the most pictures per batch, a version that freezes the quote); a batch that is
 * checked, paid for in full when accepted (too few gems: the wallet's 1503021061, nothing
 * accepted) and replayed unchanged for the same `client_request_id` (the same ID with another
 * body is 409); string batch IDs beside i64 task and asset IDs; and per-output outcomes, each
 * failed output refunded on its own (`refunding`, then `refunded` a reading later).
 *
 * Every reading of a batch moves it on: queued at the create, final after `readsToFinish`
 * readings, refunds done `readsToRefund` readings after that. Result addresses are new on every
 * reading and say when they expire, as signed addresses do.
 *
 * Markers in the prompt pick outcomes: `[fail:N]` output N fails, `[sensitive:N]` output N is
 * refused by the content checks, `[webp]` the results are WebP, `[noasset]` the results carry no
 * asset ID.
 */

export type MockImageOutput = {
  taskId: string;
  assetId: string;
  outcome: 'ok' | 'fail' | 'sensitive';
  refunded: boolean;
};

export type MockImageBatch = {
  batchId: string;
  requestId: string;
  /** Digest of the request without its ID (a replay must match). */
  digest: string;
  prompt: string;
  modelId: string;
  ratio: string;
  unitPrice: number;
  webp: boolean;
  /** Results without an `asset_id` (the field is optional). */
  noAsset: boolean;
  reads: number;
  createdAt: number;
  outputs: MockImageOutput[];
};

export type MockImageState = {
  /** The configuration answer (without base_resp); tests may change it. */
  config: Json;
  batches: Map<string, MockImageBatch>;
  /** Batch ID by `client_request_id`. */
  byRequest: Map<string, string>;
  /** The next create is accepted and charged, but its answer is lost (HTTP 500). */
  loseNextAnswer: boolean;
  /** The next create is refused with this code (and `ugc_error`), nothing accepted. */
  refuseNext: { code: number; message: string; ugcError?: string } | null;
  readsToFinish: number;
  readsToRefund: number;
  /** Gems taken and given back by this module. */
  charged: number;
  refunded: number;
};

const ImageStatus = { queued: 1, running: 2, succeeded: 4, failed: 5 };
/** The task-level billing enum (clients read the batch's string list instead). */
const TaskBilling = { chargePending: 1, charged: 2, refundPending: 3, refunded: 4 };
/** The scene of a character picture. */
const UGC_AVATAR_SCENE = 3;

/** The mock's configuration: two models (one with a higher struck original), styles per model. */
export function defaultImageConfig(): Json {
  return {
    enabled: true,
    models: [
      {
        model_id: 'yomi-art',
        name: 'Yomi Art',
        price: 50,
        original_price: 100,
        description: '细节丰富的插画风格',
      },
      { model_id: 'yomi-lite', name: 'Yomi Lite', price: 5, original_price: 5 },
    ],
    styles: ['anime', 'realistic'],
    style_options: [
      {
        style_id: 'anime',
        display_name: '动漫',
        preview_image_url: '',
        model_ids: ['yomi-art', 'yomi-lite'],
      },
      {
        style_id: 'realistic',
        display_name: '写实',
        preview_image_url: '',
        model_ids: ['yomi-art'],
      },
    ],
    aspect_ratios: ['9:16', '1:1'],
    max_count: 4,
    config_version: 'mock-image-v1',
  };
}

/** A canonical digest: keys sorted at every level. */
function digestOf(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item as Json)
          .sort()
          .map((key) => [key, canonical((item as Json)[key])]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Bytes that read as WebP (RIFF…WEBP) without being a picture the CLI can decode. */
function webpBytes(): Buffer {
  const body = Buffer.concat([Buffer.from('WEBPVP8 ', 'ascii'), Buffer.alloc(40, 0x11)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, body]);
}

/** Output numbers (1-based) a `[marker:N]` names. */
function marked(prompt: string, marker: string): Set<number> {
  return new Set(
    [...prompt.matchAll(new RegExp(`\\[${marker}:(\\d+)\\]`, 'g'))].map((match) =>
      Number(match[1]),
    ),
  );
}

const COLOURS: [number, number, number][] = [
  [200, 80, 90],
  [80, 160, 200],
  [120, 190, 100],
  [230, 180, 60],
];

/** The mock's three image routes; their state is `store.image` (`MockImageState`). */
export function imageRoutes(context: MockGenContext): MockRoutes {
  const state: MockImageState = {
    config: defaultImageConfig(),
    batches: new Map(),
    byRequest: new Map(),
    loseNextAnswer: false,
    refuseNext: null,
    readsToFinish: 1,
    readsToRefund: 1,
    charged: 0,
    refunded: 0,
  };
  context.store.image = state;
  const pictures = new Map<string, Buffer>();

  /** The picture of one output (made once): the batch's ratio, a colour per output. */
  const picture = (batch: MockImageBatch, index: number) => {
    const key = `${batch.batchId}:${index}`;
    let bytes = pictures.get(key);
    if (!bytes) {
      const [w, h] = batch.ratio.split(':').map(Number);
      const width = 180;
      const height = Math.round((width * (h || 16)) / (w || 9));
      bytes = batch.webp ? webpBytes() : solidPngBytes(width, height, COLOURS[index % 4]);
      pictures.set(key, bytes);
    }
    return bytes;
  };

  const render = (batch: MockImageBatch) => {
    const now = Date.now();
    const final = batch.reads >= state.readsToFinish;
    const refundsDone = batch.reads >= state.readsToFinish + state.readsToRefund;
    const tasks: Json[] = [];
    const billing: string[] = [];
    batch.outputs.forEach((output, index) => {
      const base: Json = {
        task_id: BigInt(output.taskId),
        created_at_ms: batch.createdAt,
        updated_at_ms: now,
        scene: UGC_AVATAR_SCENE,
      };
      if (batch.reads === 0) {
        tasks.push({
          ...base,
          generation_status: ImageStatus.queued,
          billing_status: TaskBilling.chargePending,
        });
        billing.push('pending');
        return;
      }
      if (!final) {
        tasks.push({
          ...base,
          generation_status: ImageStatus.running,
          billing_status: TaskBilling.charged,
        });
        billing.push('charged');
        return;
      }
      if (output.outcome === 'ok') {
        const bytes = picture(batch, index);
        const mime = batch.webp ? 'image/webp' : 'image/png';
        // A new signed address on every reading.
        const url = context.serveMedia(`ugc-image-${output.assetId}-${batch.reads}`, bytes, mime);
        const [w, h] = batch.ratio.split(':').map(Number);
        tasks.push({
          ...base,
          generation_status: ImageStatus.succeeded,
          billing_status: TaskBilling.charged,
          assets: [
            {
              ...(batch.noAsset ? {} : { asset_id: BigInt(output.assetId) }),
              task_id: BigInt(output.taskId),
              output_index: 0,
              original_url: url,
              thumbnail_url: url,
              mime_type: mime,
              width: 180,
              height: Math.round((180 * (h || 16)) / (w || 9)),
              size_bytes: bytes.length,
              created_at_ms: batch.createdAt,
              access_expires_at_ms: now + 10 * 60_000,
              scene: UGC_AVATAR_SCENE,
            },
          ],
        });
        billing.push('charged');
        return;
      }
      if (refundsDone && !output.refunded) {
        output.refunded = true;
        context.setGems(context.gems() + batch.unitPrice);
        state.refunded += batch.unitPrice;
      }
      tasks.push({
        ...base,
        generation_status: ImageStatus.failed,
        billing_status: output.refunded ? TaskBilling.refunded : TaskBilling.refundPending,
        generation_failure:
          output.outcome === 'sensitive'
            ? { code: 'CONTENT_SENSITIVE', message: 'content rejected', retryable: false }
            : { code: 'GENERATION_FAILED', message: 'provider error', retryable: false },
      });
      billing.push(output.refunded ? 'refunded' : 'refunding');
    });
    return { batch_id: batch.batchId, tasks, billing_status: billing };
  };

  const models = () => (Array.isArray(state.config.models) ? state.config.models : []) as Json[];
  const styleOptions = () =>
    (Array.isArray(state.config.style_options) ? state.config.style_options : []) as Json[];

  return {
    'npc/get_ugc_image_generation_config': () => context.ok({ ...state.config }),

    'npc/create_ugc_image_generation_batch': (body) => {
      const requestId = body.client_request_id;
      if (typeof requestId !== 'string' || !requestId)
        return context.fail(400, 'client_request_id required');
      const { client_request_id: _id, ...rest } = body;
      const digest = digestOf(rest);
      const known = state.byRequest.get(requestId);
      if (known) {
        const batch = state.batches.get(known)!;
        // The same request again: the same batch, nothing charged again.
        if (batch.digest !== digest)
          return context.fail(409, 'client_request_id was used for another request');
        return context.ok({ batch: render(batch) });
      }
      if (state.refuseNext) {
        const refusal = state.refuseNext;
        state.refuseNext = null;
        return context.fail(
          refusal.code,
          refusal.message,
          refusal.ugcError ? { ugc_error: refusal.ugcError } : {},
        );
      }
      if (state.config.enabled !== true) return context.fail(403, 'image generation is disabled');
      if (body.config_version !== state.config.config_version)
        return context.fail(409, 'config_version changed');
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim() || [...prompt].length > 1000) return context.fail(400, 'invalid prompt');
      const model = models().find((item) => item.model_id === body.model_id);
      if (!model) return context.fail(400, 'unknown model_id');
      if (typeof body.style_id !== 'string') return context.fail(400, 'style_id required');
      if (
        body.style_id &&
        !styleOptions().some(
          (style) =>
            style.style_id === body.style_id &&
            Array.isArray(style.model_ids) &&
            style.model_ids.includes(body.model_id),
        )
      )
        return context.fail(400, 'style_id not offered for this model');
      const ratios = (state.config.aspect_ratios ?? []) as string[];
      if (typeof body.aspect_ratio !== 'string' || !ratios.includes(body.aspect_ratio))
        return context.fail(400, 'unknown aspect_ratio');
      const count = body.image_count;
      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > Math.min(4, Number(state.config.max_count))
      )
        return context.fail(400, 'image_count out of range');
      if (body.reference !== undefined) {
        const reference = (body.reference ?? {}) as Json;
        const keys = Object.keys(reference);
        // Exactly one of upload_id / asset_id, as a bare i64 (19 digits arrive as a string).
        if (
          keys.length !== 1 ||
          !['upload_id', 'asset_id'].includes(keys[0]) ||
          !/^[1-9][0-9]{0,18}$/.test(String(reference[keys[0]]))
        )
          return context.fail(400, 'invalid reference');
      }
      const unitPrice = Number(model.price);
      const total = unitPrice * count;
      if (context.gems() < total) return context.fail(1503021061, 'wallet insufficient amount');
      const failing = marked(prompt, 'fail');
      const sensitive = marked(prompt, 'sensitive');
      const batch: MockImageBatch = {
        batchId: 'ugcimg_' + context.nextId(),
        requestId,
        digest,
        prompt,
        modelId: String(model.model_id),
        ratio: body.aspect_ratio,
        unitPrice,
        webp: prompt.includes('[webp]'),
        noAsset: prompt.includes('[noasset]'),
        reads: 0,
        createdAt: Date.now(),
        outputs: Array.from({ length: count }, (_, index) => ({
          taskId: context.nextId(),
          assetId: context.nextId(),
          outcome: failing.has(index + 1)
            ? ('fail' as const)
            : sensitive.has(index + 1)
              ? ('sensitive' as const)
              : ('ok' as const),
          refunded: false,
        })),
      };
      // Accepted: the whole batch is paid for before any work runs.
      context.setGems(context.gems() - total);
      state.charged += total;
      state.batches.set(batch.batchId, batch);
      state.byRequest.set(requestId, batch.batchId);
      if (state.loseNextAnswer) {
        state.loseNextAnswer = false;
        throw new Error('upstream timeout');
      }
      return context.ok({ batch: render(batch) });
    },

    'npc/batch_get_ugc_image_generation_tasks': (body) => {
      const batch = state.batches.get(String(body.batch_id ?? ''));
      if (!batch) return context.fail(404, 'batch not found');
      batch.reads += 1;
      return context.ok({ batch: render(batch) });
    },
  };
}
