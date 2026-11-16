import { NotSignedIn } from '../core/api.js';
import { describeEnvironment, UsageError } from '../core/env.js';
import type { LocalState } from '../core/state.js';
import { type Io, paint, say, warn } from '../core/ui.js';
import { confirmSpend, explainRefusal, GenRefusal, mediaDir, pollUntil } from '../gen/common.js';
import {
  adoptRecord,
  batchPrice,
  type BatchRecord,
  billingTotals,
  type CharacterImage,
  checkCharacterFile,
  chooseRequest,
  defaultRatio,
  describeOutput,
  expiresSoon,
  findRecord,
  forgetRecord,
  freezeRequest,
  ReplayRefused,
  type ImageBatch,
  intentOf,
  loadImageConfig,
  loadReference,
  markSettled,
  outcomeOf,
  pendingRecords,
  POLL_INTERVAL_MS,
  POLL_ROUNDS,
  pollingComplete,
  progressLine,
  readBatch,
  recordStatus,
  runningRecords,
  type SavedImage,
  saveOutput,
  stylesFor,
  submitBatch,
  uploadReference,
  writeCharacterImages,
} from '../gen/ugcImage.js';
import { UgcFailure } from '../ugc/api.js';
import { type Context, localState, requireSignIn } from './context.js';
import { confirmProduction } from './declaration.js';

/** `yomi image`: AI pictures for a character's cover and avatar. */
export type ImageCommandOptions = {
  prompt: string;
  model: string;
  style: string;
  count: number | null;
  ratio: string;
  reference: string;
  out: string;
  pick: number | null;
  into: string;
  as: string;
  resume: string;
  /**
   * `--resume <id> --forget`: lets that unknown request or running batch go, without contacting
   * the server.
   */
  forget?: boolean;
  listOptions: boolean;
  acceptPrice: boolean;
  confirmProd: boolean;
  json: boolean;
};

/** What `--json` prints: one object with the outcome. */
type ImageReport = {
  /**
   * done · incomplete (still running, interrupted) · unknown (the create's answer was lost) ·
   * refused · cancelled · forgotten (`--forget`: let go on purpose)
   */
  status: string;
  requestId: string | null;
  batchId: string | null;
  /** The request was an earlier unknown one, sent again with its request ID. */
  replayed: boolean;
  /** An unchanged repeat of an accepted batch that had not settled: that batch, shown again. */
  continued: boolean;
  request: {
    prompt: string;
    model: string;
    style: string;
    ratio: string;
    count: number;
  } | null;
  unitPrice: number | null;
  total: number | null;
  /** Gems by charge state when the unit price is known. */
  charged: number | null;
  refunded: number | null;
  refunding: number | null;
  outputs: {
    index: number;
    taskId: string;
    assetId: string;
    result: string;
    billing: string | null;
    failure: { code: string; message: string } | null;
    files: { original: string; cover: string | null; avatar: string | null } | null;
    error: string | null;
  }[];
  picked: { index: number; file: string; values: Record<string, string> } | null;
  refusal: { kind: string; code: string } | null;
};

const emptyReport = (): ImageReport => ({
  status: '',
  requestId: null,
  batchId: null,
  replayed: false,
  continued: false,
  request: null,
  unitPrice: null,
  total: null,
  charged: null,
  refunded: null,
  refunding: null,
  outputs: [],
  picked: null,
  refusal: null,
});

const PICK_TARGETS = ['cover', 'avatar', 'both'];

