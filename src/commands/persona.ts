import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { NotSignedIn } from '../core/api.js';
import { describeEnvironment, UsageError } from '../core/env.js';
import { tr } from '../core/i18n.js';
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
      ? tr(
          `不认识的 persona 子命令：${action}（可用：list、avatar）`,
          `Unknown persona subcommand: ${action} (available: list, avatar)`,
        )
      : tr(
          '用法：yomi persona list，或 yomi persona avatar -p "描述"（yomi persona --help 查看选项）',
          'Usage: yomi persona list, or yomi persona avatar -p "description" (yomi persona --help for options)',
        ),
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
  if (item.persona.avatarAssetId) return tr('AI 生成', 'AI-generated');
  return item.persona.avatarUrl ? tr('已设置', 'set') : tr('默认头像', 'default avatar');
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
    ? tr('数量不限', 'no limit')
    : tr(
        `最多 ${panel.rules.maxPersonaCnt} 个，${panel.rules.canCreate ? '还可以新建' : '已达上限，不能再新建'}`,
        `up to ${panel.rules.maxPersonaCnt}, ${panel.rules.canCreate ? 'you can create more' : 'limit reached, no more can be created'}`,
      );
  say(
    io,
    tr(
      `你的人设（主控）：共 ${panel.total} 个（${limit}）`,
      `Your personas: ${panel.total} (${limit})`,
    ),
  );
  if (!panel.items.length) {
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '还没有人设。可以用 yomi persona avatar --new 新建一个带 AI 头像的人设。',
          'No personas yet. Use yomi persona avatar --new to create one with an AI avatar.',
        ),
      ),
    );
    return;
  }
  const rows = [
    ['ID', tr('名字', 'Name'), tr('性别', 'Gender'), tr('年龄', 'Age'), tr('头像', 'Avatar'), ''],
  ];
  for (const item of panel.items) {
    const flags = [
      item.isCurrent ? tr('当前', 'current') : '',
      item.isDefault ? tr('默认', 'default') : '',
    ].filter(Boolean);
    rows.push([
      item.persona.personaId,
      item.persona.name || tr('（未命名）', '(unnamed)'),
      GENDER_LABEL[item.persona.gender] ?? tr('未知', 'unknown'),
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
        tr(
          `本机记着一次结果未知的新建：人设「${pending.name}」（头像用请求 ${requestId} 的第 ${pending.index} 张）。上面有它就是已经建好了，不要再新建；没有的话，yomi persona avatar --resume ${requestId} --pick ${pending.index} 会先请你确认再建。`,
          `This machine recorded a persona creation with an unknown outcome: persona "${pending.name}" (avatar: image ${pending.index} of request ${requestId}). If it is listed above, it was created, so do not create it again; if not, yomi persona avatar --resume ${requestId} --pick ${pending.index} will ask you to confirm before creating it.`,
        ),
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
        tr(
          `本机有 ${open.length} 次头像生成还没有最终结果，继续查看：yomi persona avatar --resume ${latest}`,
          `${open.length} avatar generation(s) on this machine have no final result yet. To keep watching: yomi persona avatar --resume ${latest}`,
        ),
      ),
    );
  }
}

// ---- avatar: options, target ------------------------------------------------------------------

function priceLabel(price: number | null): string {
  if (price === null) return tr('价格不明', 'price unknown');
  return price === 0 ? tr('免费', 'free') : tr(`${price} 钻石/张`, `${price} gems/image`);
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
    warn(
      io,
      tr(
        '暂时没有可用的头像生成模型：这项功能还没有开放。',
        'No avatar generation model is available: this feature is not open yet.',
      ),
    );
    return;
  }
  say(
    io,
    tr(
      '模型（--model，第一个是默认；价格按成功的张数计，失败或未通过内容检查的不计费）：',
      'Models (--model; the first is the default; priced per successful image, and images that fail or do not pass the content check are not charged):',
    ),
  );
  config.models.forEach((model, index) =>
    say(
      io,
      `  ${paint(io, 'bold', model.modelId)}  ${model.name}  ${priceLabel(model.price)}${index === 0 ? paint(io, 'dim', tr('（默认）', ' (default)')) : ''}`,
    ),
  );
  if (config.styles.length) {
    say(io, tr('风格（--style，可不选）：', 'Styles (--style, optional):'));
    for (const style of config.styles)
      say(io, `  ${paint(io, 'bold', style.styleId)}  ${style.name}`);
  } else say(io, tr('风格：暂无', 'Styles: none'));
  say(
    io,
    tr(
      `每次最多 ${config.maxImageCnt} 张（--count，默认 ${config.maxImageCnt}）`,
      `Up to ${config.maxImageCnt} images per run (--count, default ${config.maxImageCnt})`,
    ),
  );
}

