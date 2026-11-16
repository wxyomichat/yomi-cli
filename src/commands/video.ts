import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { NotSignedIn } from '../core/api.js';
import { describeEnvironment } from '../core/env.js';
import type { LocalState } from '../core/state.js';
import { type Io, paint, say, warn } from '../core/ui.js';
import {
  confirmSpend,
  explainRefusal,
  type GenRefusal,
  mediaDir,
  readBalance,
} from '../gen/common.js';
import { prepare, RasterError } from '../gen/raster.js';
import {
  addVideoResult,
  createRefusal,
  createVideo,
  displayPrice,
  dropVideoRequest,
  findTemplate,
  listVideoTasks,
  loadVideoConfig,
  newVideoRequestId,
  parseVideoUse,
  PROMPT_MAX,
  quoteUsable,
  quoteVideo,
  readTask,
  saveVideoPreview,
  saveVideoRequest,
  taskOfFailure,
  uploadFrame,
  type VideoConfig,
  type VideoInput,
  type VideoQuote,
  videoRequest,
  type VideoRequestRecord,
  videoRequests,
  videoResults,
  videosBoundTo,
  type VideoTask,
  type VideoTemplate,
  type VideoUse,
  VIDEO_USE_LABEL,
  watchTask,
} from '../gen/ugcVideo.js';
import { UgcFailure } from '../ugc/api.js';
import { type CharacterSpec, SpecError } from '../ugc/spec.js';
import { type Context, localState, requireSignIn } from './context.js';
import { confirmProduction } from './declaration.js';

/** `yomi video`: AI video for a character (dynamic cover or intro video). */
export type VideoCommandOptions = {
  template: string;
  prompt: string;
  duration: number | null;
  frame: string;
  as: string;
  out: string;
  list: boolean;
  resume: string;
  listOptions: boolean;
  acceptPrice: boolean;
  confirmProd: boolean;
  json: boolean;
};

/** What `--json` prints: one object with the outcome. */
type Outcome = {
  ok: boolean;
  /**
   * `succeeded` / `failed` / `rejected` (content checks) / `running` (still going when watching
   * stopped) / `unknown` (the create's answer was lost, or the request was not found: either
   * way it may have been charged) / `refused` (nothing charged) /
   * `cancelled` (not confirmed, nothing sent).
   */
  outcome: 'succeeded' | 'failed' | 'rejected' | 'running' | 'unknown' | 'refused' | 'cancelled';
  request_id: string;
  task_id: string;
  draft_id: string;
  use: VideoUse;
  quoted_diamonds: number | null;
  charged_diamonds: number;
  status: string;
  billing_status: string;
  /**
   * `refunded` only when the refund is done; `refunding` while it is in progress; `not_started`
   * for a failed task that was charged and whose refund has not begun.
   */
  refund: 'refunded' | 'refunding' | 'not_started' | '';
  error_code: string;
  result_asset_id: string;
  files: string[];
  /** The command that picks this request up again, '' when there is nothing to pick up. */
  resume: string;
};

/** Codes a content check gives (the app recognizes all three). */
const CONTENT_CODES = new Set(['CONTENT_REJECTED', 'content_blocked', 'REJECTED']);

type Run = {
  context: Context;
  /** Where the person's text goes: stdout, or stderr with `--json` (stdout is the JSON). */
  io: Io;
  /** The real terminal: `--json` prints its one object here. */
  out: Io;
  state: LocalState;
  spec: CharacterSpec;
  options: VideoCommandOptions;
  /** The local draft of the character file (`draft_` + 32 hex). */
  draftId: string;
};

/**
 * `yomi video -f <file>`: generates a video for the character file, as the app's video page does,
 * shows the quoted price and the balance and asks before the one call that charges, watches the
 * task, downloads the preview and keeps the result for `yomi create` (not a preview). `--options`
 * shows the configuration, `--list` the file's tasks, `--resume <id>` picks up a saved request.
 */