function checkFlags(options: ImageCommandOptions) {
  if (options.listOptions) return;
  if (options.resume && options.prompt)
    throw new UsageError('--resume 用来继续查看已有的一批，不能同时给 -p');
  if (options.resume && !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.resume.trim()))
    throw new UsageError(`--resume 需要批次 ID 或请求 ID，收到：${options.resume}`);
  if (options.forget && !options.resume)
    throw new UsageError('--forget 需要配合 --resume <批次 ID 或请求 ID>');
  if (options.forget && (options.pick !== null || options.into))
    throw new UsageError('--forget 只放弃本机的记录，不能同时用 --pick / --into');
  if (!options.resume && !options.prompt.trim())
    throw new UsageError(
      '需要描述：yomi image -p "<描述>"（yomi image --options 查看可选模型和风格）',
    );
  if (options.pick !== null && !options.into)
    throw new UsageError('--pick 需要配合 --into <角色文件> --as cover|avatar|both');
  if (options.into && options.pick === null) throw new UsageError('--into 需要配合 --pick N');
  if (options.as && !options.into) throw new UsageError('--as 需要配合 --pick N --into <角色文件>');
  if (options.into && !PICK_TARGETS.includes(options.as))
    throw new UsageError(
      options.as
        ? '--as 只能是 cover、avatar 或 both'
        : '--into 需要配合 --as cover|avatar|both（写封面、头像或两者）',
    );
}

/**
 * `yomi image`: lists the options, or generates a batch (price and balance shown, an explicit
 * yes, the request frozen before it goes), follows it until every output is final, downloads the
 * results with their cropped cover and avatar, and can write one into a character file. `--resume`
 * picks up an earlier batch (never charged again) or resends an unknown request with its own ID.
 * An unchanged repeat of an accepted batch that has not settled shows that batch again (never
 * charged); `--resume <id> --forget` lets an unknown request or such a batch go on purpose.
 */
export async function image(context: Context, options: ImageCommandOptions): Promise<void> {
  checkFlags(options);
  requireSignIn(context);
  if (options.listOptions) {
    await listOptions(context, options.json);
    return;
  }
  // With --json, stdout carries the JSON alone; everything said to the person goes to stderr.
  const human: Io = options.json ? { ...context.io, stdout: context.io.stderr } : context.io;
  const target = options.into ? checkCharacterFile(options.into) : '';
  const state = localState(context);
  const report = emptyReport();
  try {
    if (options.forget) forget(human, state, options.resume.trim(), report);
    else if (options.resume) await resume(context, human, state, options, target, report);
    else await generate(context, human, state, options, target, report);
  } finally {
    if (options.json && report.status) say(context.io, JSON.stringify(report, null, 2));
  }
}

async function listOptions(context: Context, json: boolean) {
  const { io } = context;
  const config = await loadImageConfig(context.gateway);
  if (json) {
    say(io, JSON.stringify(config, null, 2));
    return;
  }
  say(
    io,
    `AI 生成角色图片：${config.enabled ? '可用' : paint(io, 'yellow', '暂未开放')}${config.version ? paint(io, 'dim', `（配置 ${config.version}）`) : ''}`,
  );
  say(io);
  say(io, paint(io, 'bold', '模型（--model，默认第一个）'));
  for (const model of config.models) {
    const price =
      model.price === null ? paint(io, 'yellow', '价格未知（不能生成）') : `${model.price} 钻石/张`;
    const original =
      model.price !== null && model.originalPrice !== null && model.originalPrice > model.price
        ? paint(io, 'dim', `（原价 ${model.originalPrice}）`)
        : '';
    say(io, `  ${paint(io, 'bold', model.id)}  ${model.name}  ${price}${original}`);
    if (model.description) say(io, paint(io, 'dim', `      ${model.description}`));
  }
  say(io);
  say(io, paint(io, 'bold', '风格（--style，默认不选；按模型）'));
  for (const model of config.models) {
    const styles = stylesFor(config, model.id);
    say(
      io,
      `  ${model.id}：${styles.length ? styles.map((style) => (style.name === style.id ? style.id : `${style.id}（${style.name}）`)).join('、') : paint(io, 'dim', '没有可选风格')}`,
    );
  }
  say(io);
  say(
    io,
    `比例（--ratio）：${config.ratios.length ? config.ratios.join('、') : '无'}${config.ratios.length ? paint(io, 'dim', `，默认 ${defaultRatio(config)}`) : ''}`,
  );
  say(io, `张数（--count）：1–${config.maxCount}，默认 ${Math.min(4, config.maxCount)}`);
  say(io, paint(io, 'dim', '价格按张计算；生成失败或未通过内容检查的那张自动退款。'));
}