/** The target from `--persona` / `--new`, null when neither was given. */
function targetFrom(options: PersonaCommandOptions): AvatarTarget | null {
  const newFields = Boolean(options.name || options.gender || options.age !== null);
  if (options.persona && options.create)
    throw new UsageError(
      tr('--persona 和 --new 只能选一个', 'Use either --persona or --new, not both'),
    );
  if (!options.create && newFields)
    throw new UsageError(
      tr(
        '--name / --gender / --age 只在 --new 新建人设时使用',
        '--name / --gender / --age are only used with --new (creating a persona)',
      ),
    );
  if (options.persona) {
    const id = options.persona.trim();
    if (!/^[1-9][0-9]{0,18}$/.test(id))
      throw new UsageError(
        tr(
          '--persona 需要人设 ID（yomi persona list 查看）',
          '--persona needs a persona ID (see yomi persona list)',
        ),
      );
    return { kind: 'persona', personaId: id };
  }
  if (!options.create) return null;
  const name = options.name.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME)
    throw new UsageError(
      tr(
        `--new 需要 --name（1–${MAX_NAME} 个字）`,
        `--new needs --name (1–${MAX_NAME} characters long)`,
      ),
    );
  const genderKey = options.gender.trim().toLowerCase();
  // Own keys only: `constructor` or `toString` must not pass as a gender.
  const gender = Object.hasOwn(GENDER_NAMES, genderKey) ? GENDER_NAMES[genderKey] : 0;
  if (!gender)
    throw new UsageError(
      tr(
        '--new 需要 --gender：male、female 或 other',
        '--new needs --gender: male, female or other',
      ),
    );
  if (options.age === null)
    throw new UsageError(tr('--new 需要 --age（18–150）', '--new needs --age (18–150)'));
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
      throw new UsageError(
        tr(
          `没有 ID 为 ${target.personaId} 的人设（yomi persona list 查看）`,
          `No persona with ID ${target.personaId} (see yomi persona list)`,
        ),
      );
    return tr(
      `人设「${item.persona.name}」（${item.persona.personaId}）`,
      `persona "${item.persona.name}" (${item.persona.personaId})`,
    );
  }
  if (target.kind === 'new') {
    if (!panel.rules.canCreate)
      throw new UsageError(
        tr(
          `人设数量已达上限（最多 ${panel.rules.maxPersonaCnt} 个），不能再新建；可以用 --persona ID 换掉已有人设的头像`,
          `You have reached the persona limit (${panel.rules.maxPersonaCnt}), so no new persona can be created; use --persona ID to replace an existing persona's avatar`,
        ),
      );
    return tr(
      `新人设「${target.name}」（${GENDER_LABEL[target.gender]}，${target.age} 岁）`,
      `new persona "${target.name}" (${GENDER_LABEL[target.gender]}, age ${target.age})`,
    );
  }
  const item = currentPersona(panel);
  if (!item) {
    if (needed)
      throw new UsageError(
        tr(
          '找不到当前使用的人设，请用 --persona ID 或 --new 指定',
          'Cannot find the persona in use; choose one with --persona ID or --new',
        ),
      );
    return '';
  }
  return tr(
    `当前使用的人设「${item.persona.name}」（${item.persona.personaId}）`,
    `the persona in use, "${item.persona.name}" (${item.persona.personaId})`,
  );
}

function targetLabel(target: AvatarTarget): string {
  if (target.kind === 'persona')
    return tr(`人设 ${target.personaId}`, `persona ${target.personaId}`);
  if (target.kind === 'new') return tr(`新人设「${target.name}」`, `new persona "${target.name}"`);
  return tr('当前使用的人设', 'the persona in use');
}

function resumeCommand(run: AvatarRun): string {
  return `yomi persona avatar --resume ${run.requestId}`;
}

function describeError(error: unknown): string {
  if (error instanceof UgcFailure)
    return error.message && error.message !== error.code
      ? tr(`${error.code}：${error.message}`, `${error.code}: ${error.message}`)
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
      tr(
        `没有模型 ${wanted}，可用：${config.models.map((item) => item.modelId).join('、')}`,
        `No model ${wanted}; available: ${config.models.map((item) => item.modelId).join(', ')}`,
      ),
    );
  return model;
}

function pickStyle(config: AvatarConfig, wanted: string) {
  if (!wanted) return null;
  const style = config.styles.find((item) => item.styleId === wanted);
  if (!style)
    throw new UsageError(
      config.styles.length
        ? tr(
            `没有风格 ${wanted}，可用：${config.styles.map((item) => item.styleId).join('、')}`,
            `No style ${wanted}; available: ${config.styles.map((item) => item.styleId).join(', ')}`,
          )
        : tr('现在没有可选的风格，去掉 --style', 'No styles are available now; drop --style'),
    );
  return style;
}

