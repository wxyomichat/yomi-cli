import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { NotSignedIn } from '../core/api.js';
import { describeEnvironment, UsageError } from '../core/env.js';
import type { LocalState } from '../core/state.js';
import { ask, type Io, paint, say, warn } from '../core/ui.js';
import {
  confirmSpend,
  download,
  explainRefusal,
  extensionOf,
  GenRefusal,
  generationRefusal,
  mediaDir,
  pollUntil,
  saveFile,
} from '../gen/common.js';
import {
  AVATAR_POLL,
  type AvatarConfig,
  type AvatarOutcome,
  type AvatarRequest,
  type AvatarRun,
  type AvatarTarget,
  type AvatarTask,
  avatarTaskBody,
  CREATE_TASK_METHOD,
  createAvatarTasks,
  createPersona,
  createdPersona,
  currentPersona,
  GENDER_KEY,
  GENDER_LABEL,
  GENDER_NAMES,
  isFinal,
  MAX_NAME,
  MAX_PROMPT,
  MAX_RESULT_BYTES,
  outcomeOf,
  type PendingCreation,
  type PersonaPanel,
  prepareReference,
  readAvatarConfig,
  readAvatarTasks,
  readPersonaPanel,
  requestFingerprint,
  requestIdConflict,
  RUN_KIND,
  sentPrices,
  setPersonaAvatar,
  uploadReference,
} from '../gen/persona.js';
import { sniffMime } from '../gen/raster.js';
import { UgcFailure } from '../ugc/api.js';
import { type Context, localState, requireSignIn } from './context.js';
import { confirmProduction } from './declaration.js';

/** `yomi persona list | avatar`: your chat personas and their AI avatars. */
export type PersonaCommandOptions = {
  prompt: string;
  persona: string;
  create: boolean;
  name: string;
  gender: string;
  age: number | null;
  model: string;
  style: string;
  count: number | null;
  reference: string;
  pick: number | null;
  out: string;
  resume: string;
  listOptions: boolean;
  acceptPrice: boolean;
  confirmProd: boolean;
  json: boolean;
  /**
   * `--create-again`: the person checked `yomi persona list` and a new persona whose creation had
   * an unknown answer is not there, so it may be created again without asking. Needed only when
   * nobody can type the yes (`CREATE_AGAIN_FLAG`).
   */
  createAgain?: boolean;
};

/** The flag that stands for the typed yes before creating a persona again. */
export const CREATE_AGAIN_FLAG = '--create-again';

/** One `yomi persona avatar` run: where its lines go and what it has confirmed. */
type Session = {
  context: Context;
  options: PersonaCommandOptions;
  /** Human-readable lines: stdout, or stderr under `--json` (stdout then carries one object). */
  io: Io;
  state: LocalState;
  /** `--persona` / `--new` given now (on `--resume` they replace the saved target). */
  override: AvatarTarget | null;
  /** Production was confirmed in this process. */
  production: boolean;
};

/**
 * `yomi persona list`: the personas as a table. `yomi persona avatar`: AI avatars for a persona,
 * as the app makes them. The price (per successful image × count) and the balance are shown and a
 * typed yes (or `--accept-price`) is needed before the paying request; the request is saved with
 * its ID first, so an unknown answer is resumed with the same ID (`--resume`) and never charged
 * twice. The results are downloaded, and the one picked (`--pick`, or asked) is written to the
 * persona.
 */
export async function persona(
  context: Context,
  action: string,
  options: PersonaCommandOptions,
): Promise<void> {
  if (action === 'list') return listPersonas(context, options);
  if (action === 'avatar') return avatar(context, options);
  throw new UsageError(
    action
      ? `不认识的 persona 子命令：${action}（可用：list、avatar）`
      : '用法：yomi persona list，或 yomi persona avatar -p "描述"（yomi persona --help 查看选项）',
  );
}

// ---- list -------------------------------------------------------------------------------------

/** Terminal columns a string takes (CJK and other wide characters count two). */
function columns(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - columns(value)));
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => columns(row[column]))));
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : pad(cell, widths[column])))
      .join('  ')
      .trimEnd(),
  );
}

function avatarLabel(item: PersonaPanel['items'][number]): string {
  if (item.persona.avatarAssetId) return 'AI 生成';
  return item.persona.avatarUrl ? '已设置' : '默认头像';
}