function errorCode(error: unknown): string {
  if (error instanceof UgcFailure)
    return error.message && error.message !== error.code
      ? `${error.code}：${error.message}`
      : error.code;
  return error instanceof Error ? error.message : String(error);
}

/** An asset ID a character file accepts (a positive i64); a result may come without one. */
const usableAsset = (id: string) => /^[1-9][0-9]{0,18}$/.test(id);

function stop(report: ImageReport, status: string) {
  report.status = status;
  process.exitCode = 1;
}

async function generate(
  context: Context,
  human: Io,
  state: LocalState,
  options: ImageCommandOptions,
  target: string,
  report: ImageReport,
) {
  const { gateway } = context;
  say(human, `AI 生成角色图片（${describeEnvironment(context.env)}）`);
  const config = await loadImageConfig(gateway);
  if (!config.enabled) {
    warn(human, 'AI 生成角色图片暂未开放。没有发出生成请求，没有扣费。');
    report.refusal = { kind: 'unavailable', code: 'DISABLED' };
    return stop(report, 'refused');
  }
  const choice = chooseRequest(config, options);
  if (options.pick !== null && options.pick > choice.count)
    throw new UsageError(`--pick 不能大于张数 ${choice.count}`);
  report.request = {
    prompt: choice.prompt,
    model: choice.model.id,
    style: choice.style?.id ?? '',
    ratio: choice.ratio,
    count: choice.count,
  };
  say(
    human,
    `模型 ${choice.model.name}（${choice.model.id}）· 风格 ${choice.style ? choice.style.name : '不选'} · 比例 ${choice.ratio} · ${choice.count} 张`,
  );
  const reference = options.reference ? loadReference(options.reference) : null;
  const intent = intentOf(choice, reference?.sha256 ?? '');
  const pending = pendingRecords(state);
  const others = pending.filter((record) => record.intent !== intent);
  if (others.length)
    warn(
      human,
      `还有 ${others.length} 个结果未知的请求（${others.map((record) => record.requestId).join('、')}）：` +
        '可运行 yomi image --resume <请求 ID> 用原来的请求 ID 确认，避免重复生成；不要了就再加 --forget 放弃。',
    );
  // An accepted batch of this very request that has not settled yet is shown again, never paid
  // for again (the latest, should there be several), as the app keeps showing it.
  const ongoing = runningRecords(state)
    .filter((record) => record.intent === intent)
    .at(-1);
  if (ongoing) {
    await continueBatch(context, human, state, ongoing, options, target, report);
    return;
  }
  if (!config.version) {
    warn(human, '生图配置缺少版本号，无法冻结报价。没有发出生成请求。');
    return stop(report, 'refused');
  }
  const price = batchPrice(choice.model, choice.count);
  if (!price) {
    warn(human, `读不到模型 ${choice.model.id} 的价格，为避免扣费出错没有继续。`);
    return stop(report, 'refused');
  }
  const replay = pending.find((record) => record.intent === intent) ?? null;
  if (replay)
    warn(
      human,
      `上次同样的请求（${replay.requestId}）结果未知。这次用同一个请求 ID 重发：服务端已受理过就直接返回原来的批次，不会重复扣费。` +
        `（不想重发它：yomi image --resume ${replay.requestId} --forget）`,
    );
  const unit = replay?.unitPrice ?? price.unit;
  const total = replay?.total ?? price.total;
  report.unitPrice = unit;
  report.total = total;
  const notes: string[] = [];
  if (!replay && price.original !== null)
    notes.push(`原价 ${price.original} 钻石（划线价，仅展示）`);
  notes.push('按张扣费：生成失败或未通过内容检查的那张自动退款。');
  const agreed = await confirmSpend(human, gateway, {
    action: `生成 ${choice.count} 张角色图片`,
    total,
    unit: { price: unit, count: choice.count, label: '张' },
    acceptPrice: options.acceptPrice,
    notes,
    replay: Boolean(replay),
  });
  if (!agreed) {
    say(human, '没有发出生成请求，没有扣费。');
    return stop(report, 'cancelled');
  }
  const production = await confirmProduction(
    { ...context, io: human },
    `花 ${total} 钻石生成 ${choice.count} 张角色图片`,
    options.confirmProd,
  );
  if (!production) {
    say(human, '已取消，没有扣费。');
    return stop(report, 'cancelled');
  }
  let record = replay;
  if (!record) {
    let uploaded: { uploadId: string; sha256: string } | null = null;
    if (reference) {
      say(
        human,
        paint(human, 'dim', `上传并审核参考图（${reference.width}×${reference.height}）…`),
      );
      try {
        const receipt = await uploadReference(gateway, state, reference, context.fetch);
        uploaded = { uploadId: receipt.uploadId, sha256: reference.sha256 };
      } catch (error) {
        if (error instanceof UgcFailure && error.code === 'IMAGE_REJECTED') {
          warn(human, '参考图未通过审核，请换一张。没有发出生成请求，没有扣费。');
          report.refusal = { kind: 'rejected', code: 'REFERENCE_REJECTED' };
          return stop(report, 'refused');
        }
        throw error;
      }
    }
    const frozen = freezeRequest(state, choice, config.version, price.unit, uploaded);
    record = frozen.record;
    if (frozen.existing && record.batchId) {
      // Another yomi process sent this very request while this one waited for the yes.
      say(human, '同样的请求刚由另一个 yomi 进程提交并已受理：这里接着查看那一批，不会再扣费。');
      await continueBatch(context, human, state, record, options, target, report);
      return;
    }
    if (frozen.existing) {
      report.requestId = record.requestId;
      warn(
        human,
        `同样的请求刚由另一个 yomi 进程提交（请求 ID ${record.requestId}），结果还没回来：这里没有再发，没有扣费。` +
          `稍后运行 yomi image --resume ${record.requestId} 查看它。`,
      );
      return stop(report, 'unknown');
    }
  }
  report.replayed = Boolean(replay);
  await submitAndFollow(context, human, state, record, options, target, report);
}