async function generate(session: Session) {
  const { context, options, io, state } = session;
  const { gateway } = context;
  const prompt = options.prompt.trim();
  if (!prompt)
    throw new UsageError(
      tr(
        '需要描述：yomi persona avatar -p "描述"（--options 查看模型和风格）',
        'A description is needed: yomi persona avatar -p "description" (--options lists the models and styles)',
      ),
    );
  const length = [...prompt].length;
  if (length > MAX_PROMPT)
    throw new UsageError(
      tr(
        `描述最多 ${MAX_PROMPT} 个字（现在 ${length} 个）`,
        `The description can be at most ${MAX_PROMPT} characters (it has ${length})`,
      ),
    );
  const target = session.override ?? { kind: 'current' };
  // Local checks first: a bad reference file costs nothing.
  const reference = options.reference ? prepareReference(options.reference) : null;
  const config = await readAvatarConfig(gateway);
  if (!config.models.length)
    return notSent(
      session,
      tr(
        '暂时没有可用的头像生成模型（这项功能还没有开放）。没有发出请求。',
        'No avatar generation model is available (this feature is not open yet). No request was sent.',
      ),
    );
  const model = pickModel(config, options.model);
  const style = pickStyle(config, options.style);
  const count = options.count ?? config.maxImageCnt;
  if (count > config.maxImageCnt)
    throw new UsageError(
      tr(
        `--count 最多 ${config.maxImageCnt}（服务端的上限）`,
        `--count can be at most ${config.maxImageCnt} (the server's limit)`,
      ),
    );
  if (options.pick !== null && options.pick > count)
    throw new UsageError(
      tr(
        `--pick 不能大于张数 ${count}`,
        `--pick cannot be greater than the number of images (${count})`,
      ),
    );
  if (model.price === null)
    return notSent(
      session,
      tr(
        '服务端返回的价格读不懂，为避免扣费出错没有继续。',
        'Could not read the price the server returned; stopped to avoid a wrong charge.',
      ),
    );
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
      tr(
        `同样的请求上次结果未知（请求号 ${requestId}）。为避免重复扣费，没有发新请求。用原来的请求号继续：${resumeCommand(run)}`,
        `The same request had an unknown outcome last time (request ID ${requestId}). To avoid a double charge, no new request was sent. Continue with the original request ID: ${resumeCommand(run)}`,
      ),
    );
    return finish(
      session,
      { status: 'unknown', request_id: requestId, resume: resumeCommand(run) },
      1,
    );
  }

  say(
    io,
    tr(
      `生成人设头像（${describeEnvironment(context.env)}）`,
      `Generating persona avatars (${describeEnvironment(context.env)})`,
    ),
  );
  say(
    io,
    tr(
      `模型：${model.name}${style ? `　风格：${style.name}` : ''}　张数：${count}${reference ? '　带参考图' : ''}`,
      `Model: ${model.name}${style ? `  Style: ${style.name}` : ''}  Images: ${count}${reference ? '  With a reference image' : ''}`,
    ),
  );
  if (destination)
    say(io, tr(`选中的图片会写进：${destination}`, `The picked image will go to: ${destination}`));
  const total = model.price * count;
  const agreed = await confirmSpend(io, gateway, {
    action: tr(`生成 ${count} 张人设头像`, `Generate ${count} persona avatar(s)`),
    total,
    unit: { price: model.price, count, label: tr('张', 'image') },
    acceptPrice: options.acceptPrice,
    notes: [
      tr(
        '按成功的张数扣钻石：生成失败或没有通过内容检查的那张不计费。上面是全部成功时的总价。',
        'Gems are charged per successful image: an image that fails or does not pass the content check is not charged. The total above is the price if every image succeeds.',
      ),
    ],
  });
  if (!agreed) return notSent(session, tr('没有发出生成请求。', 'No generation request was sent.'));
  if (
    !(await confirmProduction(
      { ...context, io },
      tr(
        `生成人设头像（最多 ${total} 钻石）并写进人设`,
        `generate persona avatars (up to ${total} gems) and write one to a persona`,
      ),
      options.confirmProd,
    ))
  )
    return notSent(
      session,
      tr('已取消，没有发出生成请求。', 'Cancelled; no generation request was sent.'),
    );
  session.production = true;

  let objectKey = '';
  if (reference) {
    say(io, paint(io, 'dim', tr('上传参考图…', 'Uploading the reference image…')));
    try {
      objectKey = await uploadReference(gateway, reference.jpeg, context.fetch);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      warn(
        io,
        tr(
          `参考图上传失败（${describeError(error)}）。`,
          `Uploading the reference image failed (${describeError(error)}).`,
        ),
      );
      return notSent(
        session,
        tr('没有发出生成请求，没有扣费。', 'No generation request was sent; nothing was charged.'),
      );
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
      tr(
        `同样的请求刚由另一个 yomi 进程发出（请求号 ${claimed.key}），结果还没回来：这里没有再发，没有扣费。用原来的请求号继续：${resumeCommand(claimed.value)}`,
        `Another yomi process just sent the same request (request ID ${claimed.key}) and its result has not come back: nothing was sent here and nothing was charged. Continue with the original request ID: ${resumeCommand(claimed.value)}`,
      ),
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
      tr(
        `本机没有请求号 ${requestId} 的人设头像生成记录（--resume 只能继续这台电脑上、这个账号发起的生成）`,
        `No persona avatar generation with request ID ${requestId} on this machine (--resume only continues generations started on this machine with this account)`,
      ),
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
      tr(
        '--resume 继续的是当时的请求：-p / --model / --style / --count / --reference 不起作用。',
        '--resume continues the original request: -p / --model / --style / --count / --reference have no effect.',
      ),
    );
  if (session.override) {
    run.target = session.override;
    state.setRecord(RUN_KIND, run.requestId, run);
  }
  if (run.state === 'pending') {
    say(
      io,
      tr(
        `请求 ${run.requestId} 上次的结果未知，现在原样重发（同一个请求号、同一个请求体）。`,
        `Request ${run.requestId} had an unknown outcome last time; resending it unchanged (same request ID, same body).`,
      ),
    );
    // A replay the server never saw is charged at today's price: a price above every one agreed
    // is shown with the balance and needs a new yes.
    const config = await readAvatarConfig(session.context.gateway);
    const model = config.models.find((item) => item.modelId === run.request.model_id);
    const price = model ? model.price : run.unitPrice;
    if (price === null)
      return notSent(
        session,
        tr(
          '服务端返回的价格读不懂，为避免扣费出错没有重发。',
          'Could not read the price the server returned; not resent, to avoid a wrong charge.',
        ),
      );
    const count = run.request.image_cnt;
    const agreedPrice = Math.max(...sentPrices(run));
    if (price > agreedPrice) {
      warn(
        io,
        tr(
          `这个模型的单价从 ${agreedPrice} 变成了 ${price} 钻石/张，需要重新确认。`,
          `This model's price changed from ${agreedPrice} to ${price} gems/image; please confirm again.`,
        ),
      );
      const agreed = await confirmSpend(io, session.context.gateway, {
        action: tr(
          `重发生成 ${count} 张人设头像`,
          `Resend the request to generate ${count} persona avatar(s)`,
        ),
        total: price * count,
        unit: { price, count, label: tr('张', 'image') },
        acceptPrice: options.acceptPrice,
        notes: [
          tr(
            '上次已受理的话，重发只取回原来的任务，不会再扣费；上次没有收到，就按新价格、按成功的张数扣钻石（以钱包记录为准）。',
            'If the last request was accepted, the resend only fetches the original tasks and charges nothing more; if it never arrived, gems are charged at the new price per successful image (your wallet history is authoritative).',
          ),
        ],
        replay: true,
      });
      if (!agreed)
        return notSent(
          session,
          tr(
            '没有重发，这次生成仍记在本机。',
            'Not resent; this generation is still recorded on this machine.',
          ),
        );
    } else
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            `服务端按请求号去重：上次已受理就返回原来的任务，不会再扣费；上次没有收到，就按现在的单价生成（${price > 0 ? `${price} 钻石/张，全部成功共 ${price * count} 钻石，按成功的张数计` : '免费'}）。`,
            `The server deduplicates by request ID: if the last request was accepted, it returns the original tasks and charges nothing more; if it never arrived, it generates at the current price (${price > 0 ? `${price} gems/image, ${price * count} gems if every image succeeds, charged per successful image` : 'free'}).`,
          ),
        ),
      );
    if (
      !(await confirmProduction(
        { ...session.context, io },
        tr('重发一次人设头像生成请求', 'resend a persona avatar generation request'),
        options.confirmProd,
      ))
    )
      return notSent(session, tr('已取消，没有重发。', 'Cancelled; nothing was resent.'));
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
    tr(
      `继续查看请求 ${run.requestId}：${run.modelName}${run.styleName ? `、${run.styleName}` : ''}，${run.request.image_cnt} 张（不会再扣费）`,
      `Watching request ${run.requestId}: ${run.modelName}${run.styleName ? `, ${run.styleName}` : ''}, ${run.request.image_cnt} image(s) (no further charge)`,
    ),
  );
  return follow(session, run, []);
}

