import { createHash } from 'node:crypto';

import type { Json } from '../../core/json.js';
import { emptyContent, NPC_ENTITY_TYPE, Semantic, SenderType } from '../../im/models.js';
import { StreamEventType } from '../../im/thrift.js';
import { type MockGenContext, type MockRoutes, solidPngBytes } from './context.js';

/**
 * The mock's chat images, as the service describes them: `conversation/image/get_config` (the
 * chat's switch, aspect ratios, price and free images left), `conversation/image/create_task`
 * (anchored on one of the character's replies or the opening; the balance is checked first and
 * not enough gems is 40201 with `model_unavailable_dialog` and no task; a repeated
 * `client_request_id` answers its task with `idempotent_replay`) and `media/image/get_task`.
 * A task goes queued → running → persisting → done: the picture becomes a message of its own in
 * the chat (`GeneratedAsset`, `source_mid` = the anchor), is charged on delivery (or a little
 * later, `chargeLagMs`) and pushed as `MessagePersisted`. Answers are flat beside `base_resp`, ids bare i64. Tests steer it through
 * `MockServer.gen.chatImage` (`chatImageStore`).
 */

/** What an accepted task does: deliver, fail, fail the content checks, or fail after its charge. */
export type MockChatImageOutcome = 'succeed' | 'fail' | 'reject' | 'refund';