async function resume(
  context: Context,
  human: Io,
  state: LocalState,
  options: ImageCommandOptions,
  target: string,
  report: ImageReport,
) {
  const id = options.resume.trim();
  const record = findRecord(state, id);
  if (record) {
    report.request = {
      prompt: record.prompt,
      model: record.modelId,
      style: record.styleId,
      ratio: record.ratio,
      count: record.count,
    };
    report.unitPrice = record.unitPrice;
    report.total = record.total;
    if (options.pick !== null && options.pick > record.count)
      throw new UsageError(`--pick 不能大于张数 ${record.count}`);
  }
  if (record && !record.batchId) {
    // The create's answer was lost: the same request again, same ID, same body.
    say(
      human,
      `重新确认结果未知的请求 ${record.requestId}（${record.count} 张 · ${record.modelId}，${describeEnvironment(context.env)}）`,
    );
    const agreed = await confirmSpend(human, context.gateway, {
      action: `重发同一请求：生成 ${record.count} 张角色图片`,
      total: record.total,
      unit: { price: record.unitPrice, count: record.count, label: '张' },
      acceptPrice: options.acceptPrice,
      notes: ['用的是原来的请求 ID 和请求内容：服务端已受理过就直接返回原来的批次，不会重复扣费。'],
      replay: true,
    });
    if (!agreed) {
      say(human, '没有重发，没有扣费。这个请求仍然记着，可以之后再 --resume。');
      return stop(report, 'cancelled');
    }
    const production = await confirmProduction(
      { ...context, io: human },
      `重发一个可能扣 ${record.total} 钻石的生图请求`,
      options.confirmProd,
    );
    if (!production) {
      say(human, '已取消，没有重发。');
      return stop(report, 'cancelled');
    }
    // Resent on purpose: a request let go earlier is followed again.
    const sent = record.forgottenAt ? (adoptRecord(state, record.key) ?? record) : record;
    if (record.forgottenAt)
      say(
        human,
        paint(human, 'dim', '这个请求之前已放弃；现在按原样重发，之后同样的命令也会接着用它。'),
      );
    report.replayed = true;
    await submitAndFollow(context, human, state, sent, options, target, report);
    return;
  }
  const batchId = record?.batchId || id;
  report.batchId = batchId;
  say(human, `继续查看批次 ${batchId}（只读取结果，不会扣费）`);
  if (record && recordStatus(record) === 'forgotten')
    say(human, paint(human, 'dim', '这一批之前已放弃跟踪；查看不会改变这一点。'));
  const first = await firstReading(context, human, batchId, record);
  await follow(context, human, state, batchId, record, options, target, report, first);
}

