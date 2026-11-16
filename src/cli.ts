#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { ApiError, NotSignedIn } from './core/api.js';
import { UsageError } from './core/env.js';
import { redact } from './core/redact.js';
import { type Io, paint, processIo, say } from './core/ui.js';
import { VERSION } from './core/version.js';
import { login, logout, whoami } from './commands/auth.js';
import { check, init, tags, voices } from './commands/catalog.js';
import { createContext, type GlobalOptions } from './commands/context.js';
import { create } from './commands/create.js';
import { image } from './commands/image.js';
import { persona } from './commands/persona.js';
import { preview } from './commands/preview.js';
import { relay } from './commands/relay.js';
import { video } from './commands/video.js';
import { UgcFailure } from './ugc/api.js';
import { ImageError } from './ugc/imageFile.js';
import {
  type CharacterSpec,
  emptySpec,
  loadSpecFile,
  SpecError,
  specFromObject,
} from './ugc/spec.js';

const HELP = `yomi ${VERSION} — Yomi 命令行工具

用法：yomi <命令> [选项]

命令：
  login              通过网页授权登录（打开浏览器，在网页上确认）
  logout             退出登录，撤销并删除本机凭证
  whoami             显示当前登录的账号
  init [文件]        生成角色文件模板（默认 character.yaml）
  check -f <文件>    按 App 规则检查角色文件（不联网）
  voices             列出可选声音
  tags               列出可选标签
  create -f <文件>   创建角色
  preview -f <文件>  在终端里和草稿角色试聊（不创建角色）
  image -p <描述>    AI 生成角色图片（封面 / 头像），按张扣钻石
  video -f <文件>    AI 生成角色视频（动态封面 / 介绍视频），按报价扣钻石
  persona list       你的聊天人设（主控）
  persona avatar     AI 生成人设头像
  relay --telegram   把你自己的 Telegram bot 私聊转给已发布的 Yomi 角色（实验）

全局选项：
  --env <prod|test>  环境，默认 prod（生产，创建和花钻石前要再确认）；test 需自己配置地址
                     （YOMI_TEST_API_ORIGIN / YOMI_TEST_WEB_ORIGIN）
  --lane <名称>      测试环境的泳道，加 Lane 请求头
  --debug            打印请求日志（凭证已脱敏）
  -h, --help         帮助；yomi <命令> --help 查看命令选项
  -v, --version      版本

示例：
  yomi login
  yomi init lin-xia.yaml && yomi check -f lin-xia.yaml
  yomi preview -f lin-xia.yaml
  yomi create -f lin-xia.yaml
`;