export async function video(
  context: Context,
  spec: CharacterSpec | null,
  options: VideoCommandOptions,
): Promise<void> {
  requireSignIn(context);
  const io: Io = options.json ? { ...context.io, stdout: context.io.stderr } : context.io;
  const quiet = { ...context, io };
  if (options.listOptions) {
    await showOptions(quiet, options.json ? context.io : null);
    return;
  }
  if (!spec || !spec.source)
    throw new SpecError(['yomi video 需要角色文件：-f character.yaml（结果按这个文件记下）']);
  const state = localState(context);
  const run: Run = {
    context: quiet,
    io,
    out: context.io,
    state,
    spec,
    options,
    draftId: state.draft(spec.source).draftId,
  };
  if (options.list) {
    await list(run);
    return;
  }
  let outcome: Outcome | null;
  try {
    outcome = options.resume ? await resume(run, options.resume.trim()) : await generate(run);
  } catch (error) {
    if (options.json)
      printJson(context.io, {
        ok: false,
        outcome: 'error',
        error_code: error instanceof UgcFailure ? error.code : '',
        message: error instanceof Error ? error.message : String(error),
      });
    throw error;
  }
  if (!outcome) return;
  if (!outcome.ok) process.exitCode = 1;
  if (options.json) printJson(context.io, outcome);
}