/**
 * An unchanged repeat of a request whose batch was accepted but has not settled: that batch is
 * shown again (followed, downloaded), never paid for again, as the app keeps showing it.
 */
async function continueBatch(
  context: Context,
  human: Io,
  state: LocalState,
  record: BatchRecord,
  options: ImageCommandOptions,
  target: string,
  report: ImageReport,
) {
  report.continued = true;
  report.requestId = record.requestId;
  report.batchId = record.batchId;
  report.unitPrice = record.unitPrice;
  report.total = record.total;
  say(
    human,
    paint(
      human,
      'yellow',
      `上次同样的请求已受理（批次 ${record.batchId}），还没有结束：继续查看这一批，不会再扣费。` +
        '这一批结束后，再运行同样的命令才会生成新的一批（重新扣费）。',
    ),
  );
  const first = await firstReading(context, human, record.batchId, record);
  await follow(context, human, state, record.batchId, record, options, target, report, first);
}

/**
 * The batch's first reading, outside the polling loop, so an unknown ID is an error, not five
 * minutes of retries. For a batch this machine still follows, says how to let it go.
 */
async function firstReading(
  context: Context,
  human: Io,
  batchId: string,
  record: BatchRecord | null,
): Promise<ImageBatch> {
  try {
    return await readBatch(context.gateway, batchId);
  } catch (error) {
    if (record && recordStatus(record) === 'running' && !(error instanceof NotSignedIn))
      warn(
        human,
        `读不到批次 ${batchId}（${errorCode(error)}）。它可能还在服务端进行，稍后再试；在它结束前，同样的命令只会继续查看它。` +
          `确定不再等它：运行 yomi image --resume ${batchId} --forget 放弃跟踪（之后同样的命令会生成新的一批并重新扣费）。`,
      );
    throw error;
  }
}

/**
 * `--resume <id> --forget`: lets an unknown request or a running batch go on purpose, on this
 * machine only (nothing is sent, nothing is cancelled or refunded). An unchanged repeat is then a
 * new paid request. The record stays, so `--resume` can still resend the request or show the batch.
 */