const COMMAND_HELP: Record<string, string> = {
  login: `yomi login [--no-browser] [--timeout 秒]
  打开 Yomi 网页的授权页，确认码一致后点「授权」。CLI 会建立自己的会话，不影响 App 和网页的登录。
  --no-browser   只打印授权地址，不自动打开浏览器
  --timeout      等待授权的秒数，默认 300`,
  create: `yomi create -f <文件> [字段选项] [--accept-declaration] [--dry-run] [--new] [--confirm-prod]
  按文件创建一个角色（字段规则同 App）。会先确认 18+ 与版权声明，再上传并审核图片、提交。
  --accept-declaration  非交互运行时明确确认声明
  --dry-run             只打印请求体，不创建（图片仍会上传审核）
  --new                 同一文件内容已创建过时，再创建一个新角色
  --confirm-prod        非交互在生产环境运行时明确确认
${'  '}字段选项（覆盖文件里的值）：--name --gender --description --opening --background
  --visibility --voice --tag（可重复）--cover --avatar`,
  preview: `yomi preview -f <文件> [字段选项] [-m 消息 ...] [--allow-paid] [--accept-declaration]
  用文件里的草稿内容开一个临时预演会话（与 App 的「预览」相同），流式显示回复。
  先显示服务端返回的免费条数；用完后发送会按标准费率扣钻石，扣之前必须输入 yes 确认。
  -m, --message         非交互：依次发送这些消息，收完回复后退出
  --allow-paid          非交互时允许免费条数用完后继续付费发送
  --reply-timeout       等待一条回复的秒数，默认 90，超时后改为读取消息记录
  --accept-declaration  非交互运行时明确确认声明`,
  image: `yomi image -p <描述> [--count N] [--model ID] [--style ID] [--reference 图片] [选项]
  用 AI 生成角色图片，下载原图并裁好封面（1:2）和头像（1:1）。先显示单价、张数、总价和余额，
  输入 yes（或 --accept-price）才扣钻石；生成失败的那张自动退款。
  --options            列出可用模型、风格、比例和价格（不扣费）
  --count N            张数（1–4，默认 4）
  --model / --style    模型、风格（默认第一个模型、不选风格）
  --ratio R            比例（默认 9:16，没有就用第一个）
  --reference 图片      参考图（先上传审核）
  --out 目录           保存位置，默认 ./yomi-media
  --pick N --into 文件 --as cover|avatar|both
                       把第 N 张裁好的图写进角色文件的 cover/avatar（保留注释）
  --resume 批次|请求    继续之前的一次：已受理的只查看和下载，不再扣费；答复未知的请求
                       会原样重发（同一请求 ID，最多扣一次）
  --resume ID --forget 放弃本机对这个请求或批次的跟踪（不取消、不退款；同样的命令会重新扣费）
  --accept-price       非交互时同意显示的价格
  --json               输出 JSON`,
  video: `yomi video -f <角色文件> [--template ID | --prompt 描述] [--duration 秒] [选项]
  用 AI 为角色生成视频。首帧默认取角色封面（裁成 9:16），先上传首帧、拿到报价，显示价格和余额，
  输入 yes（或 --accept-price）才创建任务扣钻石；失败自动退款。结果记在本机，下次 yomi create
  这个角色文件时一起提交（yomi preview 试聊不带视频）。
  --options            列出模板、时长和展示价（不扣费）
  --template ID        模板；不写则为自定义（--prompt 描述）
  --duration 秒        时长（默认用模板或自定义的默认值）
  --frame 图片         自己指定首帧（JPEG/PNG，会裁成 9:16）
  --as dynamic-cover|intro-video   用作动态封面（默认）或介绍视频
  --list               列出这个角色文件生成过的视频任务
  --resume 请求ID       继续之前的任务：已受理的只查看，不再扣费；答复未知的请求会原样重发
                       （同一请求 ID，最多扣一次）
  --out 目录           保存预览视频，默认 ./yomi-media
  --accept-price / --confirm-prod / --json`,
  persona: `yomi persona list
yomi persona avatar -p <描述> [--persona ID | --new --name 名字 --gender male|female|other --age N] [选项]
  AI 生成聊天人设（主控）头像，选一张写进人设。先显示单价、张数、总价和余额，输入 yes 才扣钻石；
  失败或未通过内容检查的那张不扣费。
  --options            列出可用模型和风格（不扣费）
  --count N            张数（默认按服务端上限）
  --reference 图片      参考图
  --pick N             直接用第 N 张；不写时交互选择，非交互只下载不写入
  --out 目录           保存位置，默认 ./yomi-media
  --resume 请求ID       继续之前的一次生成：已受理的只查看，不再扣费；答复未知的请求会原样
                       重发（同一请求 ID，最多扣一次）
  --create-again       新建人设的结果未知、persona list 里确认没有它时，非交互地再建一次
  --accept-price / --confirm-prod / --json`,
  relay: `yomi relay --telegram [--character ID] [--max-spend 钻石] [选项]
  用你在 @BotFather 建的 bot，把你本人在 Telegram 私聊里发的消息转给 Yomi 角色，流式回复。
  只服务配对过的本人。默认不花钻石：付费要先在 Telegram 里用 /budget 设预算并点按钮确认，
  累计不超过本机的 --max-spend。服务端支持「只用免费额度」之前，没设预算不会发出任何消息。
  详见 docs/relay.md。
  --set-token           设置或更换 bot token（终端里输入，不显示；或配合 --token-stdin）
  --token-stdin         从标准输入读 token（不接受命令行参数和环境变量）
  --pair                重新配对（会显示新的配对码）
  --character ID        启动时使用的角色
  --max-spend 数量      本机允许 relay 累计花的钻石上限，默认 0：不花钻石
  --reset-spend         重新计算本机上限的累计花费
  --allow-file-store    没有系统钥匙串时，允许把 token 和会话存成 0600 文件
  --install-service     安装为后台服务（macOS launchd / Linux systemd --user），需先配对
  --uninstall-service   停止并删除后台服务
  --service-status      查看后台服务状态
  --forget              删除本机保存的 bot token 和配对信息
  --reply-timeout 秒    等一条回复的时间，默认 120，超时后读消息记录
  --no-drafts           不用流式草稿，改为编辑消息
  --confirm-prod        非交互在生产环境运行时明确确认`,
  check: `yomi check -f <文件> [字段选项]
  按 App 的必填项和长度限制检查角色文件，不联网。`,
  init: `yomi init [文件] [--force]
  写一份角色文件模板。`,
  voices: `yomi voices [--json]`,
  tags: `yomi tags [--query 关键词] [--json]`,
  logout: `yomi logout`,
  whoami: `yomi whoami`,
};