function printJson(io: Io, value: unknown) {
  io.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

const dim = (io: Io, text: string) => say(io, paint(io, 'dim', text));

/** A path as one shell word (quoted when it has anything a shell would split or expand). */
function shellWord(value: string): string {
  return /^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that picks a request up again. */
function resumeCommand(source: string, requestId: string) {
  return `yomi video -f ${shellWord(source)} --resume ${requestId}`;
}

function outcomeOf(
  target: Target,
  task: VideoTask | null,
  outcome: Outcome['outcome'],
  extra: Partial<Outcome> = {},
): Outcome {
  const refund =
    task?.billing === 'REFUNDED'
      ? 'refunded'
      : task &&
          (task.billing === 'REFUNDING' || (task.status === 'FAILED' && task.billing === 'CHARGED'))
        ? task.billing === 'REFUNDING'
          ? 'refunding'
          : 'not_started'
        : '';
  return {
    ok: outcome === 'succeeded' || outcome === 'running',
    outcome,
    request_id: target.requestId,
    task_id: task?.taskId ?? '',
    draft_id: target.draftId,
    use: target.use,
    quoted_diamonds: target.amount,
    charged_diamonds: task?.charged ?? 0,
    status: task?.status ?? '',
    billing_status: task?.billing ?? '',
    refund,
    error_code: task?.errorCode ?? '',
    result_asset_id: task?.resultAssetId ?? '',
    files: [],
    resume: '',
    ...extra,
  };
}

/** A refusal of a video call explained (nothing was charged). */
function explainVideoRefusal(io: Io, refusal: GenRefusal) {
  if (refusal.code === 'QUOTE_EXPIRED' || refusal.code === 'CONFIG_CHANGED')
    warn(io, `价格或选项已经变了（${refusal.code}）。重新运行会重新报价。这次没有扣费。`);
  else if (CONTENT_CODES.has(refusal.code))
    warn(io, `内容没有通过检查（${refusal.code}），请修改描述或换一张首帧。这次没有扣费。`);
  else if (refusal.code === 'CONCURRENCY_LIMIT')
    warn(io, '同时生成的视频太多了，等一条完成后再试。这次没有扣费。');
  else explainRefusal(io, refusal);
}

// ---------------------------------------------------------------------------------------------
// --options

async function showOptions(context: Context, json: Io | null) {
  const { io } = context;
  const config = await loadVideoConfig(context.gateway);
  const prices = (map: Map<number, number> | null) =>
    map
      ? [...map].map(([seconds, amount]) => ({ duration_seconds: seconds, diamonds: amount }))
      : null;
  if (json) {
    printJson(json, {
      config_version: config.configVersion,
      custom_version: config.customVersion,
      max_concurrent_tasks: config.maxConcurrentTasks,
      custom: {
        durations: config.customDurations,
        default_duration: config.customDefaultDuration,
        display_prices: prices(config.customPrices),
      },
      templates: config.templates.map((template) => ({
        template_id: template.id,
        version: template.version,
        name: template.name,
        description: template.description,
        durations: template.durations,
        default_duration: template.defaultDuration,
        display_prices: prices(template.prices),
      })),
    });
    return;
  }
  const priceText = (map: Map<number, number> | null, durations: number[]) =>
    map
      ? durations.map((seconds) => `${seconds} 秒 ${map.get(seconds) ?? '?'} 钻石`).join(' · ')
      : '未公布（以报价为准）';
  say(io, `AI 视频配置（${describeEnvironment(context.env)}）`);
  dim(io, `配置版本 ${config.configVersion}，同时进行的任务最多 ${config.maxConcurrentTasks} 个`);
  say(io);
  say(io, '自定义（--prompt 描述，可不写）');
  say(
    io,
    `  时长 ${config.customDurations.join(' / ')} 秒（默认 ${config.customDefaultDuration}）`,
  );
  say(io, `  展示价：${priceText(config.customPrices, config.customDurations)}`);
  say(io);
  say(io, config.templates.length ? '模板（--template ID）' : '暂无模板。');
  for (const template of config.templates) {
    say(io, `  ${template.id}  ${template.name}`);
    say(
      io,
      `    时长 ${template.durations.join(' / ')} 秒（默认 ${template.defaultDuration}）　展示价：${priceText(template.prices, template.durations)}`,
    );
    if (template.description.trim())
      dim(io, `    ${template.description.trim().replace(/\s*\n\s*/g, ' ')}`);
  }
  say(io);
  dim(io, '展示价仅供参考：生成前会先报价，按报价扣费。');
}

// ---------------------------------------------------------------------------------------------
// --list

async function list(run: Run) {
  const { io, state, draftId, spec } = run;
  const { tasks } = await listVideoTasks(run.context.gateway, draftId, 50);
  const local = videoRequests(state, draftId);
  const results = videoResults(state, draftId);
  const useOf = (requestId: string) =>
    local.find((record) => record.request.request_id === requestId)?.use ?? null;
  const listed = new Set(tasks.map((task) => task.requestId));
  const unconfirmed = local
    .filter((record) => record.state === 'sent' && !listed.has(record.request.request_id))
    .map((record) => record.request.request_id);
  if (run.options.json) {
    printJson(run.out, {
      draft_id: draftId,
      tasks: tasks.map((task) => ({
        request_id: task.requestId,
        task_id: task.taskId,
        status: task.status,
        billing_status: task.billing,
        charged_diamonds: task.charged,
        result_asset_id: task.resultAssetId,
        error_code: task.errorCode,
        created_at_ms: task.createdAtMs,
        use: useOf(task.requestId),
      })),
      unconfirmed,
      results: {
        dynamic_cover: results?.dynamicCover ?? [],
        intro_video: results?.introVideo ?? [],
      },
    });
    return;
  }
  say(io, `角色文件 ${basename(spec.source)} 的 AI 视频（草稿 ${draftId}）`);
  if (!tasks.length && !unconfirmed.length) {
    say(io, '还没有生成过视频。');
    return;
  }
  for (const task of tasks) {
    const use = useOf(task.requestId);
    const parts = [
      task.requestId,
      statusText(task),
      billingText(task),
      use ? VIDEO_USE_LABEL[use] : '',
      task.createdAtMs ? new Date(task.createdAtMs).toLocaleString('zh-CN') : '',
    ].filter(Boolean);
    say(io, `  ${parts.join('　')}`);
  }
  for (const requestId of unconfirmed)
    say(io, `  ${requestId}　结果未知（本机保存的请求，服务端还没有确认）`);
  const kept = [
    results?.dynamicCover.length ? `动态封面 ${results.dynamicCover.length} 条` : '',
    results?.introVideo.length ? `介绍视频 ${results.introVideo.length} 条` : '',
  ].filter(Boolean);
  say(io);
  if (kept.length)
    dim(
      io,
      results?.boundTo
        ? `已随角色 ${results.boundTo} 提交：${kept.join('、')}。`
        : `已记下：${kept.join('、')}；yomi create 这个文件时一起提交（选用最新一条，试聊不带视频）。`,
    );
  dim(io, `查看或继续某个任务：${resumeCommand(spec.source, '<请求ID>')}`);
}

function statusText(task: VideoTask): string {
  switch (task.status) {
    case 'ACCEPTED':
      return '已受理';
    case 'QUEUED':
      return '排队中';
    case 'RUNNING':
      return task.progress === null ? '生成中' : `生成中 ${task.progress}%`;
    case 'REVIEWING':
      return '内容检查中';
    case 'SUCCEEDED':
      return '已生成';
    default:
      return CONTENT_CODES.has(task.errorCode)
        ? '未通过内容检查'
        : `失败${task.errorCode ? `（${task.errorCode}）` : ''}`;
  }
}

function billingText(task: VideoTask): string {
  switch (task.billing) {
    case 'PENDING':
      return '扣费确认中';
    case 'FREE':
      return '免费';
    case 'CHARGED':
      return `已扣 ${task.charged} 钻石`;
    case 'REFUNDING':
      return '退款中（还没有到账）';
    case 'REFUNDED':
      return '已退款';
    default:
      return '没有扣费';
  }
}

// ---------------------------------------------------------------------------------------------
// Generating

function frameSource(run: Run): string {
  if (run.options.frame) return resolve(run.options.frame);
  const cover = run.spec.cover;
  if (cover?.kind === 'file') return cover.path;
  throw new SpecError([
    '角色文件的 cover 不是本地图片：用 --frame 指定首帧图片（JPEG/PNG，会裁成 9:16）',
  ]);
}

function chooseTemplate(run: Run, config: VideoConfig): VideoTemplate | null {
  const { template: wanted, prompt } = run.options;
  if (!wanted) return null;
  if (prompt)
    throw new Error('用模板时不能写 --prompt：模板的描述是固定的（自定义视频不写 --template）');
  const template = findTemplate(config, wanted);
  if (!template)
    throw new Error(
      `没有模板 ${wanted}。可选：${config.templates.map((item) => item.id).join('、') || '（无）'}（yomi video --options 查看）`,
    );
  return template;
}

/** The first-frame file: a regular file of at most 20 MB (checked before it is read). */
function readFrame(path: string): Buffer {
  const stat = statSync(path);
  if (!stat.isFile()) throw new SpecError([`首帧图片 ${path} 不是普通文件`]);
  if (stat.size > MAX_FRAME_BYTES) throw new SpecError([`首帧图片 ${path} 太大（最多 20 MB）`]);
  return readFileSync(path);
}

/** As for the other reference pictures. */
const MAX_FRAME_BYTES = 20 * 1024 * 1024;

async function generate(run: Run): Promise<Outcome | null> {
  const { io, context, spec, options, draftId, state } = run;
  const { gateway } = context;
  // Videos already submitted with a character cannot go with another: refuse before any spend.
  const bound = videosBoundTo(state, draftId);
  if (bound)
    throw new SpecError([
      `这个角色文件的 AI 视频已随角色 ${bound} 提交，新视频不能再绑定到它，也不能带给另一个角色。` +
        '要给新角色做视频，把文件复制成新的角色文件（新的本机草稿）再运行 yomi video。',
    ]);
  const use = parseVideoUse(options.as);
  const prompt = options.prompt;
  if ([...prompt].length > PROMPT_MAX)
    throw new Error(`--prompt 最多 ${PROMPT_MAX} 个字符（现在 ${[...prompt].length}）`);
  say(
    io,
    `为角色「${spec.name || basename(spec.source)}」生成 AI 视频，用作${VIDEO_USE_LABEL[use]}（${describeEnvironment(context.env)}）`,
  );
  const config = await loadVideoConfig(gateway);
  const template = chooseTemplate(run, config);
  const durations = template ? template.durations : config.customDurations;
  const seconds =
    options.duration ?? (template ? template.defaultDuration : config.customDefaultDuration);
  if (!durations.includes(seconds))
    throw new Error(`--duration 只能是 ${durations.join(' / ')} 秒`);
  const shown = displayPrice(config, template, seconds);
  say(
    io,
    template
      ? `模板：${template.name}（${template.id}），${seconds} 秒`
      : `自定义：${seconds} 秒${prompt ? `，描述「${prompt}」` : '，不写描述'}`,
  );

  // The frame is prepared here first: a picture that cannot be used stops before any request.
  const framePath = frameSource(run);
  let jpeg: Buffer;
  try {
    jpeg = prepare(readFrame(framePath), 'videoFrame');
  } catch (error) {
    if (error instanceof RasterError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new SpecError([
        `首帧图片 ${framePath} 用不了：${error instanceof RasterError ? error.message : '文件不存在'}`,
      ]);
    throw error;
  }
  dim(io, `首帧：${basename(framePath)}（居中裁成 9:16，720×1280 JPEG）`);

  const target: Target = { requestId: '', draftId, source: spec.source, use, amount: shown };
  // A request of this file whose answer was lost may already be charged: running the command
  // again must not quietly become a second paid request. Unattended runs settle it first.
  const unconfirmed = videoRequests(run.state, draftId).filter((record) => record.state === 'sent');
  if (unconfirmed.length) {
    warn(io, `这个角色文件还有 ${unconfirmed.length} 个结果未知的视频请求，可能已经受理并扣费：`);
    for (const record of unconfirmed)
      warn(io, `  ${resumeCommand(record.source, record.request.request_id)}`);
    if (!io.interactive) {
      warn(
        io,
        '先用上面的命令确认（同一个请求 ID，不会重复扣费），再生成新的视频。没有上传首帧，也没有报价。',
      );
      return outcomeOf(target, null, 'cancelled', {
        error_code: 'UNCONFIRMED_REQUEST',
        resume: resumeCommand(spec.source, unconfirmed[0].request.request_id),
      });
    }
    warn(io, '继续的话是一条新的请求，会另外扣费，需要输入 yes 确认。');
  }

  // The balance against the display price: a video that cannot be paid uploads nothing.
  const balance = await readBalance(gateway);
  if (balance === null) {
    warn(io, '暂时读不到钻石余额，为避免扣费出错没有继续（没有上传首帧，也没有报价）。');
    return outcomeOf(target, null, 'refused', { error_code: 'WALLET_UNAVAILABLE' });
  }
  say(
    io,
    `${shown === null ? '展示价未公布（以报价为准）' : `展示价 ${shown} 钻石`}，当前余额 ${balance} 钻石。`,
  );
  if (shown !== null && balance < shown) {
    warn(
      io,
      `钻石不足（还差 ${shown - balance}），请先在 Yomi App 或网页充值。没有上传首帧，也没有报价。`,
    );
    return outcomeOf(target, null, 'refused', { error_code: 'INSUFFICIENT_BALANCE' });
  }
  if (
    !(await confirmProduction(context, '上传首帧并生成 AI 视频（会扣钻石）', options.confirmProd))
  )
    return outcomeOf(target, null, 'cancelled');

  dim(io, '上传首帧…');
  let frameAssetId: string;
  try {
    frameAssetId = await uploadFrame(gateway, draftId, jpeg, context.fetch);
  } catch (error) {
    if (error instanceof UgcFailure && CONTENT_CODES.has(error.code)) {
      warn(io, `首帧图片没有通过内容检查（${error.code}），请换一张（--frame）。没有扣费。`);
      return outcomeOf(target, null, 'rejected', { error_code: error.code });
    }
    throw error;
  }
  const input: VideoInput = {
    first_frame_asset_id: frameAssetId,
    template_id: template ? template.id : '',
    template_version: template ? template.version : config.customVersion,
    custom_prompt: template ? '' : prompt,
    duration_seconds: seconds,
    config_version: config.configVersion,
  };

  // The quote is the price; agreeing to it is the person's yes (the app's Generate button).
  const quoted = await quoteOrExplain(run, input, target);
  if ('outcome' in quoted) return quoted;
  let quote: VideoQuote = quoted;
  target.amount = quote.amount;
  const action = `生成 1 条 ${seconds} 秒的 AI 视频（${VIDEO_USE_LABEL[use]}）`;
  const notes = ['生成失败或没有通过内容检查会自动退款。'];
  if (shown !== null && quote.amount !== shown) {
    warn(io, `报价 ${quote.amount} 钻石，和展示价 ${shown} 钻石不同。`);
    if (!io.interactive) {
      warn(
        io,
        '价格和展示的不同，需要在终端里重新确认（--accept-price 只同意展示的价格）。没有扣费，也没有创建任务。',
      );
      return outcomeOf(target, null, 'cancelled');
    }
  }
  const agreed = await confirmSpend(io, gateway, {
    action,
    total: quote.amount,
    acceptPrice:
      options.acceptPrice && !unconfirmed.length && (shown === null || quote.amount === shown),
    notes,
  });
  if (!agreed) {
    say(io, '没有扣费，也没有创建任务。');
    return outcomeOf(target, null, 'cancelled');
  }
  // A quote that ran out while the person decided is quoted again; a new price is asked again.
  for (let round = 0; !quoteUsable(quote); round++) {
    if (round === 2) {
      warn(io, '报价一直在过期，没有创建任务，也没有扣费。请稍后重新运行。');
      return outcomeOf(target, null, 'cancelled');
    }
    dim(io, '报价已过期，重新报价…');
    const again = await quoteOrExplain(run, input, target);
    if ('outcome' in again) return again;
    if (again.amount !== quote.amount) {
      warn(io, `价格变了：刚才 ${quote.amount} 钻石，现在 ${again.amount} 钻石。`);
      if (!io.interactive) {
        warn(io, '新价格需要重新确认：没有扣费，也没有创建任务，请重新运行。');
        return outcomeOf({ ...target, amount: again.amount }, null, 'cancelled');
      }
      const yes = await confirmSpend(io, gateway, {
        action,
        total: again.amount,
        acceptPrice: false,
        notes,
      });
      if (!yes) {
        say(io, '没有扣费，也没有创建任务。');
        return outcomeOf({ ...target, amount: again.amount }, null, 'cancelled');
      }
    }
    quote = again;
    target.amount = quote.amount;
  }

  // Saved before the paying call: an unknown answer is resumed with this very request.
  const record: VideoRequestRecord = {
    request: {
      request_id: newVideoRequestId(),
      draft_id: draftId,
      input: quote.input,
      quote_id: quote.quoteId,
    },
    source: spec.source,
    use,
    amount: quote.amount,
    state: 'sent',
    task: null,
    at: Date.now(),
  };
  saveVideoRequest(run.state, record);
  return submit(run, record);
}

/** A quote, or the outcome of a refused one (a quote never charges). */
async function quoteOrExplain(
  run: Run,
  input: VideoInput,
  target: Target,
): Promise<VideoQuote | Outcome> {
  dim(run.io, '获取报价…');
  try {
    return await quoteVideo(run.context.gateway, run.draftId, input);
  } catch (error) {
    if (!(error instanceof UgcFailure) || error.code === 'PROTOCOL' || error.code === 'NETWORK')
      throw error;
    const refusal = createRefusal(error);
    if (!refusal) throw error;
    explainVideoRefusal(run.io, refusal);
    return outcomeOf(target, null, CONTENT_CODES.has(error.code) ? 'rejected' : 'refused', {
      error_code: error.code,
    });
  }
}

/** What a request is about, whether or not this machine saved it. */
type Target = {
  requestId: string;
  draftId: string;
  /** The character file the result is kept for. */
  source: string;
  use: VideoUse;
  amount: number | null;
};

function targetOf(record: VideoRequestRecord): Target {
  return {
    requestId: record.request.request_id,
    draftId: record.request.draft_id,
    source: record.source,
    use: record.use,
    amount: record.amount,
  };
}

function codeOf(error: unknown): string {
  if (error instanceof UgcFailure) return error.code;
  return error instanceof Error ? error.message : '';
}

/** Sends the saved request (`ugc/video/create`), then watches what it became. */
async function submit(run: Run, record: VideoRequestRecord): Promise<Outcome> {
  const { io, state } = run;
  const target = targetOf(record);
  const again = resumeCommand(target.source, target.requestId);
  let task: VideoTask;
  try {
    task = await createVideo(run.context.gateway, record.request);
  } catch (error) {
    const accepted = taskOfFailure(error);
    if (!accepted) {
      const refusal = createRefusal(error);
      if (refusal) {
        dropVideoRequest(state, target.requestId);
        explainVideoRefusal(io, refusal);
        return outcomeOf(target, null, CONTENT_CODES.has(refusal.code) ? 'rejected' : 'refused', {
          error_code: refusal.code,
        });
      }
      const code = codeOf(error);
      warn(
        io,
        `创建请求的结果未知${code ? `（${code}）` : ''}：可能已经受理并扣费，也可能没有。CLI 不会自动重发，这个请求已保存在本机。`,
      );
      say(io, `确认结果或重试同一个请求（同一个请求 ID，不会重复扣费）：${again}`);
      if (error instanceof NotSignedIn) throw error;
      return outcomeOf(target, null, 'unknown', { error_code: code, resume: again });
    }
    task = accepted;
  }
  saveVideoRequest(state, { ...record, state: 'accepted', task });
  say(io, `已提交：请求 ${target.requestId}（任务 ${task.taskId}）。`);
  dim(io, `停止查看（Ctrl+C）不会取消任务，也不会退款；之后用 ${again} 继续查看。`);
  return follow(run, target, record, task);
}

// ---------------------------------------------------------------------------------------------
// Watching and results

/** Watches the task until it settles (or the rounds run out) and reports each outcome. */
async function follow(
  run: Run,
  target: Target,
  record: VideoRequestRecord | null,
  initial: VideoTask | null,
): Promise<Outcome> {
  const { io, state, context } = run;
  const again = resumeCommand(target.source, target.requestId);
  let shown = '';
  const tick = (task: VideoTask) => {
    const line = `${statusText(task)}　${billingText(task)}`;
    if (line !== shown) dim(io, line);
    shown = line;
  };
  if (initial) tick(initial);
  const watched = await watchTask(context.gateway, target.requestId, target.draftId, initial, {
    onTick: tick,
    onError: (error) => warn(io, `查询任务暂时失败（${codeOf(error)}），继续查询…`),
  });
  const task = watched.task;
  if (task && record) saveVideoRequest(state, { ...record, state: 'accepted', task });
  if (!task || !watched.settled) {
    say(
      io,
      `还没有结束${task ? `（${statusText(task)}，${billingText(task)}）` : ''}。停止查看不会取消服务端的任务，也不会退款。`,
    );
    say(io, `稍后继续查看：${again}`);
    return outcomeOf(target, task, 'running', { resume: again });
  }
  if (task.status === 'SUCCEEDED') return succeeded(run, target, task);
  const rejected = CONTENT_CODES.has(task.errorCode);
  warn(
    io,
    rejected
      ? `✗ 视频没有通过内容检查（${task.errorCode}）。`
      : `✗ 生成失败${task.errorCode ? `（${task.errorCode}）` : ''}。`,
  );
  if (task.billing === 'REFUNDED')
    say(io, `钻石已退回${task.charged ? `（${task.charged} 钻石）` : ''}。`);
  else if (task.billing === 'FREE') say(io, '这条是免费的，没有扣费。');
  else say(io, '没有扣费。');
  return outcomeOf(target, task, rejected ? 'rejected' : 'failed');
}

async function succeeded(run: Run, target: Target, task: VideoTask): Promise<Outcome> {
  const { io, state, context, options } = run;
  say(
    io,
    paint(
      io,
      'green',
      `✓ 视频已生成（${task.billing === 'FREE' ? '免费' : `扣除 ${task.charged} 钻石`}），结果 ${task.resultAssetId}`,
    ),
  );
  addVideoResult(state, target.draftId, target.source, target.use, task.resultAssetId);
  say(
    io,
    `已记为${VIDEO_USE_LABEL[target.use]}：之后 yomi create -f ${basename(target.source)} 会一起提交（选用最新一条；yomi preview 试聊不带视频）。`,
  );
  try {
    const path = await saveVideoPreview(
      context.gateway,
      task.resultAssetId,
      mediaDir(options.out),
      `video-${target.requestId}`,
      context.fetch,
    );
    say(io, `已保存预览：${path}`);
    return outcomeOf(target, task, 'succeeded', { files: [path] });
  } catch (error) {
    if (error instanceof NotSignedIn) throw error;
    const again = resumeCommand(target.source, target.requestId);
    warn(io, `预览下载失败（${codeOf(error)}）。结果已经记下，重新下载：${again}`);
    return { ...outcomeOf(target, task, 'succeeded', { resume: again }), ok: false };
  }
}

// ---------------------------------------------------------------------------------------------
// --resume

async function resume(run: Run, requestId: string): Promise<Outcome> {
  const { io, state, context, spec, options, draftId } = run;
  say(io, `继续查看 AI 视频请求 ${requestId}（${describeEnvironment(context.env)}）`);
  const saved = videoRequest(state, requestId);
  if (!saved) {
    // Not saved here (another machine, cleared state): looked up on this file's draft.
    dim(io, '本机没有这个请求的记录，按这个角色文件的草稿查询。');
    const target: Target = {
      requestId,
      draftId,
      source: spec.source,
      use: parseVideoUse(options.as),
      amount: null,
    };
    let task: VideoTask;
    try {
      task = await readTask(context.gateway, requestId, draftId);
    } catch (error) {
      if (error instanceof UgcFailure && error.code === 'NOT_FOUND') {
        // NOT_FOUND does not show that nothing was charged (another draft, another machine).
        warn(io, `这个角色文件的草稿下找不到请求 ${requestId}（用 --list 查看）。`);
        return outcomeOf(target, null, 'unknown', { error_code: 'NOT_FOUND' });
      }
      throw error;
    }
    return follow(run, target, null, task);
  }
  const target = targetOf(saved);
  const again = resumeCommand(saved.source, requestId);
  if (saved.request.draft_id !== draftId)
    warn(io, `这个请求属于另一个角色文件：${saved.source}（结果记在那个文件下）。`);
  if (saved.state === 'accepted') return follow(run, target, saved, saved.task);

  // The create's answer was lost: does the server have it?
  dim(io, '上次创建请求的结果未知，先向服务端确认…');
  let task: VideoTask | null = null;
  try {
    task = await readTask(context.gateway, requestId, saved.request.draft_id);
  } catch (error) {
    if (!(error instanceof UgcFailure) || error.code !== 'NOT_FOUND') {
      warn(io, `暂时确认不了（${codeOf(error)}）。请求仍保存在本机，稍后再试：${again}`);
      if (error instanceof NotSignedIn) throw error;
      return outcomeOf(target, null, 'unknown', { error_code: codeOf(error), resume: again });
    }
  }
  if (task) {
    say(io, '服务端已经受理了这个请求（没有重复扣费）。');
    saveVideoRequest(state, { ...saved, state: 'accepted', task });
    return follow(run, target, saved, task);
  }
  // Not there: the same saved request goes again (same ID and body; accepted at most once).
  say(io, '服务端没有这个请求的记录。将重发当时保存的同一个请求（同一个请求 ID 和参数）。');
  const agreed = await confirmSpend(io, context.gateway, {
    action: `重发生成 AI 视频的请求（${VIDEO_USE_LABEL[saved.use]}）`,
    total: saved.amount,
    acceptPrice: options.acceptPrice,
    notes: ['报价可能已经过期：过期时服务端会拒绝且不扣费，重新运行生成即可。'],
    replay: true,
  });
  if (!agreed) {
    say(io, `没有重发。请求仍保存在本机：${again}`);
    return outcomeOf(target, null, 'cancelled', { resume: again });
  }
  if (
    !(await confirmProduction(context, '重发生成 AI 视频的请求（会扣钻石）', options.confirmProd))
  )
    return outcomeOf(target, null, 'cancelled', { resume: again });
  return submit(run, saved);
}