/** Sends the frozen create request (first time or replay) and follows its tasks. */
async function submit(session: Session, run: AvatarRun, replay: boolean) {
  const { context, io, state } = session;
  say(
    io,
    paint(
      io,
      'dim',
      replay
        ? tr(`重发请求 ${run.requestId}…`, `Resending request ${run.requestId}…`)
        : tr('提交生成请求…', 'Submitting the generation request…'),
    ),
  );
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
        tr(
          `生成请求 ${run.requestId} 的结果未知，已记在本机。重新 yomi login 后运行 ${resumeCommand(run)}，用同一个请求号继续（不会重复扣费）。`,
          `The outcome of generation request ${run.requestId} is unknown; it is recorded on this machine. After you run yomi login again, run ${resumeCommand(run)} to continue with the same request ID (no double charge).`,
        ),
      );
      throw outcome;
    }
    return unknownOutcome(session, run, describeError(error), conflict);
  }
  if (!tasks.length)
    return unknownOutcome(session, run, tr('回包里没有任务', 'the response has no tasks'), false);
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
    tr(
      `${replay ? '服务端已受理（同一个请求号）' : '已提交'}：${tasks.length} 张，请求号 ${run.requestId}`,
      `${replay ? 'Accepted by the server (same request ID)' : 'Submitted'}: ${tasks.length} image(s), request ID ${run.requestId}`,
    ),
  );
  await follow(session, run, tasks);
}