const GLOBAL: ParseArgsConfig['options'] = {
  env: { type: 'string' },
  lane: { type: 'string' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const SPEC: ParseArgsConfig['options'] = {
  file: { type: 'string', short: 'f' },
  name: { type: 'string' },
  gender: { type: 'string' },
  description: { type: 'string' },
  opening: { type: 'string' },
  background: { type: 'string' },
  visibility: { type: 'string' },
  voice: { type: 'string' },
  tag: { type: 'string', multiple: true },
  cover: { type: 'string' },
  avatar: { type: 'string' },
  'accept-declaration': { type: 'boolean' },
  'confirm-prod': { type: 'boolean' },
};

const OPTIONS: Record<string, ParseArgsConfig['options']> = {
  login: { 'no-browser': { type: 'boolean' }, timeout: { type: 'string' } },
  logout: {},
  whoami: {},
  init: { force: { type: 'boolean' } },
  check: SPEC,
  voices: { json: { type: 'boolean' } },
  tags: { json: { type: 'boolean' }, query: { type: 'string' } },
  create: { ...SPEC, 'dry-run': { type: 'boolean' }, new: { type: 'boolean' } },
  relay: {
    telegram: { type: 'boolean' },
    'set-token': { type: 'boolean' },
    'token-stdin': { type: 'boolean' },
    pair: { type: 'boolean' },
    forget: { type: 'boolean' },
    character: { type: 'string' },
    'max-spend': { type: 'string' },
    'allow-file-store': { type: 'boolean' },
    'install-service': { type: 'boolean' },
    'uninstall-service': { type: 'boolean' },
    'service-status': { type: 'boolean' },
    'reply-timeout': { type: 'string' },
    'no-drafts': { type: 'boolean' },
    'confirm-prod': { type: 'boolean' },
    'reset-spend': { type: 'boolean' },
  },
  image: {
    prompt: { type: 'string', short: 'p' },
    model: { type: 'string' },
    style: { type: 'string' },
    count: { type: 'string' },
    ratio: { type: 'string' },
    reference: { type: 'string' },
    out: { type: 'string' },
    pick: { type: 'string' },
    into: { type: 'string' },
    as: { type: 'string' },
    resume: { type: 'string' },
    forget: { type: 'boolean' },
    options: { type: 'boolean' },
    'accept-price': { type: 'boolean' },
    'confirm-prod': { type: 'boolean' },
    json: { type: 'boolean' },
  },
  video: {
    ...SPEC,
    template: { type: 'string' },
    prompt: { type: 'string', short: 'p' },
    duration: { type: 'string' },
    frame: { type: 'string' },
    as: { type: 'string' },
    out: { type: 'string' },
    list: { type: 'boolean' },
    resume: { type: 'string' },
    options: { type: 'boolean' },
    'accept-price': { type: 'boolean' },
    json: { type: 'boolean' },
  },
  persona: {
    prompt: { type: 'string', short: 'p' },
    persona: { type: 'string' },
    new: { type: 'boolean' },
    name: { type: 'string' },
    gender: { type: 'string' },
    age: { type: 'string' },
    model: { type: 'string' },
    style: { type: 'string' },
    count: { type: 'string' },
    reference: { type: 'string' },
    pick: { type: 'string' },
    out: { type: 'string' },
    resume: { type: 'string' },
    'create-again': { type: 'boolean' },
    options: { type: 'boolean' },
    'accept-price': { type: 'boolean' },
    'confirm-prod': { type: 'boolean' },
    json: { type: 'boolean' },
  },
  preview: {
    ...SPEC,
    message: { type: 'string', short: 'm', multiple: true },
    'allow-paid': { type: 'boolean' },
    'reply-timeout': { type: 'string' },
  },
};

type Values = Record<string, string | boolean | string[] | undefined>;

function specFrom(values: Values): CharacterSpec {
  const file = values.file as string | undefined;
  const base = file ? loadSpecFile(file) : null;
  const overrides: Record<string, unknown> = {};
  for (const key of [
    'name',
    'gender',
    'description',
    'opening',
    'background',
    'visibility',
    'voice',
    'cover',
    'avatar',
  ])
    if (typeof values[key] === 'string') overrides[key] = values[key];
  if (Array.isArray(values.tag)) overrides.tags = values.tag;
  if (!base && Object.keys(overrides).length === 0)
    throw new UsageError('需要角色文件：-f character.yaml（yomi init 生成模板）');
  if (!base) return specFromObject(overrides);
  if (Object.keys(overrides).length === 0) return base;
  const patched = specFromObject(overrides);
  const merged: CharacterSpec = { ...base };
  const empty = emptySpec();
  for (const key of Object.keys(patched) as (keyof CharacterSpec)[]) {
    if (key === 'source') continue;
    if (JSON.stringify(patched[key]) !== JSON.stringify(empty[key]))
      (merged as Record<string, unknown>)[key] = patched[key];
  }
  return merged;
}

function seconds(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3600)
    throw new UsageError(`${label} 必须是 1–3600 之间的秒数`);
  return parsed;
}

/** A whole number option within [min, max], or null when it is not given. */
function whole(value: unknown, label: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new UsageError(`${label} 必须是 ${min}–${max} 的整数`);
  return parsed;
}

function gems(value: unknown): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000)
    throw new UsageError('--max-spend 必须是 0–1000000 的整数（钻石）');
  return parsed;
}

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  process.exitCode = undefined;
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const rest = command ? argv.slice(1) : argv;
  if (!command) {
    const { values } = parseArgs({ args: rest, options: GLOBAL, strict: false });
    say(io, values.version ? VERSION : HELP);
    return 0;
  }
  if (command === 'help') {
    say(io, COMMAND_HELP[rest[0] ?? ''] ?? HELP);
    return 0;
  }
  const own = OPTIONS[command];
  if (!own) {
    io.stderr.write(`不认识的命令：${command}\n\n${HELP}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL, ...own },
      allowPositionals: command === 'init' || command === 'persona',
      strict: true,
    });
  } catch (error) {
    // A token pasted as an argument must not be printed back.
    io.stderr.write(
      `${redact(error instanceof Error ? error.message : String(error))}\n\n${COMMAND_HELP[command]}\n`,
    );
    return 2;
  }
  const values = parsed.values as Values;
  if (values.help) {
    say(io, COMMAND_HELP[command]);
    return 0;
  }
  try {
    const globals: GlobalOptions = {
      env: values.env as string | undefined,
      lane: values.lane as string | undefined,
      debug: values.debug as boolean | undefined,
    };
    const context = createContext(
      io,
      globals,
      command === 'relay' ? { client: 'relay-telegram', channel: 'cli_relay' } : {},
    );
    switch (command) {
      case 'login':
        await login(context, {
          browser: !values['no-browser'],
          timeoutSeconds: seconds(values.timeout, 300, '--timeout'),
        });
        break;
      case 'logout':
        await logout(context);
        break;
      case 'whoami':
        await whoami(context);
        break;
      case 'init':
        init(context, parsed.positionals[0] ?? 'character.yaml', Boolean(values.force));
        break;
      case 'check':
        check(context, specFrom(values));
        break;
      case 'voices':
        await voices(context, { json: Boolean(values.json) });
        break;
      case 'tags':
        await tags(context, { json: Boolean(values.json), query: (values.query as string) ?? '' });
        break;
      case 'create':
        await create(context, specFrom(values), {
          acceptDeclaration: Boolean(values['accept-declaration']),
          confirmProd: Boolean(values['confirm-prod']),
          dryRun: Boolean(values['dry-run']),
          fresh: Boolean(values.new),
        });
        break;
      case 'preview':
        await preview(context, specFrom(values), {
          acceptDeclaration: Boolean(values['accept-declaration']),
          confirmProd: Boolean(values['confirm-prod']),
          messages: (values.message as string[] | undefined) ?? [],
          allowPaid: Boolean(values['allow-paid']),
          replyTimeoutMs: seconds(values['reply-timeout'], 90, '--reply-timeout') * 1000,
        });
        break;
      case 'image':
        await image(context, {
          prompt: (values.prompt as string | undefined) ?? '',
          model: (values.model as string | undefined) ?? '',
          style: (values.style as string | undefined) ?? '',
          count: whole(values.count, '--count', 1, 4),
          ratio: (values.ratio as string | undefined) ?? '',
          reference: (values.reference as string | undefined) ?? '',
          out: (values.out as string | undefined) ?? '',
          pick: whole(values.pick, '--pick', 1, 4),
          into: (values.into as string | undefined) ?? '',
          as: (values.as as string | undefined) ?? '',
          resume: (values.resume as string | undefined) ?? '',
          forget: Boolean(values.forget),
          listOptions: Boolean(values.options),
          acceptPrice: Boolean(values['accept-price']),
          confirmProd: Boolean(values['confirm-prod']),
          json: Boolean(values.json),
        });
        break;
      case 'video': {
        const needsFile = !values.options;
        await video(context, needsFile ? specFrom(values) : null, {
          template: (values.template as string | undefined) ?? '',
          prompt: (values.prompt as string | undefined) ?? '',
          duration: whole(values.duration, '--duration', 1, 600),
          frame: (values.frame as string | undefined) ?? '',
          as: (values.as as string | undefined) ?? '',
          out: (values.out as string | undefined) ?? '',
          list: Boolean(values.list),
          resume: (values.resume as string | undefined) ?? '',
          listOptions: Boolean(values.options),
          acceptPrice: Boolean(values['accept-price']),
          confirmProd: Boolean(values['confirm-prod']),
          json: Boolean(values.json),
        });
        break;
      }
      case 'persona':
        await persona(context, parsed.positionals[0] ?? '', {
          prompt: (values.prompt as string | undefined) ?? '',
          persona: (values.persona as string | undefined) ?? '',
          create: Boolean(values.new),
          name: (values.name as string | undefined) ?? '',
          gender: (values.gender as string | undefined) ?? '',
          age: whole(values.age, '--age', 18, 150),
          model: (values.model as string | undefined) ?? '',
          style: (values.style as string | undefined) ?? '',
          count: whole(values.count, '--count', 1, 16),
          reference: (values.reference as string | undefined) ?? '',
          pick: whole(values.pick, '--pick', 1, 16),
          out: (values.out as string | undefined) ?? '',
          resume: (values.resume as string | undefined) ?? '',
          createAgain: Boolean(values['create-again']),
          listOptions: Boolean(values.options),
          acceptPrice: Boolean(values['accept-price']),
          confirmProd: Boolean(values['confirm-prod']),
          json: Boolean(values.json),
        });
        break;
      case 'relay':
        await relay(context, {
          telegram: Boolean(values.telegram),
          setToken: Boolean(values['set-token']),
          tokenStdin: Boolean(values['token-stdin']),
          pair: Boolean(values.pair),
          forget: Boolean(values.forget),
          characterId: (values.character as string | undefined) ?? '',
          maxSpend: gems(values['max-spend']),
          allowFileStore: Boolean(values['allow-file-store']),
          installService: Boolean(values['install-service']),
          uninstallService: Boolean(values['uninstall-service']),
          serviceStatus: Boolean(values['service-status']),
          replyTimeoutMs: seconds(values['reply-timeout'], 120, '--reply-timeout') * 1000,
          drafts: !values['no-drafts'],
          confirmProd: Boolean(values['confirm-prod']),
          resetSpend: Boolean(values['reset-spend']),
        });
        break;
    }
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    reportError(io, error);
    return 1;
  }
}

function reportError(io: Io, error: unknown) {
  const line = (text: string) => io.stderr.write(paint(io, 'red', redact(text)) + '\n');
  if (error instanceof SpecError) {
    line('角色文件有问题：');
    for (const problem of error.problems) io.stderr.write(`  · ${problem}\n`);
  } else if (
    error instanceof NotSignedIn ||
    error instanceof UsageError ||
    error instanceof ImageError
  )
    line(error.message);
  else if (error instanceof UgcFailure)
    line(
      `请求失败（${error.code}）${error.message && error.message !== error.code ? '：' + error.message : ''}`,
    );
  else if (error instanceof ApiError) {
    if (error.needsSignIn) line('登录已失效，请重新运行 yomi login');
    else
      line(
        `请求失败（${error.code}${error.path ? ' ' + error.path : ''}）${error.message ? '：' + error.message : ''}`,
      );
  } else line(error instanceof Error ? error.message : String(error));
}

const invoked = process.argv[1] ?? '';
if (/(?:^|[\\/])(cli\.js|yomi)$/.test(invoked)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
}