function forget(human: Io, state: LocalState, id: string, report: ImageReport) {
  const record = findRecord(state, id);
  if (!record)
    throw new UsageError(`本机没有 ${id} 的记录（--forget 只能放弃这台电脑记着的批次或请求）`);
  report.requestId = record.requestId;
  report.batchId = record.batchId || null;
  report.request = {
    prompt: record.prompt,
    model: record.modelId,
    style: record.styleId,
    ratio: record.ratio,
    count: record.count,
  };
  report.unitPrice = record.unitPrice;
  report.total = record.total;
  const status = recordStatus(record);
  const label = record.batchId ? `批次 ${record.batchId}` : `请求 ${record.requestId}`;
  if (status === 'settled') {
    say(human, `${label} 已经结束，不需要放弃：同样的命令会生成新的一批。`);
    report.status = 'done';
    return;
  }
  report.status = 'forgotten';
  if (status === 'forgotten') {
    say(human, `${label} 之前已经放弃，没有变化。`);
    return;
  }
  forgetRecord(state, record.key);
  if (status === 'running') {
    say(
      human,
      `已放弃跟踪批次 ${record.batchId}：同样的命令不会再继续查看它，而会生成新的一批（重新扣费）。`,
    );
    warn(
      human,
      '放弃跟踪不会取消服务端的生成，也不会退款：这一批已扣的钻石照常扣除，生成失败的那张仍会自动退款。',
    );
    say(human, `之后仍可运行 yomi image --resume ${record.batchId} 查看和下载这一批（不会扣费）。`);
    return;
  }
  say(human, `已放弃请求 ${record.requestId}：同样的命令不会再重发它，而会作为新请求重新扣费。`);
  warn(
    human,
    `注意：如果这个请求其实已经被服务端受理，它的扣费照常生效（最多 ${record.total} 钻石，生成失败的那张仍会自动退款），` +
      '只是本机没有它的批次 ID，看不到也下载不到那批结果。',
  );
  say(
    human,
    `改主意了可以运行 yomi image --resume ${record.requestId}：用原来的请求 ID 重发，已受理就拿回原来的批次，不会重复扣费。`,
  );
}

async function submitAndFollow(
  context: Context,
  human: Io,
  state: LocalState,
  record: BatchRecord,
  options: ImageCommandOptions,
  target: string,
  report: ImageReport,
) {
  report.requestId = record.requestId;
  say(human, paint(human, 'dim', `提交生成请求（请求 ID ${record.requestId}）…`));
  let batch: ImageBatch;
  try {
    batch = await submitBatch(context.gateway, state, record, { replay: report.replayed });
  } catch (error) {
    if (error instanceof ReplayRefused) {
      explainRefusal(human, error.refusal);
      warn(
        human,
        `被拒的只是这次重发。上次那次的结果一直未知，可能已经受理并扣了钻石（最多 ${record.total} 钻石），所以请求 ${record.requestId} 仍然记着：` +
          `之后运行 yomi image --resume ${record.requestId} 用同一个请求 ID 再确认，服务端按请求 ID 去重，最多扣一次；确定不要了就再加 --forget。`,
      );
      report.refusal = { kind: error.refusal.kind, code: error.refusal.code };
      return stop(report, 'unknown');
    }
    if (error instanceof GenRefusal) {
      explainRefusal(human, error);
      report.refusal = { kind: error.kind, code: error.code };
      return stop(report, 'refused');
    }
    if (error instanceof NotSignedIn) throw error;
    warn(
      human,
      `这次生成请求的结果未知（${errorCode(error)}）：可能已经受理并扣费，也可能没有。没有自动重发。`,
    );
    warn(
      human,
      `运行 yomi image --resume ${record.requestId} 会用同一个请求 ID 重新确认，不会重复扣费。`,
    );
    warn(
      human,
      `同样的命令也会这样重发它；不想要这个请求了，运行 yomi image --resume ${record.requestId} --forget 放弃（如果其实已经受理，扣费照常生效）。`,
    );
    return stop(report, 'unknown');
  }
  report.batchId = batch.id;
  say(
    human,
    `已受理，批次 ${batch.id}。生成在服务端进行，中途退出不会取消；之后可运行 yomi image --resume ${batch.id} 继续查看（不会再扣费）。`,
  );
  await follow(context, human, state, batch.id, record, options, target, report, batch);
}

/** Waits `ms`, or less once `signal` aborts (Ctrl-C stops watching at once). */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Follows a batch to its end (2.5 s × 120 at most, or until Ctrl-C), then downloads every
 * succeeded output from a freshly read address, prints each output's outcome and charge, and
 * writes the picked one into the character file. A batch that reached the stop rule is marked
 * settled, so an unchanged repeat may start a new paid batch; until then it shows this one again.
 */