function unknownOutcome(session: Session, run: AvatarRun, reason: string, conflict: boolean) {
  const { io } = session;
  warn(
    io,
    tr(
      `生成请求的结果未知（${reason}）：服务端可能已经受理，也可能没有。CLI 不会自动重发，也不会换新的请求号。`,
      `The generation request's outcome is unknown (${reason}): the server may or may not have accepted it. The CLI will not resend it on its own or switch to a new request ID.`,
    ),
  );
  if (conflict)
    warn(
      io,
      tr(
        `服务端说请求号 ${run.requestId} 已经用在了另一个请求体上：之前有一次请求带着它，可能已经受理并扣了钻石，所以这不算被拒。本机仍保留这次生成的记录和请求号。可以先在 Yomi App 的钱包记录里看看有没有这笔扣费。`,
        `The server says request ID ${run.requestId} is already used with a different request body: an earlier request carried it and may have been accepted and charged, so this is not a refusal. This machine keeps the record of this generation and its request ID. You can check your wallet history in the Yomi app for this charge first.`,
      ),
    );
  say(
    io,
    tr(
      `用同一个请求号继续（服务端按请求号去重，不会重复扣费）：${resumeCommand(run)}`,
      `Continue with the same request ID (the server deduplicates by request ID, so no double charge): ${resumeCommand(run)}`,
    ),
  );
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
      ? tr(`${refusal.code}：${refusal.message}`, `${refusal.code}: ${refusal.message}`)
      : refusal.code;
  const why =
    refusal.kind === 'gems'
      ? tr('钻石不足', 'not enough gems')
      : refusal.kind === 'rateLimited'
        ? tr(
            '生成太频繁或同时进行的任务太多',
            'too many generations, or too many tasks running at once',
          )
        : refusal.kind === 'unavailable'
          ? tr('这项生成功能暂时不可用', 'this generation feature is unavailable for now')
          : tr('服务端拒绝', 'refused by the server');
  const when =
    refusal.kind === 'gems'
      ? tr('充值后', 'after topping up')
      : refusal.kind === 'rateLimited' || refusal.kind === 'unavailable'
        ? tr('过一会儿', 'in a little while')
        : tr('稍后', 'later');
  warn(
    io,
    tr(
      `这次重发被拒了：${why}（${detail}）。这次重发本身没有扣费。`,
      `This resend was refused: ${why} (${detail}). The resend itself was not charged.`,
    ),
  );
  warn(
    io,
    tr(
      `但上次那次的结果一直未知，可能已经受理并扣了钻石，所以本机没有删除这次生成：记录和请求号 ${run.requestId} 都还在，以后重发仍用同一个请求号，服务端按请求号去重，最多扣一次。`,
      `But the earlier send's outcome is still unknown and it may have been accepted and charged, so this generation was not deleted from this machine: the record and request ID ${run.requestId} are kept, a later resend uses the same request ID, and the server deduplicates by request ID, so you are charged at most once.`,
    ),
  );
  say(
    io,
    tr(
      `可以先在 Yomi App 的钱包记录里看看有没有这笔扣费。${when}再试：${resumeCommand(run)}`,
      `You can check your wallet history in the Yomi app for this charge first. Try again ${when}: ${resumeCommand(run)}`,
    ),
  );
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
  get succeeded() {
    return tr('成功', 'succeeded');
  },
  get failed() {
    return tr('生成失败', 'generation failed');
  },
  get sensitive() {
    return tr('没有通过内容检查', 'did not pass the content check');
  },
  get incomplete() {
    return tr(
      '服务端标为成功但没有返回可用的图片',
      'marked succeeded by the server, but no usable image was returned',
    );
  },
  get running() {
    return tr('还在生成', 'still generating');
  },
};