async function listPersonas(context: Context, options: PersonaCommandOptions) {
  requireSignIn(context);
  const { io } = context;
  const panel = await readPersonaPanel(context.gateway);
  if (options.json) {
    say(
      io,
      JSON.stringify(
        {
          personas: panel.items.map((item) => ({
            persona_id: item.persona.personaId,
            name: item.persona.name,
            gender: GENDER_KEY[item.persona.gender] ?? 'unknown',
            age: item.persona.age,
            avatar_url: item.persona.avatarUrl || null,
            avatar_media_asset_id: item.persona.avatarAssetId || null,
            is_current: item.isCurrent,
            is_default: item.isDefault,
          })),
          current_persona_id: panel.currentPersonaId || null,
          default_persona_id: panel.defaultPersonaId || null,
          total_cnt: panel.total,
          rules: {
            can_create: panel.rules.canCreate,
            unlimited: panel.rules.unlimited,
            max_persona_cnt: panel.rules.maxPersonaCnt,
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  const limit = panel.rules.unlimited
    ? '数量不限'
    : `最多 ${panel.rules.maxPersonaCnt} 个，${panel.rules.canCreate ? '还可以新建' : '已达上限，不能再新建'}`;
  say(io, `你的人设（主控）：共 ${panel.total} 个（${limit}）`);
  if (!panel.items.length) {
    say(
      io,
      paint(io, 'dim', '还没有人设。可以用 yomi persona avatar --new 新建一个带 AI 头像的人设。'),
    );
    return;
  }
  const rows = [['ID', '名字', '性别', '年龄', '头像', '']];
  for (const item of panel.items) {
    const flags = [item.isCurrent ? '当前' : '', item.isDefault ? '默认' : ''].filter(Boolean);
    rows.push([
      item.persona.personaId,
      item.persona.name || '（未命名）',
      GENDER_LABEL[item.persona.gender] ?? '未知',
      item.persona.age ? String(item.persona.age) : '—',
      avatarLabel(item),
      flags.join('·'),
    ]);
  }
  const lines = table(rows);
  say(io, paint(io, 'dim', '  ' + lines[0]));
  for (const line of lines.slice(1)) say(io, '  ' + line);
  const runs = localState(context).records<AvatarRun>(RUN_KIND);
  const creations = runs.filter(([, run]) => run.creating && !run.applied?.created);
  if (creations.length) say(io);
  for (const [requestId, run] of creations) {
    const pending = run.creating as PendingCreation;
    say(
      io,
      paint(
        io,
        'yellow',
        `本机记着一次结果未知的新建：人设「${pending.name}」（头像用请求 ${requestId} 的第 ${pending.index} 张）。上面有它就是已经建好了，不要再新建；没有的话，yomi persona avatar --resume ${requestId} --pick ${pending.index} 会先请你确认再建。`,
      ),
    );
  }
  const open = runs.filter(
    ([, run]) => run.state === 'pending' || run.tasks.some((task) => !isFinal(task.status)),
  );
  if (open.length) {
    const [latest] = open[open.length - 1];
    say(io);
    say(
      io,
      paint(
        io,
        'dim',
        `本机有 ${open.length} 次头像生成还没有最终结果，继续查看：yomi persona avatar --resume ${latest}`,
      ),
    );
  }
}

// ---- avatar: options, target ------------------------------------------------------------------

function priceLabel(price: number | null): string {
  if (price === null) return '价格不明';
  return price === 0 ? '免费' : `${price} 钻石/张`;
}

async function showOptions(context: Context, options: PersonaCommandOptions) {
  const { io } = context;
  const config = await readAvatarConfig(context.gateway);
  if (options.json) {
    say(
      io,
      JSON.stringify(
        {
          models: config.models.map((model, index) => ({
            model_id: model.modelId,
            display_name: model.name,
            price_diamonds: model.price,
            default: index === 0,
          })),
          styles: config.styles.map((style) => ({
            style_id: style.styleId,
            display_name: style.name,
          })),
          max_image_cnt: config.maxImageCnt,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!config.models.length) {
    warn(io, '暂时没有可用的头像生成模型：这项功能还没有开放。');
    return;
  }
  say(io, '模型（--model，第一个是默认；价格按成功的张数计，失败或未通过内容检查的不计费）：');
  config.models.forEach((model, index) =>
    say(
      io,
      `  ${paint(io, 'bold', model.modelId)}  ${model.name}  ${priceLabel(model.price)}${index === 0 ? paint(io, 'dim', '（默认）') : ''}`,
    ),
  );
  if (config.styles.length) {
    say(io, '风格（--style，可不选）：');
    for (const style of config.styles)
      say(io, `  ${paint(io, 'bold', style.styleId)}  ${style.name}`);
  } else say(io, '风格：暂无');
  say(io, `每次最多 ${config.maxImageCnt} 张（--count，默认 ${config.maxImageCnt}）`);
}

/** The target from `--persona` / `--new`, null when neither was given. */
function targetFrom(options: PersonaCommandOptions): AvatarTarget | null {
  const newFields = Boolean(options.name || options.gender || options.age !== null);
  if (options.persona && options.create) throw new UsageError('--persona 和 --new 只能选一个');
  if (!options.create && newFields)
    throw new UsageError('--name / --gender / --age 只在 --new 新建人设时使用');
  if (options.persona) {
    const id = options.persona.trim();
    if (!/^[1-9][0-9]{0,18}$/.test(id))
      throw new UsageError('--persona 需要人设 ID（yomi persona list 查看）');
    return { kind: 'persona', personaId: id };
  }
  if (!options.create) return null;
  const name = options.name.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME)
    throw new UsageError(`--new 需要 --name（1–${MAX_NAME} 个字）`);
  const genderKey = options.gender.trim().toLowerCase();
  // Own keys only: `constructor` or `toString` must not pass as a gender.
  const gender = Object.hasOwn(GENDER_NAMES, genderKey) ? GENDER_NAMES[genderKey] : 0;
  if (!gender) throw new UsageError('--new 需要 --gender：male、female 或 other');
  if (options.age === null) throw new UsageError('--new 需要 --age（18–150）');
  return { kind: 'new', name, gender, age: options.age };
}

/**
 * Where a picked image would go, checked against the list before anything is spent: an unknown
 * `--persona` or a full persona list for `--new` is an error. '' when there is no current persona
 * and nothing has to be written now.
 */
function destinationOf(panel: PersonaPanel, target: AvatarTarget, needed: boolean): string {
  if (target.kind === 'persona') {
    const item = panel.items.find((entry) => entry.persona.personaId === target.personaId);
    if (!item)
      throw new UsageError(`没有 ID 为 ${target.personaId} 的人设（yomi persona list 查看）`);
    return `人设「${item.persona.name}」（${item.persona.personaId}）`;
  }
  if (target.kind === 'new') {
    if (!panel.rules.canCreate)
      throw new UsageError(
        `人设数量已达上限（最多 ${panel.rules.maxPersonaCnt} 个），不能再新建；可以用 --persona ID 换掉已有人设的头像`,
      );
    return `新人设「${target.name}」（${GENDER_LABEL[target.gender]}，${target.age} 岁）`;
  }
  const item = currentPersona(panel);
  if (!item) {
    if (needed) throw new UsageError('找不到当前使用的人设，请用 --persona ID 或 --new 指定');
    return '';
  }
  return `当前使用的人设「${item.persona.name}」（${item.persona.personaId}）`;
}

function targetLabel(target: AvatarTarget): string {
  if (target.kind === 'persona') return `人设 ${target.personaId}`;
  if (target.kind === 'new') return `新人设「${target.name}」`;
  return '当前使用的人设';
}

function resumeCommand(run: AvatarRun): string {
  return `yomi persona avatar --resume ${run.requestId}`;
}

function describeError(error: unknown): string {
  if (error instanceof UgcFailure)
    return error.message && error.message !== error.code
      ? `${error.code}：${error.message}`
      : error.code;
  return error instanceof Error ? error.message : String(error);
}

/** Ends the run: the exit code, and under `--json` the one object on stdout. */
function finish(session: Session, result: Record<string, unknown>, code: number) {
  if (code) process.exitCode = code;
  if (session.options.json) say(session.context.io, JSON.stringify(result, null, 2));
}

function notSent(session: Session, line: string) {
  say(session.io, line);
  finish(session, { status: 'not_sent' }, 1);
}

// ---- avatar: generate, resume -----------------------------------------------------------------

async function avatar(context: Context, options: PersonaCommandOptions) {
  requireSignIn(context);
  if (options.listOptions) return showOptions(context, options);
  const session: Session = {
    context,
    options,
    io: options.json ? { ...context.io, stdout: context.io.stderr } : context.io,
    state: localState(context),
    override: targetFrom(options),
    production: false,
  };
  if (options.resume) return resume(session);
  return generate(session);
}

function pickModel(config: AvatarConfig, wanted: string) {
  if (!wanted) return config.models[0];
  const model = config.models.find((item) => item.modelId === wanted);
  if (!model)
    throw new UsageError(
      `没有模型 ${wanted}，可用：${config.models.map((item) => item.modelId).join('、')}`,
    );
  return model;
}

function pickStyle(config: AvatarConfig, wanted: string) {
  if (!wanted) return null;
  const style = config.styles.find((item) => item.styleId === wanted);
  if (!style)
    throw new UsageError(
      config.styles.length
        ? `没有风格 ${wanted}，可用：${config.styles.map((item) => item.styleId).join('、')}`
        : '现在没有可选的风格，去掉 --style',
    );
  return style;
}

async function generate(session: Session) {
  const { context, options, io, state } = session;
  const { gateway } = context;
  const prompt = options.prompt.trim();
  if (!prompt)
    throw new UsageError('需要描述：yomi persona avatar -p "描述"（--options 查看模型和风格）');
  const length = [...prompt].length;
  if (length > MAX_PROMPT) throw new UsageError(`描述最多 ${MAX_PROMPT} 个字（现在 ${length} 个）`);
  const target = session.override ?? { kind: 'current' };
  // Local checks first: a bad reference file costs nothing.
  const reference = options.reference ? prepareReference(options.reference) : null;
  const config = await readAvatarConfig(gateway);
  if (!config.models.length)
    return notSent(session, '暂时没有可用的头像生成模型（这项功能还没有开放）。没有发出请求。');
  const model = pickModel(config, options.model);
  const style = pickStyle(config, options.style);
  const count = options.count ?? config.maxImageCnt;
  if (count > config.maxImageCnt)
    throw new UsageError(`--count 最多 ${config.maxImageCnt}（服务端的上限）`);
  if (options.pick !== null && options.pick > count)
    throw new UsageError(`--pick 不能大于张数 ${count}`);
  if (model.price === null)
    return notSent(session, '服务端返回的价格读不懂，为避免扣费出错没有继续。');
  const destination = destinationOf(await readPersonaPanel(gateway), target, options.pick !== null);
  const fingerprint = requestFingerprint(
    {
      prompt,
      model_id: model.modelId,
      image_cnt: count,
      ...(style ? { style_id: style.styleId } : {}),
    },
    reference?.sha256 ?? '',
  );
  const unknown = state
    .records<AvatarRun>(RUN_KIND)
    .find(([, run]) => run.state === 'pending' && run.fingerprint === fingerprint);
  if (unknown) {
    const [requestId, run] = unknown;
    warn(
      io,
      `同样的请求上次结果未知（请求号 ${requestId}）。为避免重复扣费，没有发新请求。用原来的请求号继续：${resumeCommand(run)}`,
    );
    return finish(
      session,
      { status: 'unknown', request_id: requestId, resume: resumeCommand(run) },
      1,
    );
  }

  say(io, `生成人设头像（${describeEnvironment(context.env)}）`);
  say(
    io,
    `模型：${model.name}${style ? `　风格：${style.name}` : ''}　张数：${count}${reference ? '　带参考图' : ''}`,
  );
  if (destination) say(io, `选中的图片会写进：${destination}`);
  const total = model.price * count;
  const agreed = await confirmSpend(io, gateway, {
    action: `生成 ${count} 张人设头像`,
    total,
    unit: { price: model.price, count, label: '张' },
    acceptPrice: options.acceptPrice,
    notes: ['按成功的张数扣钻石：生成失败或没有通过内容检查的那张不计费。上面是全部成功时的总价。'],
  });
  if (!agreed) return notSent(session, '没有发出生成请求。');
  if (
    !(await confirmProduction(
      { ...context, io },
      `生成人设头像（最多 ${total} 钻石）并写进人设`,
      options.confirmProd,
    ))
  )
    return notSent(session, '已取消，没有发出生成请求。');
  session.production = true;

  let objectKey = '';
  if (reference) {
    say(io, paint(io, 'dim', '上传参考图…'));
    try {
      objectKey = await uploadReference(gateway, reference.jpeg, context.fetch);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      warn(io, `参考图上传失败（${describeError(error)}）。`);
      return notSent(session, '没有发出生成请求，没有扣费。');
    }
  }
  const request: AvatarRequest = {
    prompt,
    model_id: model.modelId,
    image_cnt: count,
    ...(style ? { style_id: style.styleId } : {}),
    ...(objectKey ? { source_image_object_key: objectKey } : {}),
  };
  // A new intent gets a new key; the receipt keeps its ID for this exact request.
  const receiptKey = `persona-avatar:${randomUUID()}`;
  const requestId = state.receipt(CREATE_TASK_METHOD, receiptKey, request);
  const run: AvatarRun = {
    requestId,
    receiptKey,
    request,
    body: avatarTaskBody(request, requestId),
    fingerprint,
    modelName: model.name,
    styleName: style?.name ?? '',
    unitPrice: model.price,
    sentPrices: [model.price],
    state: 'pending',
    tasks: [],
    target,
    applied: null,
    creating: null,
    at: Date.now(),
  };
  // Saved before the paying call: an unknown answer is resumed with this ID and body. The check for
  // the same request left unknown by another yomi process (while this one waited for the yes) and
  // the save are one locked step, so two terminals never both pay for it.
  const claimed = state.claimRecord<AvatarRun>(
    RUN_KIND,
    (runs) =>
      runs.find(([, other]) => other.state === 'pending' && other.fingerprint === fingerprint) ??
      null,
    () => [requestId, run],
  );
  if (claimed.existing) {
    state.dropReceipt(CREATE_TASK_METHOD, receiptKey, request);
    warn(
      io,
      `同样的请求刚由另一个 yomi 进程发出（请求号 ${claimed.key}），结果还没回来：这里没有再发，没有扣费。用原来的请求号继续：${resumeCommand(claimed.value)}`,
    );
    return finish(
      session,
      { status: 'unknown', request_id: claimed.key, resume: resumeCommand(claimed.value) },
      1,
    );
  }
  await submit(session, run, false);
}

async function resume(session: Session) {
  const { options, io, state } = session;
  const requestId = options.resume.trim();
  const run = state.record<AvatarRun>(RUN_KIND, requestId);
  if (!run)
    throw new UsageError(
      `本机没有请求号 ${requestId} 的人设头像生成记录（--resume 只能继续这台电脑上、这个账号发起的生成）`,
    );
  if (
    options.prompt ||
    options.model ||
    options.style ||
    options.count !== null ||
    options.reference
  )
    warn(
      io,
      '--resume 继续的是当时的请求：-p / --model / --style / --count / --reference 不起作用。',
    );
  if (session.override) {
    run.target = session.override;
    state.setRecord(RUN_KIND, run.requestId, run);
  }
  if (run.state === 'pending') {
    say(io, `请求 ${run.requestId} 上次的结果未知，现在原样重发（同一个请求号、同一个请求体）。`);
    // A replay the server never saw is charged at today's price: a price above every one agreed
    // is shown with the balance and needs a new yes.
    const config = await readAvatarConfig(session.context.gateway);
    const model = config.models.find((item) => item.modelId === run.request.model_id);
    const price = model ? model.price : run.unitPrice;
    if (price === null) return notSent(session, '服务端返回的价格读不懂，为避免扣费出错没有重发。');
    const count = run.request.image_cnt;
    const agreedPrice = Math.max(...sentPrices(run));
    if (price > agreedPrice) {
      warn(io, `这个模型的单价从 ${agreedPrice} 变成了 ${price} 钻石/张，需要重新确认。`);
      const agreed = await confirmSpend(io, session.context.gateway, {
        action: `重发生成 ${count} 张人设头像`,
        total: price * count,
        unit: { price, count, label: '张' },
        acceptPrice: options.acceptPrice,
        notes: [
          '上次已受理的话，重发只取回原来的任务，不会再扣费；上次没有收到，就按新价格、按成功的张数扣钻石（以钱包记录为准）。',
        ],
        replay: true,
      });
      if (!agreed) return notSent(session, '没有重发，这次生成仍记在本机。');
    } else
      say(
        io,
        paint(
          io,
          'dim',
          `服务端按请求号去重：上次已受理就返回原来的任务，不会再扣费；上次没有收到，就按现在的单价生成（${price > 0 ? `${price} 钻石/张，全部成功共 ${price * count} 钻石，按成功的张数计` : '免费'}）。`,
        ),
      );
    if (
      !(await confirmProduction(
        { ...session.context, io },
        '重发一次人设头像生成请求',
        options.confirmProd,
      ))
    )
      return notSent(session, '已取消，没有重发。');
    session.production = true;
    // Saved before the paying call: a price that differs from an earlier send makes the charge
    // a question for the wallet.
    if (!sentPrices(run).includes(price)) {
      run.sentPrices = [...sentPrices(run), price];
      state.setRecord(RUN_KIND, run.requestId, run);
    }
    return submit(session, run, true);
  }
  say(
    io,
    `继续查看请求 ${run.requestId}：${run.modelName}${run.styleName ? `、${run.styleName}` : ''}，${run.request.image_cnt} 张（不会再扣费）`,
  );
  return follow(session, run, []);
}

/** Sends the frozen create request (first time or replay) and follows its tasks. */
async function submit(session: Session, run: AvatarRun, replay: boolean) {
  const { context, io, state } = session;
  say(io, paint(io, 'dim', replay ? `重发请求 ${run.requestId}…` : '提交生成请求…'));
  let tasks: AvatarTask[];
  try {
    tasks = await createAvatarTasks(context.gateway, run.body);
  } catch (error) {
    const outcome = generationRefusal(error);
    // A conflict on our own request ID says an earlier send may have been taken: unknown.
    const conflict = requestIdConflict(error);
    if (outcome instanceof GenRefusal && !conflict && replay)
      return replayRefused(session, run, outcome);
    if (outcome instanceof GenRefusal && !conflict) {
      // Refused at the first send: nothing was accepted or charged, so the ID is not kept.
      state.dropReceipt(CREATE_TASK_METHOD, run.receiptKey, run.request);
      state.setRecord(RUN_KIND, run.requestId, null);
      explainRefusal(io, outcome);
      return finish(
        session,
        { status: 'refused', request_id: run.requestId, reason: outcome.kind, code: outcome.code },
        1,
      );
    }
    if (outcome instanceof NotSignedIn) {
      warn(
        io,
        `生成请求 ${run.requestId} 的结果未知，已记在本机。重新 yomi login 后运行 ${resumeCommand(run)}，用同一个请求号继续（不会重复扣费）。`,
      );
      throw outcome;
    }
    return unknownOutcome(session, run, describeError(error), conflict);
  }
  if (!tasks.length) return unknownOutcome(session, run, '回包里没有任务', false);
  run.state = 'accepted';
  run.tasks = tasks.map((task) => ({
    index: task.index,
    taskId: task.taskId,
    status: task.status,
    assetId: task.assetId,
    failureCode: task.failureCode,
    file: '',
  }));
  state.setRecord(RUN_KIND, run.requestId, run);
  say(
    io,
    `${replay ? '服务端已受理（同一个请求号）' : '已提交'}：${tasks.length} 张，请求号 ${run.requestId}`,
  );
  await follow(session, run, tasks);
}

function unknownOutcome(session: Session, run: AvatarRun, reason: string, conflict: boolean) {
  const { io } = session;
  warn(
    io,
    `生成请求的结果未知（${reason}）：服务端可能已经受理，也可能没有。CLI 不会自动重发，也不会换新的请求号。`,
  );
  if (conflict)
    warn(
      io,
      `服务端说请求号 ${run.requestId} 已经用在了另一个请求体上：之前有一次请求带着它，可能已经受理并扣了钻石，所以这不算被拒。本机仍保留这次生成的记录和请求号。可以先在 Yomi App 的钱包记录里看看有没有这笔扣费。`,
    );
  say(io, `用同一个请求号继续（服务端按请求号去重，不会重复扣费）：${resumeCommand(run)}`);
  finish(
    session,
    {
      status: 'unknown',
      request_id: run.requestId,
      ...(conflict ? { reason: 'request_id_conflict' } : {}),
      resume: resumeCommand(run),
    },
    1,
  );
}

/**
 * A replay of a request whose first answer never came was refused. The first send may still have
 * been accepted and charged, so nothing is forgotten: the record, its request ID and its receipt
 * stay, and the next `--resume` sends the same ID and body again.
 */
function replayRefused(session: Session, run: AvatarRun, refusal: GenRefusal) {
  const { io } = session;
  const detail =
    refusal.message && refusal.message !== refusal.code
      ? `${refusal.code}：${refusal.message}`
      : refusal.code;
  const why =
    refusal.kind === 'gems'
      ? '钻石不足'
      : refusal.kind === 'rateLimited'
        ? '生成太频繁或同时进行的任务太多'
        : refusal.kind === 'unavailable'
          ? '这项生成功能暂时不可用'
          : '服务端拒绝';
  const when =
    refusal.kind === 'gems'
      ? '充值后'
      : refusal.kind === 'rateLimited' || refusal.kind === 'unavailable'
        ? '过一会儿'
        : '稍后';
  warn(io, `这次重发被拒了：${why}（${detail}）。这次重发本身没有扣费。`);
  warn(
    io,
    `但上次那次的结果一直未知，可能已经受理并扣了钻石，所以本机没有删除这次生成：记录和请求号 ${run.requestId} 都还在，以后重发仍用同一个请求号，服务端按请求号去重，最多扣一次。`,
  );
  say(io, `可以先在 Yomi App 的钱包记录里看看有没有这笔扣费。${when}再试：${resumeCommand(run)}`);
  finish(
    session,
    {
      status: 'unknown',
      request_id: run.requestId,
      replay_refusal: { reason: refusal.kind, code: refusal.code },
      resume: resumeCommand(run),
    },
    1,
  );
}

// ---- avatar: follow, report, pick, apply ------------------------------------------------------

const OUTCOME_LABEL: Record<AvatarOutcome, string> = {
  succeeded: '成功',
  failed: '生成失败',
  sensitive: '没有通过内容检查',
  incomplete: '服务端标为成功但没有返回可用的图片',
  running: '还在生成',
};

function progressLine(tasks: AvatarTask[]): string {
  const done = tasks.filter((task) => isFinal(task.status)).length;
  return `生成中：${done}/${tasks.length} 张已出结果…`;
}

async function saveResult(session: Session, run: AvatarRun, task: AvatarTask): Promise<string> {
  const { bytes, mime } = await download(task.imageUrl, {
    maxBytes: MAX_RESULT_BYTES,
    fetcher: session.context.fetch,
  });
  const extension = extensionOf(sniffMime(bytes) || mime);
  return saveFile(
    mediaDir(session.options.out),
    `persona-avatar-${run.requestId.slice(0, 8)}-${task.index}.${extension}`,
    bytes,
  );
}

/**
 * Polls the tasks (fresh display addresses come with every reading), reports each image, downloads
 * the successes, then writes the picked one to the persona.
 */
async function follow(session: Session, run: AvatarRun, initial: AvatarTask[]) {
  const { context, options, io, state } = session;
  const live = new Map<string, AvatarTask>();
  for (const saved of run.tasks)
    live.set(saved.taskId, {
      index: saved.index,
      taskId: saved.taskId,
      status: saved.status,
      assetId: saved.assetId,
      imageUrl: '',
      failureCode: saved.failureCode,
      failureMessage: '',
    });
  for (const task of initial) if (live.has(task.taskId)) live.set(task.taskId, task);
  const ids = run.tasks.map((task) => task.taskId);
  let readings = 0;
  let shown = '';
  // Ctrl-C stops watching (after the current wait); the server keeps generating.
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  const polled = await pollUntil(
    async () => {
      const tasks = await readAvatarTasks(context.gateway, ids);
      // Merged by task ID; IDs this run does not know are ignored.
      for (const task of tasks) {
        const known = live.get(task.taskId);
        if (known) live.set(task.taskId, { ...task, index: known.index });
      }
      readings += 1;
      return [...live.values()];
    },
    {
      intervalMs: AVATAR_POLL.intervalMs,
      maxRounds: AVATAR_POLL.maxRounds,
      done: (tasks) => tasks.every((task) => isFinal(task.status)),
      onTick: (tasks) => {
        const line = progressLine(tasks);
        if (line === shown) return;
        shown = line;
        say(io, paint(io, 'dim', line));
      },
      onError: (error) => warn(io, `查询进度失败（${describeError(error)}），继续重试…`),
      signal: stop.signal,
    },
  ).finally(() => process.removeListener('SIGINT', onSignal));
  const stopped = stop.signal.aborted;
  if (stopped) say(io, '已停止查看。');
  if (readings === 0) {
    warn(io, '一直查不到生成进度。停止查看不会取消服务端的生成。');
    say(io, `稍后继续查看：${resumeCommand(run)}`);
    return finish(
      session,
      { status: 'unknown_progress', request_id: run.requestId, resume: resumeCommand(run) },
      1,
    );
  }
  const tasks = [...live.values()].sort((a, b) => a.index - b.index);
  for (const saved of run.tasks) {
    const task = live.get(saved.taskId);
    if (!task) continue;
    saved.status = task.status;
    saved.assetId = task.assetId;
    saved.failureCode = task.failureCode;
  }

  say(io);
  say(io, '结果：');
  const outputs: Record<string, unknown>[] = [];
  const counts: Record<AvatarOutcome, number> = {
    succeeded: 0,
    failed: 0,
    sensitive: 0,
    incomplete: 0,
    running: 0,
  };
  for (const task of tasks) {
    const outcome = outcomeOf(task);
    counts[outcome] += 1;
    const saved = run.tasks.find((item) => item.taskId === task.taskId);
    let file = '';
    let downloadError = '';
    if (outcome === 'succeeded') {
      if (saved?.file && existsSync(saved.file)) file = saved.file;
      else {
        try {
          file = await saveResult(session, run, task);
          if (saved) saved.file = file;
        } catch (error) {
          downloadError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    const reason = task.failureMessage || task.failureCode;
    const head = `  第 ${task.index} 张：`;
    if (outcome === 'succeeded')
      say(
        io,
        head +
          paint(io, 'green', '✓ 成功') +
          (file
            ? `  ${file}`
            : paint(io, 'yellow', `（下载失败：${downloadError}；可以稍后 --resume 再下载）`)),
      );
    else if (outcome === 'failed')
      say(
        io,
        head + paint(io, 'red', `✗ 生成失败${reason ? `（${reason}）` : ''}`) + '，这张不计费',
      );
    else if (outcome === 'sensitive')
      say(io, head + paint(io, 'red', '✗ 没有通过内容检查') + '，这张不计费');
    else if (outcome === 'incomplete')
      say(
        io,
        head +
          paint(io, 'red', `✗ ${OUTCOME_LABEL.incomplete}`) +
          '，不能选用（是否计费以钱包记录为准）',
      );
    else say(io, head + paint(io, 'dim', '… 还在生成'));
    outputs.push({
      index: task.index,
      media_task_id: task.taskId,
      status: outcome,
      media_asset_id: task.assetId || null,
      file: file || null,
      ...(downloadError ? { download_error: downloadError } : {}),
      ...(task.failureCode ? { failure_code: task.failureCode } : {}),
      ...(task.failureMessage ? { failure_message: task.failureMessage } : {}),
    });
  }
  state.setRecord(RUN_KIND, run.requestId, run);

  const parts = [`成功 ${counts.succeeded}`];
  if (counts.failed) parts.push(`生成失败 ${counts.failed}`);
  if (counts.sensitive) parts.push(`没有通过内容检查 ${counts.sensitive}`);
  if (counts.incomplete) parts.push(`结果不完整 ${counts.incomplete}`);
  if (counts.running) parts.push(`还在生成 ${counts.running}`);
  say(io, `共 ${tasks.length} 张：${parts.join('，')}。`);
  // Sent at different prices (a replay after a price change): which one the server charged
  // depends on which send it accepted, and its answer does not say, so only the wallet knows.
  const prices = sentPrices(run);
  const unitPrice = prices.length === 1 ? prices[0] : null;
  // The server bills every task it marked succeeded, also one whose reading lacks the picture.
  const billed = counts.succeeded + counts.incomplete;
  const charged = unitPrice === null ? null : billed * unitPrice;
  if (unitPrice === null)
    say(
      io,
      `${counts.running ? '目前' : ''}按成功的 ${billed} 张计费，单价不确定：这个请求先后在 ${prices.join(' 和 ')} 钻石/张时发出，按哪个价取决于服务端受理的是哪一次，CLI 无法判断。实际扣了多少以钱包记录为准。失败和没有通过内容检查的不计费。`,
    );
  else if (unitPrice > 0)
    say(
      io,
      `${counts.running ? '目前' : ''}按成功的 ${billed} 张计费：${charged} 钻石（${unitPrice} 钻石/张）${counts.incomplete ? `，含 ${counts.incomplete} 张服务端标为成功但没返回图片的` : ''}。失败和没有通过内容检查的不计费；如果是先扣后退，退回以钱包记录为准。`,
    );
  else say(io, '这个模型免费。');
  if (counts.running)
    say(
      io,
      paint(
        io,
        'yellow',
        `还有 ${counts.running} 张在生成。停止查看不会取消服务端的生成（成功的照样计费）；继续查看：${resumeCommand(run)}`,
      ),
    );

  let code = polled.done && counts.succeeded > 0 ? 0 : 1;
  const usable = tasks.filter((task) => outcomeOf(task) === 'succeeded');
  let applied: Record<string, unknown> | null = null;
  if (stopped) {
    if (usable.length) say(io, `之后选一张写进人设：${resumeCommand(run)} --pick <编号>`);
  } else if (options.pick !== null) {
    const chosen = tasks.find((task) => task.index === options.pick);
    if (!chosen || outcomeOf(chosen) !== 'succeeded') {
      warn(
        io,
        `第 ${options.pick} 张不能用作头像（${chosen ? OUTCOME_LABEL[outcomeOf(chosen)] : '没有这一张'}），没有写进人设。`,
      );
      code = 1;
    } else {
      applied = await applyPick(session, run, chosen);
      if (!applied) code = 1;
    }
  } else if (usable.length && context.io.interactive && !options.json) {
    const chosen = await askPick(session, run, usable);
    if (chosen) {
      applied = await applyPick(session, run, chosen);
      if (!applied) code = 1;
    } else say(io, `没有写进人设。之后可以：${resumeCommand(run)} --pick <编号>`);
  } else if (usable.length) {
    say(
      io,
      `选一张写进人设：${resumeCommand(run)} --pick <编号>（默认写进${targetLabel(run.target)}；也可以加 --persona ID 或 --new --name … --gender … --age …）`,
    );
  }
  finish(
    session,
    {
      status: polled.done ? 'done' : 'running',
      request_id: run.requestId,
      model_id: run.request.model_id,
      style_id: run.request.style_id ?? null,
      image_cnt: run.request.image_cnt,
      // Per successful image, as the price is defined; null when only the wallet can tell.
      unit_price_diamonds: unitPrice,
      charged_diamonds: charged,
      ...(unitPrice === null ? { possible_unit_prices_diamonds: prices } : {}),
      outputs,
      applied,
      resume: resumeCommand(run),
    },
    code,
  );
}

/**
 * Before creating a persona again after a creation whose answer was lost: if the list shows it
 * (same name, same AI avatar) it was created and is recorded as such; otherwise it is created only
 * after a typed yes, or `--create-again` when nobody can type. Returns 'create' to go on, else
 * what `applyPick` returns.
 */
async function settleCreation(
  session: Session,
  run: AvatarRun,
  pending: PendingCreation,
  chosen: AvatarTask,
): Promise<'create' | Record<string, unknown> | null> {
  const { context, options, io, state } = session;
  let panel: PersonaPanel | null = null;
  try {
    panel = await readPersonaPanel(context.gateway);
  } catch (error) {
    if (error instanceof NotSignedIn) throw error;
  }
  const found = panel ? createdPersona(panel, pending) : null;
  if (found) {
    run.creating = null;
    run.applied = {
      personaId: found.personaId,
      assetId: pending.assetId,
      index: pending.index,
      created: true,
    };
    state.setRecord(RUN_KIND, run.requestId, run);
    say(
      io,
      paint(
        io,
        'green',
        `✓ 上次新建的人设「${found.name}」（${found.personaId}）已经建好了，头像是第 ${pending.index} 张，没有再建。`,
      ),
    );
    if (chosen.assetId !== pending.assetId) {
      warn(
        io,
        `这次选的是第 ${chosen.index} 张，没有写进去。要换成它：${resumeCommand(run)} --pick ${chosen.index} --persona ${found.personaId}`,
      );
      return null;
    }
    return {
      persona_id: found.personaId,
      name: found.name,
      created: true,
      index: pending.index,
      media_asset_id: pending.assetId,
    };
  }
  warn(
    io,
    `上次新建人设「${pending.name}」时结果未知，可能已经建好了${panel ? '（人设列表里暂时没有看到它）' : '（人设列表暂时读不到）'}。`,
  );
  say(
    io,
    `先运行 yomi persona list 看看：已经有「${pending.name}」就不要再新建，换头像用 ${resumeCommand(run)} --pick ${chosen.index} --persona <它的 ID>。`,
  );
  if (options.createAgain) {
    say(io, `已加 ${CREATE_AGAIN_FLAG}：按你确认的，列表里没有它，再新建一次。`);
    return 'create';
  }
  if (!context.io.interactive) {
    warn(
      io,
      `确认列表里没有之后，再运行一次并加 ${CREATE_AGAIN_FLAG}（非交互运行时代替输入 yes）。这次没有新建人设。`,
    );
    return null;
  }
  const answer = await ask(
    io,
    `看过 yomi persona list、确认没有「${pending.name}」，要再新建一次？输入 yes 继续：`,
  );
  if ((answer ?? '').trim().toLowerCase() === 'yes') return 'create';
  say(io, '没有新建人设。');
  return null;
}

async function askPick(
  session: Session,
  run: AvatarRun,
  usable: AvatarTask[],
): Promise<AvatarTask | null> {
  const numbers = usable.map((task) => task.index).join('/');
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await ask(
      session.io,
      `选一张写进${targetLabel(session.override ?? run.target)}，输入编号（${numbers}；直接回车跳过）：`,
    );
    const value = answer?.trim() ?? '';
    if (!value) return null;
    const chosen = usable.find((task) => String(task.index) === value);
    if (chosen) return chosen;
    warn(session.io, `没有可选的第 ${value} 张。`);
  }
  return null;
}

/** Writes the picked image to the target persona; null (explained) when it did not happen. */
async function applyPick(
  session: Session,
  run: AvatarRun,
  chosen: AvatarTask,
): Promise<Record<string, unknown> | null> {
  const { context, options, io, state } = session;
  const target = session.override ?? run.target;
  const again = `${resumeCommand(run)} --pick ${chosen.index}`;
  if (!session.production) {
    if (!(await confirmProduction({ ...context, io }, '修改人设头像', options.confirmProd))) {
      say(io, '已取消，没有写进人设。');
      return null;
    }
    session.production = true;
  }
  if (target.kind === 'new') {
    if (run.applied?.created) {
      warn(
        io,
        `这次生成已经新建过人设 ${run.applied.personaId}，没有再建。要换它的头像：${again} --persona ${run.applied.personaId}`,
      );
      return null;
    }
    if (run.creating) {
      const settled = await settleCreation(session, run, run.creating, chosen);
      if (settled !== 'create') return settled;
    }
    // Saved before the call: if its answer is lost, the next try knows a persona may exist.
    run.creating = {
      name: target.name,
      gender: target.gender,
      age: target.age,
      assetId: chosen.assetId,
      index: chosen.index,
      at: Date.now(),
    };
    state.setRecord(RUN_KIND, run.requestId, run);
    let created;
    try {
      created = await createPersona(context.gateway, target, chosen.assetId);
    } catch (error) {
      const outcome = generationRefusal(error);
      // Signed out (refused before it ran) or clearly refused: nothing was created.
      if (error instanceof NotSignedIn || outcome !== error) {
        run.creating = null;
        state.setRecord(RUN_KIND, run.requestId, run);
      }
      if (error instanceof NotSignedIn) throw error;
      if (outcome !== error) {
        warn(
          io,
          `新建人设失败（${describeError(error)}），没有建成。图片已保存，可以稍后再试：${again}`,
        );
        return null;
      }
      warn(
        io,
        `新建人设的结果未知（${describeError(error)}）：人设「${target.name}」可能已经建好了，本机记下了这次新建。`,
      );
      say(
        io,
        `先运行 yomi persona list 看看：已经有「${target.name}」就不要再新建（换头像用 ${again} --persona <它的 ID>）；确实没有，再运行 ${again}，CLI 会先请你确认（非交互运行加 ${CREATE_AGAIN_FLAG}）。`,
      );
      return null;
    }
    run.creating = null;
    run.applied = {
      personaId: created.personaId,
      assetId: chosen.assetId,
      index: chosen.index,
      created: true,
    };
    state.setRecord(RUN_KIND, run.requestId, run);
    say(
      io,
      paint(
        io,
        'green',
        `✓ 已新建人设「${created.name || target.name}」（${created.personaId}），头像用第 ${chosen.index} 张。`,
      ),
    );
    say(io, paint(io, 'dim', '新人设不会自动设为默认或当前使用，可以在 App 里切换。'));
    return {
      persona_id: created.personaId,
      name: created.name || target.name,
      created: true,
      index: chosen.index,
      media_asset_id: chosen.assetId,
    };
  }
  let personaId = target.kind === 'persona' ? target.personaId : '';
  if (!personaId) {
    const item = currentPersona(await readPersonaPanel(context.gateway));
    if (!item) {
      warn(io, `找不到当前使用的人设，没有写进人设。请指定：${again} --persona ID`);
      return null;
    }
    personaId = item.persona.personaId;
  }
  let saved;
  try {
    saved = await setPersonaAvatar(context.gateway, personaId, chosen.assetId);
  } catch (error) {
    if (error instanceof NotSignedIn) throw error;
    warn(io, `写进人设失败（${describeError(error)}）。图片已保存，可以稍后再试：${again}`);
    return null;
  }
  run.applied = { personaId, assetId: chosen.assetId, index: chosen.index, created: false };
  state.setRecord(RUN_KIND, run.requestId, run);
  say(
    io,
    paint(
      io,
      'green',
      `✓ 已把第 ${chosen.index} 张设为人设「${saved.name}」（${saved.personaId || personaId}）的头像。`,
    ),
  );
  return {
    persona_id: saved.personaId || personaId,
    name: saved.name,
    created: false,
    index: chosen.index,
    media_asset_id: chosen.assetId,
  };
}