async function follow(
  context: Context,
  human: Io,
  state: LocalState,
  batchId: string,
  record: BatchRecord | null,
  options: ImageCommandOptions,
  target: string,
  report: ImageReport,
  first: ImageBatch,
) {
  const { gateway } = context;
  const unit = record?.unitPrice ?? null;
  let shown = '';
  const show = (batch: ImageBatch) => {
    const line = progressLine(batch);
    if (line !== shown) say(human, paint(human, 'dim', line));
    shown = line;
  };
  let batch = first;
  let done = pollingComplete(first);
  let stopped = false;
  if (!done) {
    // Ctrl-C stops watching; the server goes on generating, charging and refunding.
    const watching = new AbortController();
    const onSignal = () => watching.abort();
    process.once('SIGINT', onSignal);
    try {
      show(first);
      const polled = await pollUntil(() => readBatch(gateway, batchId), {
        intervalMs: POLL_INTERVAL_MS,
        maxRounds: POLL_ROUNDS,
        done: pollingComplete,
        onTick: show,
        onError: (error) => warn(human, `查询进度失败（${errorCode(error)}），继续查询…`),
        signal: watching.signal,
        sleep: (ms) => pause(ms, watching.signal),
      });
      batch = polled.value ?? batch;
      done = polled.done;
    } finally {
      process.removeListener('SIGINT', onSignal);
    }
    stopped = watching.signal.aborted;
  }
  if (stopped) say(human, '已停止查看。');
  if (done && record) markSettled(state, record.key);
  if (!done) {
    warn(
      human,
      `还没有全部完成。停止查看不会取消服务端的生成，也不影响退款；稍后运行 yomi image --resume ${batchId} 继续查看（不会再扣费）。`,
    );
    const tracked = record ? findRecord(state, record.key) : null;
    if (tracked && recordStatus(tracked) === 'running')
      warn(
        human,
        '在这一批结束前，同样的命令只会继续查看它，不会重新生成。' +
          `如果它一直不结束、确定不再等：运行 yomi image --resume ${batchId} --forget 放弃跟踪。`,
      );
  }

  // Results: addresses are read again right before downloading (they may expire).
  const saved = new Map<number, SavedImage>();
  const problems = new Map<number, string>();
  if (batch.outputs.some((output) => outcomeOf(output) === 'succeeded')) {
    try {
      batch = await readBatch(gateway, batchId);
    } catch (error) {
      warn(human, `重新读取结果地址失败（${errorCode(error)}），先用刚才的结果。`);
    }
    const dir = mediaDir(options.out);
    for (const listed of batch.outputs) {
      if (outcomeOf(listed) !== 'succeeded') continue;
      let output = listed;
      if (expiresSoon(output)) {
        try {
          batch = await readBatch(gateway, batchId);
          output = batch.outputs[listed.index - 1] ?? listed;
        } catch {
          // Try the address we have.
        }
      }
      if (!output.url) {
        problems.set(output.index, '服务端没有给出可下载的地址');
        continue;
      }
      try {
        saved.set(output.index, await saveOutput(dir, batchId, output, context.fetch));
      } catch (error) {
        problems.set(output.index, error instanceof Error ? error.message : String(error));
      }
    }
  }

  say(human);
  for (const output of batch.outputs) {
    const outcome = outcomeOf(output);
    const line = describeOutput(output, unit);
    say(
      human,
      outcome === 'succeeded'
        ? paint(human, 'green', line)
        : outcome === 'failed' || outcome === 'rejected'
          ? paint(human, 'red', line)
          : line,
    );
    const files = saved.get(output.index);
    if (files) {
      say(human, `    原图     ${files.original}`);
      if (files.cover) {
        say(human, `    封面 1:2 ${files.cover}`);
        say(human, `    头像 1:1 ${files.avatar}`);
      } else {
        say(
          human,
          paint(human, 'yellow', `    本机不能裁剪这张原图（${files.note}），只保留了原图。`),
        );
        if (usableAsset(output.assetId))
          say(
            human,
            `    角色文件里可以直接引用这次的生成结果（未裁剪）：cover: { asset_id: "${output.assetId}" }`,
          );
      }
    }
    const problem = problems.get(output.index);
    if (problem)
      warn(human, `    下载失败：${problem}。可运行 yomi image --resume ${batchId} 重新下载。`);
  }
  const totals = billingTotals(batch, unit);
  if (unit !== null) {
    const parts = [`共扣 ${totals.charged} 钻石`];
    if (totals.refunded) parts.push(`已退回 ${totals.refunded} 钻石`);
    if (totals.refunding) parts.push(`退款中 ${totals.refunding} 钻石`);
    if (totals.pending) parts.push(`扣费确认中 ${totals.pending} 钻石`);
    say(human, parts.join('，') + '。');
  } else {
    const { pictures } = totals;
    say(
      human,
      `已扣费 ${pictures.charged} 张，已退款 ${pictures.refunded} 张${pictures.refunding ? `，退款中 ${pictures.refunding} 张` : ''}。`,
    );
  }
  const unsettled = batch.outputs.some((output) => {
    const outcome = outcomeOf(output);
    return outcome === 'interrupted' || outcome === 'working';
  });
  if (done && unsettled)
    warn(
      human,
      `有的图片还在确认结果；稍后运行 yomi image --resume ${batchId} 再查看（不会再扣费）。`,
    );

  let pickFailed = false;
  if (options.pick !== null && target) {
    const output = batch.outputs[options.pick - 1];
    const files = saved.get(options.pick);
    if (
      !output ||
      outcomeOf(output) !== 'succeeded' ||
      !files ||
      (!files.cover && !usableAsset(output.assetId))
    ) {
      warn(human, `第 ${options.pick} 张没有可用的结果，没有写入 ${options.into}。`);
      pickFailed = true;
    } else {
      const asset: CharacterImage = { assetId: output.assetId };
      const images: { cover?: CharacterImage; avatar?: CharacterImage } = {};
      if (options.as !== 'avatar') images.cover = files.cover ? { path: files.cover } : asset;
      if (options.as !== 'cover') images.avatar = files.avatar ? { path: files.avatar } : asset;
      const values = writeCharacterImages(target, images);
      report.picked = { index: options.pick, file: target, values };
      say(
        human,
        paint(
          human,
          'green',
          `✓ 已把第 ${options.pick} 张写进 ${options.into}：${Object.entries(values)
            .map(([key, value]) => `${key}: ${value}`)
            .join('，')}`,
        ),
      );
      if (!files.cover)
        warn(
          human,
          '这张没有裁剪成 1:2 / 1:1，写入的是生成结果本身的引用；如果创建时不被接受，请自己裁好原图后改成文件路径。',
        );
    }
  }

  report.batchId = batchId;
  report.charged = totals.charged;
  report.refunded = totals.refunded;
  report.refunding = totals.refunding;
  report.outputs = batch.outputs.map((output) => {
    const files = saved.get(output.index);
    return {
      index: output.index,
      taskId: output.taskId,
      assetId: output.assetId,
      result: outcomeOf(output),
      billing: output.billing || null,
      failure: output.failure
        ? { code: output.failure.code, message: output.failure.message }
        : null,
      files: files
        ? { original: files.original, cover: files.cover || null, avatar: files.avatar || null }
        : null,
      error: problems.get(output.index) ?? null,
    };
  });
  const succeeded = batch.outputs.filter((output) => outcomeOf(output) === 'succeeded').length;
  report.status = done && !unsettled ? 'done' : 'incomplete';
  if (report.status !== 'done' || !succeeded || problems.size || pickFailed) process.exitCode = 1;
}