function progressLine(tasks: AvatarTask[]): string {
  const done = tasks.filter((task) => isFinal(task.status)).length;
  return tr(
    `生成中：${done}/${tasks.length} 张已出结果…`,
    `Generating: ${done}/${tasks.length} image(s) done…`,
  );
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
      onError: (error) =>
        warn(
          io,
          tr(
            `查询进度失败（${describeError(error)}），继续重试…`,
            `Could not check progress (${describeError(error)}); retrying…`,
          ),
        ),
      signal: stop.signal,
    },
  ).finally(() => process.removeListener('SIGINT', onSignal));
  const stopped = stop.signal.aborted;
  if (stopped) say(io, tr('已停止查看。', 'Stopped watching.'));
  if (readings === 0) {
    warn(
      io,
      tr(
        '一直查不到生成进度。停止查看不会取消服务端的生成。',
        'Could not get the generation progress. Stopping here does not cancel the generation on the server.',
      ),
    );
    say(
      io,
      tr(`稍后继续查看：${resumeCommand(run)}`, `Keep watching later: ${resumeCommand(run)}`),
    );
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
  say(io, tr('结果：', 'Results:'));
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
    const head = tr(`  第 ${task.index} 张：`, `  Image ${task.index}: `);
    if (outcome === 'succeeded')
      say(
        io,
        head +
          paint(io, 'green', tr('✓ 成功', '✓ succeeded')) +
          (file
            ? `  ${file}`
            : paint(
                io,
                'yellow',
                tr(
                  `（下载失败：${downloadError}；可以稍后 --resume 再下载）`,
                  ` (download failed: ${downloadError}; you can download it later with --resume)`,
                ),
              )),
      );
    else if (outcome === 'failed')
      say(
        io,
        head +
          paint(
            io,
            'red',
            tr(
              `✗ 生成失败${reason ? `（${reason}）` : ''}`,
              `✗ generation failed${reason ? ` (${reason})` : ''}`,
            ),
          ) +
          tr('，这张不计费', ', not charged'),
      );
    else if (outcome === 'sensitive')
      say(
        io,
        head +
          paint(io, 'red', tr('✗ 没有通过内容检查', '✗ did not pass the content check')) +
          tr('，这张不计费', ', not charged'),
      );
    else if (outcome === 'incomplete')
      say(
        io,
        head +
          paint(io, 'red', `✗ ${OUTCOME_LABEL.incomplete}`) +
          tr(
            '，不能选用（是否计费以钱包记录为准）',
            ', cannot be picked (your wallet history shows whether it was charged)',
          ),
      );
    else say(io, head + paint(io, 'dim', tr('… 还在生成', '… still generating')));
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

  const parts = [tr(`成功 ${counts.succeeded}`, `${counts.succeeded} succeeded`)];
  if (counts.failed) parts.push(tr(`生成失败 ${counts.failed}`, `${counts.failed} failed`));
  if (counts.sensitive)
    parts.push(
      tr(
        `没有通过内容检查 ${counts.sensitive}`,
        `${counts.sensitive} did not pass the content check`,
      ),
    );
  if (counts.incomplete)
    parts.push(tr(`结果不完整 ${counts.incomplete}`, `${counts.incomplete} incomplete`));
  if (counts.running)
    parts.push(tr(`还在生成 ${counts.running}`, `${counts.running} still generating`));
  say(
    io,
    tr(
      `共 ${tasks.length} 张：${parts.join('，')}。`,
      `${tasks.length} image(s) in all: ${parts.join(', ')}.`,
    ),
  );
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
      tr(
        `${counts.running ? '目前' : ''}按成功的 ${billed} 张计费，单价不确定：这个请求先后在 ${prices.join(' 和 ')} 钻石/张时发出，按哪个价取决于服务端受理的是哪一次，CLI 无法判断。实际扣了多少以钱包记录为准。失败和没有通过内容检查的不计费。`,
        `${counts.running ? 'So far charged' : 'Charged'} for ${billed} successful image(s), at an uncertain price: this request was sent at ${prices.join(' and ')} gems/image, and which price applies depends on which send the server accepted, which the CLI cannot tell. Your wallet history shows the actual charge. Images that failed or did not pass the content check are not charged.`,
      ),
    );
  else if (unitPrice > 0)
    say(
      io,
      tr(
        `${counts.running ? '目前' : ''}按成功的 ${billed} 张计费：${charged} 钻石（${unitPrice} 钻石/张）${counts.incomplete ? `，含 ${counts.incomplete} 张服务端标为成功但没返回图片的` : ''}。失败和没有通过内容检查的不计费；如果是先扣后退，退回以钱包记录为准。`,
        `${counts.running ? 'So far charged' : 'Charged'} for ${billed} successful image(s): ${charged} gems (${unitPrice} gems/image)${counts.incomplete ? `, including ${counts.incomplete} the server marked succeeded without returning an image` : ''}. Images that failed or did not pass the content check are not charged; if gems were charged and then refunded, your wallet history shows the refund.`,
      ),
    );
  else say(io, tr('这个模型免费。', 'This model is free.'));
  if (counts.running)
    say(
      io,
      paint(
        io,
        'yellow',
        tr(
          `还有 ${counts.running} 张在生成。停止查看不会取消服务端的生成（成功的照样计费）；继续查看：${resumeCommand(run)}`,
          `${counts.running} image(s) still generating. Stopping here does not cancel the generation on the server (successful images are still charged); to keep watching: ${resumeCommand(run)}`,
        ),
      ),
    );

  let code = polled.done && counts.succeeded > 0 ? 0 : 1;
  const usable = tasks.filter((task) => outcomeOf(task) === 'succeeded');
  let applied: Record<string, unknown> | null = null;
  if (stopped) {
    if (usable.length)
      say(
        io,
        tr(
          `之后选一张写进人设：${resumeCommand(run)} --pick <编号>`,
          `To write one to a persona later: ${resumeCommand(run)} --pick <number>`,
        ),
      );
  } else if (options.pick !== null) {
    const chosen = tasks.find((task) => task.index === options.pick);
    if (!chosen || outcomeOf(chosen) !== 'succeeded') {
      warn(
        io,
        tr(
          `第 ${options.pick} 张不能用作头像（${chosen ? OUTCOME_LABEL[outcomeOf(chosen)] : '没有这一张'}），没有写进人设。`,
          `Image ${options.pick} cannot be used as an avatar (${chosen ? OUTCOME_LABEL[outcomeOf(chosen)] : 'no such image'}); nothing was written to a persona.`,
        ),
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
    } else
      say(
        io,
        tr(
          `没有写进人设。之后可以：${resumeCommand(run)} --pick <编号>`,
          `Nothing was written to a persona. Later you can run: ${resumeCommand(run)} --pick <number>`,
        ),
      );
  } else if (usable.length) {
    say(
      io,
      tr(
        `选一张写进人设：${resumeCommand(run)} --pick <编号>（默认写进${targetLabel(run.target)}；也可以加 --persona ID 或 --new --name … --gender … --age …）`,
        `Write one to a persona: ${resumeCommand(run)} --pick <number> (it goes to ${targetLabel(run.target)} by default; you can also add --persona ID or --new --name … --gender … --age …)`,
      ),
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
        tr(
          `✓ 上次新建的人设「${found.name}」（${found.personaId}）已经建好了，头像是第 ${pending.index} 张，没有再建。`,
          `✓ The persona "${found.name}" (${found.personaId}) from the last attempt was created, with image ${pending.index} as its avatar; not created again.`,
        ),
      ),
    );
    if (chosen.assetId !== pending.assetId) {
      warn(
        io,
        tr(
          `这次选的是第 ${chosen.index} 张，没有写进去。要换成它：${resumeCommand(run)} --pick ${chosen.index} --persona ${found.personaId}`,
          `You picked image ${chosen.index} this time; it was not written. To switch to it: ${resumeCommand(run)} --pick ${chosen.index} --persona ${found.personaId}`,
        ),
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
    tr(
      `上次新建人设「${pending.name}」时结果未知，可能已经建好了${panel ? '（人设列表里暂时没有看到它）' : '（人设列表暂时读不到）'}。`,
      `The last attempt to create persona "${pending.name}" had an unknown outcome; it may have been created${panel ? ' (it is not in the persona list yet)' : ' (the persona list cannot be read right now)'}.`,
    ),
  );
  say(
    io,
    tr(
      `先运行 yomi persona list 看看：已经有「${pending.name}」就不要再新建，换头像用 ${resumeCommand(run)} --pick ${chosen.index} --persona <它的 ID>。`,
      `Run yomi persona list first: if "${pending.name}" is there, do not create it again; to change its avatar, use ${resumeCommand(run)} --pick ${chosen.index} --persona <its ID>.`,
    ),
  );
  if (options.createAgain) {
    say(
      io,
      tr(
        `已加 ${CREATE_AGAIN_FLAG}：按你确认的，列表里没有它，再新建一次。`,
        `${CREATE_AGAIN_FLAG} given: as you confirmed it is not in the list, creating it again.`,
      ),
    );
    return 'create';
  }
  if (!context.io.interactive) {
    warn(
      io,
      tr(
        `确认列表里没有之后，再运行一次并加 ${CREATE_AGAIN_FLAG}（非交互运行时代替输入 yes）。这次没有新建人设。`,
        `Once you have confirmed it is not in the list, run again with ${CREATE_AGAIN_FLAG} (it stands in for typing yes when running non-interactively). No persona was created this time.`,
      ),
    );
    return null;
  }
  const answer = await ask(
    io,
    tr(
      `看过 yomi persona list、确认没有「${pending.name}」，要再新建一次？输入 yes 继续：`,
      `Checked yomi persona list and "${pending.name}" is not there? Type yes to create it again: `,
    ),
  );
  if ((answer ?? '').trim().toLowerCase() === 'yes') return 'create';
  say(io, tr('没有新建人设。', 'No persona was created.'));
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
      tr(
        `选一张写进${targetLabel(session.override ?? run.target)}，输入编号（${numbers}；直接回车跳过）：`,
        `Pick one to write to ${targetLabel(session.override ?? run.target)}; enter its number (${numbers}; press Enter to skip): `,
      ),
    );
    const value = answer?.trim() ?? '';
    if (!value) return null;
    const chosen = usable.find((task) => String(task.index) === value);
    if (chosen) return chosen;
    warn(session.io, tr(`没有可选的第 ${value} 张。`, `There is no image ${value} to pick.`));
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
    if (
      !(await confirmProduction(
        { ...context, io },
        tr('修改人设头像', 'change a persona avatar'),
        options.confirmProd,
      ))
    ) {
      say(io, tr('已取消，没有写进人设。', 'Cancelled; nothing was written to the persona.'));
      return null;
    }
    session.production = true;
  }
  if (target.kind === 'new') {
    if (run.applied?.created) {
      warn(
        io,
        tr(
          `这次生成已经新建过人设 ${run.applied.personaId}，没有再建。要换它的头像：${again} --persona ${run.applied.personaId}`,
          `This generation already created persona ${run.applied.personaId}; not created again. To change its avatar: ${again} --persona ${run.applied.personaId}`,
        ),
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
          tr(
            `新建人设失败（${describeError(error)}），没有建成。图片已保存，可以稍后再试：${again}`,
            `Creating the persona failed (${describeError(error)}); it was not created. The images are saved; try again later: ${again}`,
          ),
        );
        return null;
      }
      warn(
        io,
        tr(
          `新建人设的结果未知（${describeError(error)}）：人设「${target.name}」可能已经建好了，本机记下了这次新建。`,
          `The outcome of creating the persona is unknown (${describeError(error)}): persona "${target.name}" may have been created; this machine has recorded the attempt.`,
        ),
      );
      say(
        io,
        tr(
          `先运行 yomi persona list 看看：已经有「${target.name}」就不要再新建（换头像用 ${again} --persona <它的 ID>）；确实没有，再运行 ${again}，CLI 会先请你确认（非交互运行加 ${CREATE_AGAIN_FLAG}）。`,
          `Run yomi persona list first: if "${target.name}" is there, do not create it again (to change its avatar, use ${again} --persona <its ID>); if it really is not, run ${again} again and the CLI will ask you to confirm first (add ${CREATE_AGAIN_FLAG} when running non-interactively).`,
        ),
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
        tr(
          `✓ 已新建人设「${created.name || target.name}」（${created.personaId}），头像用第 ${chosen.index} 张。`,
          `✓ Created persona "${created.name || target.name}" (${created.personaId}) with image ${chosen.index} as its avatar.`,
        ),
      ),
    );
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '新人设不会自动设为默认或当前使用，可以在 App 里切换。',
          'The new persona is not made the default or the one in use automatically; you can switch in the app.',
        ),
      ),
    );
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
      warn(
        io,
        tr(
          `找不到当前使用的人设，没有写进人设。请指定：${again} --persona ID`,
          `Cannot find the persona in use; nothing was written. Choose one: ${again} --persona ID`,
        ),
      );
      return null;
    }
    personaId = item.persona.personaId;
  }
  let saved;
  try {
    saved = await setPersonaAvatar(context.gateway, personaId, chosen.assetId);
  } catch (error) {
    if (error instanceof NotSignedIn) throw error;
    warn(
      io,
      tr(
        `写进人设失败（${describeError(error)}）。图片已保存，可以稍后再试：${again}`,
        `Writing to the persona failed (${describeError(error)}). The images are saved; try again later: ${again}`,
      ),
    );
    return null;
  }
  run.applied = { personaId, assetId: chosen.assetId, index: chosen.index, created: false };
  state.setRecord(RUN_KIND, run.requestId, run);
  say(
    io,
    paint(
      io,
      'green',
      tr(
        `✓ 已把第 ${chosen.index} 张设为人设「${saved.name}」（${saved.personaId || personaId}）的头像。`,
        `✓ Set image ${chosen.index} as the avatar of persona "${saved.name}" (${saved.personaId || personaId}).`,
      ),
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