export type MockChatImageTask = {
  taskId: string;
  requestId: string;
  /** Digest of the request's parameters: the same id with others is refused. */
  hash: string;
  npcId: string;
  cid: string;
  /** '' for the opening (`is_prologue`). */
  anchorMid: string;
  /** Gems it costs, frozen when it was accepted (0: free). */
  price: number;
  /** A free image was taken from the free ones (given back when it fails). */
  usedFree: boolean;
  generation: number;
  delivery: number;
  billing: number;
  resultMid: string;
  assetId: string;
  url: string;
  thumbnailUrl: string;
  sizeBytes: number;
  width: number;
  height: number;
  failure: Json | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type MockChatImage = {
  config: {
    enabled: boolean;
    billingEnabled: boolean;
    coinCost: number;
    /** Free images left (`remaining_free_quota`). */
    freeLeft: number;
    aspectRatios: string[];
  };
  tasks: Map<string, MockChatImageTask>;
  /** `client_request_id` → task id. */
  requests: Map<string, string>;
  /** Every `create_task` body, in order. */
  creates: Json[];
  /** What the next accepted task does (then back to `succeed`). */
  next: MockChatImageOutcome;
  /** The next new task is accepted (and later delivered and charged) but answers a 500. */
  loseNextAnswer: boolean;
  /**
   * The next new task is accepted (and later delivered and charged) but answers this once instead
   * of its task, e.g. a business code nobody knows: the caller cannot tell it was accepted.
   */
  answerNextWith: Json | null;
  /** The next `create_task` answers this once instead (a refusal: no task, nothing charged). */
  failNext: Json | null;
  /**
   * The next image the configuration shows as free is charged its full price anyway (its free
   * quota was used up elsewhere meanwhile).
   */
  chargeFreeNext: boolean;
  /** Push `MessagePersisted` on delivery (false: the result is only in the task and history). */
  push: boolean;
  /** Milliseconds between a task's steps. */
  stepMs: number;
  /**
   * Milliseconds between a priced picture's delivery and its charge (0: charged as it is
   * delivered). Meanwhile the task reads delivered and NotCharged.
   */
  chargeLagMs: number;
  /** An image made on another device of the account: delivered and pushed like any other. */
  fromAnotherDevice(npcId: string, anchorMid: string): MockChatImageTask;
};

/** The chat-image module's state inside `MockServer.gen`. */
export function chatImageStore(gen: Record<string, unknown>): MockChatImage {
  return gen.chatImage as MockChatImage;
}

// `ImageGenerationStatus`, `ImageDeliveryStatus`, `ImageBillingStatus`.
const QUEUED = 1;
const RUNNING = 2;
const PERSISTING = 3;
const SUCCEEDED = 4;
const FAILED = 5;
const NOT_READY = 0;
const PERSISTED = 2;
const NOT_CHARGED = 0;
const CHARGED = 2;
const REFUND_PENDING = 3;
const REFUNDED = 4;
const CHARGE_FAILED = 5;
/** `ImageGenerationScene.Conversation`, `ImageDeliveryPolicy.ConversationMessage`. */
const SCENE_CONVERSATION = 1;
const DELIVER_AS_MESSAGE = 1;
const CHARACTER_REMOVED = 41001;
const INSUFFICIENT_GEMS = 40201;
const LINK_LIFETIME_MS = 10 * 60 * 1000;

const big = (value: string) => BigInt(value);

export function chatImageRoutes(context: MockGenContext): MockRoutes {
  const store: MockChatImage = {
    config: {
      enabled: true,
      billingEnabled: true,
      coinCost: 8,
      freeLeft: 1,
      aspectRatios: ['3:4', '1:1'],
    },
    tasks: new Map(),
    requests: new Map(),
    creates: [],
    next: 'succeed',
    loseNextAnswer: false,
    answerNextWith: null,
    failNext: null,
    chargeFreeNext: false,
    push: true,
    stepMs: 60,
    chargeLagMs: 0,
    fromAnotherDevice: (npcId, anchorMid) => {
      const chat = context.chat(npcId);
      const task = newTask({
        requestId: `chat-image-1-${npcId}-${anchorMid}-another-device-${context.nextId()}`,
        hash: '',
        npcId,
        cid: chat.cid,
        anchorMid,
        price: 0,
        usedFree: false,
      });
      run(task, 'succeed');
      return task;
    },
  };
  context.store.chatImage = store;

  function newTask(
    fields: Pick<
      MockChatImageTask,
      'requestId' | 'hash' | 'npcId' | 'cid' | 'anchorMid' | 'price' | 'usedFree'
    >,
  ): MockChatImageTask {
    const now = Date.now();
    const task: MockChatImageTask = {
      ...fields,
      taskId: context.nextId(),
      generation: QUEUED,
      delivery: NOT_READY,
      billing: NOT_CHARGED,
      resultMid: '',
      assetId: '',
      url: '',
      thumbnailUrl: '',
      sizeBytes: 0,
      width: 0,
      height: 0,
      failure: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: 0,
    };
    store.tasks.set(task.taskId, task);
    store.requests.set(task.requestId, task.taskId);
    return task;
  }

  const touch = (task: MockChatImageTask, patch: Partial<MockChatImageTask>) =>
    Object.assign(task, patch, { updatedAt: Date.now() });

  /** A failed image costs nothing: a free one goes back to the free ones. */
  function fail(task: MockChatImageTask, failure: Json) {
    if (task.usedFree) store.config.freeLeft += 1;
    touch(task, { generation: FAILED, failure, billing: NOT_CHARGED });
  }

  /** A priced picture's charge, once it is delivered. */
  function charge(task: MockChatImageTask) {
    if (task.price <= 0) return;
    if (context.gems() >= task.price) {
      context.setGems(context.gems() - task.price);
      touch(task, { billing: CHARGED });
    } else touch(task, { billing: CHARGE_FAILED });
  }

  /** The picture as its own message in the chat, charged now (or soon), and pushed to the account. */
  function deliver(task: MockChatImageTask) {
    const chat = context.chat(task.npcId);
    const shade = Number(BigInt(task.taskId) % 200n);
    const picture = solidPngBytes(96, 128, [40 + shade, 90, 160]);
    const thumbnail = solidPngBytes(24, 32, [40 + shade, 90, 160]);
    touch(task, {
      generation: SUCCEEDED,
      delivery: PERSISTED,
      billing: NOT_CHARGED,
      resultMid: context.nextId(),
      assetId: context.nextId(),
      url: context.serveMedia(`chat-image-${task.taskId}.png`, picture, 'image/png'),
      thumbnailUrl: context.serveMedia(`chat-image-${task.taskId}-s.png`, thumbnail, 'image/png'),
      sizeBytes: picture.length,
      width: 96,
      height: 128,
      expiresAt: Date.now() + LINK_LIFETIME_MS,
    });
    if (store.chargeLagMs > 0) context.later(store.chargeLagMs, () => charge(task));
    else charge(task);
    const timestamp = Date.now();
    chat.messages.push({
      mid: big(task.resultMid),
      cid: big(chat.cid),
      sender_type: SenderType.assistant,
      content: { text: '', images: [imageJson(task)] },
      timestamp,
      semantic: Semantic.generatedAsset,
      ...(task.anchorMid ? { source_mid: big(task.anchorMid) } : {}),
    });
    if (!store.push) return;
    context.pushChat({
      type: StreamEventType.messagePersisted,
      entityId: task.npcId,
      entityType: NPC_ENTITY_TYPE,
      streamId: '',
      seq: 0,
      chunk: null,
      message: {
        mid: task.resultMid,
        parentMid: '',
        content: emptyContent({
          images: [
            {
              url: task.url,
              assetId: task.assetId,
              thumbnailUrl: task.thumbnailUrl,
              width: task.width,
              height: task.height,
              accessExpiresAtMs: task.expiresAt,
              objectKey: '',
            },
          ],
        }),
        timestamp,
        senderType: SenderType.assistant,
        semantic: Semantic.generatedAsset,
        sourceMid: task.anchorMid,
      },
      error: null,
      cid: chat.cid,
    });
  }

  function run(task: MockChatImageTask, outcome: MockChatImageOutcome) {
    const step = store.stepMs;
    context.later(step, () => touch(task, { generation: RUNNING }));
    context.later(step * 2, () => touch(task, { generation: PERSISTING }));
    context.later(step * 3, () => {
      switch (outcome) {
        case 'succeed':
          return deliver(task);
        case 'fail':
          return fail(task, {
            code: 'GENERATION_FAILED',
            message: '图片生成失败',
            retryable: true,
          });
        case 'reject':
          return fail(task, {
            code: 'CONTENT_SENSITIVE',
            message: '图片内容未通过安全审核',
            retryable: false,
          });
        case 'refund': {
          // Charged as it was being saved, then the save failed: the charge is refunded.
          if (task.price <= 0)
            return fail(task, { code: 'PERSIST_FAILED', message: '图片保存失败', retryable: true });
          context.setGems(context.gems() - task.price);
          touch(task, {
            generation: FAILED,
            billing: REFUND_PENDING,
            failure: { code: 'PERSIST_FAILED', message: '图片保存失败', retryable: true },
          });
          context.later(step * 3, () => {
            context.setGems(context.gems() + task.price);
            touch(task, { billing: REFUNDED });
          });
          return;
        }
      }
    });
  }

  const imageJson = (task: MockChatImageTask): Json => ({
    url: task.url,
    asset_id: big(task.assetId),
    thumbnail_url: task.thumbnailUrl,
    width: task.width,
    height: task.height,
    access_expires_at_ms: task.expiresAt,
  });

  /** `ImageGenerationTask`; signed links are handed out fresh on every read. */
  function taskJson(task: MockChatImageTask): Json {
    if (task.url) task.expiresAt = Date.now() + LINK_LIFETIME_MS;
    return {
      task_id: big(task.taskId),
      generation_status: task.generation,
      source: {
        cid: big(task.cid),
        npc_id: big(task.npcId),
        ...(task.anchorMid ? { anchor_mid: big(task.anchorMid) } : {}),
        entity_id: big(task.npcId),
        entity_type: NPC_ENTITY_TYPE,
      },
      assets:
        task.generation === SUCCEEDED
          ? [
              {
                asset_id: big(task.assetId),
                task_id: big(task.taskId),
                output_index: 0,
                original_url: task.url,
                thumbnail_url: task.thumbnailUrl,
                mime_type: 'image/png',
                width: task.width,
                height: task.height,
                size_bytes: task.sizeBytes,
                created_at_ms: task.updatedAt,
                source_available: true,
                access_expires_at_ms: task.expiresAt,
                asset_type: 1,
                scene: SCENE_CONVERSATION,
              },
            ]
          : [],
      delivery_status: task.delivery,
      ...(task.resultMid ? { result_mid: big(task.resultMid) } : {}),
      ...(task.failure ? { generation_failure: task.failure } : {}),
      billing_status: task.billing,
      created_at_ms: task.createdAt,
      updated_at_ms: task.updatedAt,
      scene: SCENE_CONVERSATION,
      delivery_policy: DELIVER_AS_MESSAGE,
    };
  }

  const removed = () => context.fail(CHARACTER_REMOVED, 'character removed');

  return {
    'conversation/image/get_config': (body) => {
      const npc = context.character(String(body.entity_id ?? ''));
      if (!npc) return removed();
      if (body.entity_type !== NPC_ENTITY_TYPE) return context.fail(400, 'entity_type');
      const { config } = store;
      return context.ok({
        config: {
          enabled: config.enabled,
          allowed_aspect_ratios: config.aspectRatios,
          default_aspect_ratio: config.aspectRatios[0] ?? '',
          config_version: 'mock-chat-image-1',
          billing_enabled: config.billingEnabled,
          coin_cost: config.coinCost,
          remaining_free_quota: config.freeLeft,
        },
      });
    },
    'conversation/image/create_task': (body) => {
      store.creates.push(body);
      const refusal = store.failNext;
      if (refusal) {
        store.failNext = null;
        return refusal;
      }
      const npc = context.character(String(body.entity_id ?? ''));
      if (!npc) return removed();
      if (body.entity_type !== NPC_ENTITY_TYPE) return context.fail(400, 'entity_type');
      const requestId = typeof body.client_request_id === 'string' ? body.client_request_id : '';
      if (!requestId) return context.fail(400, 'client_request_id required');
      const prologue = body.is_prologue === true;
      const anchorMid = body.anchor_mid === undefined ? '' : String(body.anchor_mid);
      const hash = createHash('sha256')
        .update(JSON.stringify([npc.npcId, anchorMid, prologue, body.options ?? null]))
        .digest('hex');
      // The same request again: its task, whatever happened since; never a second charge.
      const known = store.requests.get(requestId);
      if (known) {
        const task = store.tasks.get(known)!;
        if (task.hash !== hash)
          return context.fail(400, 'client_request_id reused with other parameters');
        return context.ok({ task: taskJson(task), idempotent_replay: true });
      }
      if (!store.config.enabled) return context.fail(400, 'image generation is off for this chat');
      const ratio = (body.options as Json | undefined)?.aspect_ratio;
      if (ratio !== undefined && !store.config.aspectRatios.includes(String(ratio)))
        return context.fail(400, 'aspect_ratio not allowed');
      const chat = context.chat(npc.npcId);
      let anchorText = '';
      if (prologue) {
        if (anchorMid) return context.fail(400, 'anchor is not the opening');
      } else {
        const anchor = chat.messages.find((message) => String(message.mid) === anchorMid);
        if (
          !anchor ||
          anchor.sender_type !== SenderType.assistant ||
          Number(anchor.semantic ?? 0) !== Semantic.dialogueTurn
        )
          return context.fail(400, 'invalid anchor');
        anchorText = String((anchor.content as Json | undefined)?.text ?? '');
      }
      const { config } = store;
      const price = config.billingEnabled && config.freeLeft <= 0 ? config.coinCost : 0;
      if (price > 0 && context.gems() < price)
        return context.fail(INSUFFICIENT_GEMS, 'insufficient gems', {
          model_unavailable_dialog: {
            title: '钻石不足',
            content: '钻石不足，充值后即可生成图片',
            right_button: { text: '去充值', highlight: true, schema: 'https://example.com/wallet' },
          },
        });
      const chargedAnyway = store.chargeFreeNext && config.billingEnabled && price === 0;
      store.chargeFreeNext = false;
      const usedFree = config.billingEnabled && price === 0 && !chargedAnyway;
      if (usedFree) config.freeLeft -= 1;
      const task = newTask({
        requestId,
        hash,
        npcId: npc.npcId,
        cid: chat.cid,
        anchorMid,
        price: chargedAnyway ? config.coinCost : price,
        usedFree,
      });
      const outcome: MockChatImageOutcome = anchorText.includes('REJECT') ? 'reject' : store.next;
      store.next = 'succeed';
      run(task, outcome);
      if (store.loseNextAnswer) {
        store.loseNextAnswer = false;
        return context.fail(500, 'internal error');
      }
      const answer = store.answerNextWith;
      if (answer) {
        store.answerNextWith = null;
        return answer;
      }
      return context.ok({ task: taskJson(task), idempotent_replay: false });
    },
    'media/image/get_task': (body) => {
      const task = store.tasks.get(String(body.task_id ?? ''));
      if (!task) return context.fail(404, 'task not found');
      return context.ok({ task: taskJson(task) });
    },
  };
}
