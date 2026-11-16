import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { NotSignedIn } from '../core/api.js';
import { describeEnvironment } from '../core/env.js';
import { tr } from '../core/i18n.js';
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
    throw new SpecError([
      tr(
        'yomi video 需要角色文件：-f character.yaml（结果按这个文件记下）',
        'yomi video needs a character file: -f character.yaml (results are kept under that file)',
        'yomi video necesita el archivo del personaje: -f character.yaml (los resultados se guardan bajo ese archivo)',
        'yomi video precisa do arquivo do personagem: -f character.yaml (os resultados ficam guardados nesse arquivo)',
      ),
    ]);
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
    warn(
      io,
      tr(
        `价格或选项已经变了（${refusal.code}）。重新运行会重新报价。这次没有扣费。`,
        `The price or options have changed (${refusal.code}). Run it again for a new quote. Nothing was charged.`,
        `El precio o las opciones cambiaron (${refusal.code}). Vuelve a ejecutarlo para obtener una nueva cotización. No se cobró nada.`,
        `O preço ou as opções mudaram (${refusal.code}). Execute novamente para obter uma nova cotação. Nada foi cobrado.`,
      ),
    );
  else if (CONTENT_CODES.has(refusal.code))
    warn(
      io,
      tr(
        `内容没有通过检查（${refusal.code}），请修改描述或换一张首帧。这次没有扣费。`,
        `The content check failed (${refusal.code}). Change the description or use another first frame. Nothing was charged.`,
        `La verificación de contenido falló (${refusal.code}). Cambia la descripción o usa otro primer fotograma. No se cobró nada.`,
        `A verificação de conteúdo falhou (${refusal.code}). Altere a descrição ou use outro primeiro quadro. Nada foi cobrado.`,
      ),
    );
  else if (refusal.code === 'CONCURRENCY_LIMIT')
    warn(
      io,
      tr(
        '同时生成的视频太多了，等一条完成后再试。这次没有扣费。',
        'Too many videos are generating at once; try again when one finishes. Nothing was charged.',
        'Hay demasiados videos generándose a la vez; inténtalo de nuevo cuando termine uno. No se cobró nada.',
        'Há vídeos demais sendo gerados ao mesmo tempo; tente novamente quando um terminar. Nada foi cobrado.',
      ),
    );
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
      ? durations
          .map((seconds) =>
            tr(
              `${seconds} 秒 ${map.get(seconds) ?? '?'} 钻石`,
              `${seconds} s: ${map.get(seconds) ?? '?'} gems`,
              `${seconds} s: ${map.get(seconds) ?? '?'} gemas`,
              `${seconds} s: ${map.get(seconds) ?? '?'} gemas`,
            ),
          )
          .join(' · ')
      : tr(
          '未公布（以报价为准）',
          'not published (the quote applies)',
          'no publicado (se aplica la cotización)',
          'não publicado (vale a cotação)',
        );
  say(
    io,
    tr(
      `AI 视频配置（${describeEnvironment(context.env)}）`,
      `AI video config (${describeEnvironment(context.env)})`,
      `Configuración de video con IA (${describeEnvironment(context.env)})`,
      `Configuração de vídeo com IA (${describeEnvironment(context.env)})`,
    ),
  );
  dim(
    io,
    tr(
      `配置版本 ${config.configVersion}，同时进行的任务最多 ${config.maxConcurrentTasks} 个`,
      `Config version ${config.configVersion}, at most ${config.maxConcurrentTasks} tasks at a time`,
      `Versión de configuración ${config.configVersion}, máximo ${config.maxConcurrentTasks} tareas a la vez`,
      `Versão da configuração ${config.configVersion}, no máximo ${config.maxConcurrentTasks} tarefas ao mesmo tempo`,
    ),
  );
  say(io);
  say(
    io,
    tr(
      '自定义（--prompt 描述，可不写）',
      'Custom (--prompt description, optional)',
      'Personalizado (descripción con --prompt, opcional)',
      'Personalizado (descrição com --prompt, opcional)',
    ),
  );
  say(
    io,
    tr(
      `  时长 ${config.customDurations.join(' / ')} 秒（默认 ${config.customDefaultDuration}）`,
      `  Duration ${config.customDurations.join(' / ')} s (default ${config.customDefaultDuration})`,
      `  Duración ${config.customDurations.join(' / ')} s (por defecto ${config.customDefaultDuration})`,
      `  Duração ${config.customDurations.join(' / ')} s (padrão ${config.customDefaultDuration})`,
    ),
  );
  say(
    io,
    tr(
      `  展示价：${priceText(config.customPrices, config.customDurations)}`,
      `  Listed price: ${priceText(config.customPrices, config.customDurations)}`,
      `  Precio de lista: ${priceText(config.customPrices, config.customDurations)}`,
      `  Preço de tabela: ${priceText(config.customPrices, config.customDurations)}`,
    ),
  );
  say(io);
  say(
    io,
    config.templates.length
      ? tr(
          '模板（--template ID）',
          'Templates (--template ID)',
          'Plantillas (--template ID)',
          'Templates (--template ID)',
        )
      : tr('暂无模板。', 'No templates yet.', 'Aún no hay plantillas.', 'Ainda não há templates.'),
  );
  for (const template of config.templates) {
    say(io, `  ${template.id}  ${template.name}`);
    say(
      io,
      tr(
        `    时长 ${template.durations.join(' / ')} 秒（默认 ${template.defaultDuration}）　展示价：${priceText(template.prices, template.durations)}`,
        `    Duration ${template.durations.join(' / ')} s (default ${template.defaultDuration})  Listed price: ${priceText(template.prices, template.durations)}`,
        `    Duración ${template.durations.join(' / ')} s (por defecto ${template.defaultDuration})  Precio de lista: ${priceText(template.prices, template.durations)}`,
        `    Duração ${template.durations.join(' / ')} s (padrão ${template.defaultDuration})  Preço de tabela: ${priceText(template.prices, template.durations)}`,
      ),
    );
    if (template.description.trim())
      dim(io, `    ${template.description.trim().replace(/\s*\n\s*/g, ' ')}`);
  }
  say(io);
  dim(
    io,
    tr(
      '展示价仅供参考：生成前会先报价，按报价扣费。',
      'Listed prices are for reference: you get a quote before generating, and the quote is what is charged.',
      'Los precios de lista son solo de referencia: antes de generar recibes una cotización, y lo que se cobra es la cotización.',
      'Os preços de tabela são apenas referência: antes de gerar você recebe uma cotação, e o valor cobrado é o da cotação.',
    ),
  );
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
  say(
    io,
    tr(
      `角色文件 ${basename(spec.source)} 的 AI 视频（草稿 ${draftId}）`,
      `AI videos for character file ${basename(spec.source)} (draft ${draftId})`,
      `Videos con IA del archivo del personaje ${basename(spec.source)} (borrador ${draftId})`,
      `Vídeos com IA do arquivo do personagem ${basename(spec.source)} (rascunho ${draftId})`,
    ),
  );
  if (!tasks.length && !unconfirmed.length) {
    say(
      io,
      tr(
        '还没有生成过视频。',
        'No videos generated yet.',
        'Aún no se generó ningún video.',
        'Nenhum vídeo gerado ainda.',
      ),
    );
    return;
  }
  for (const task of tasks) {
    const use = useOf(task.requestId);
    const parts = [
      task.requestId,
      statusText(task),
      billingText(task),
      use ? VIDEO_USE_LABEL[use] : '',
      task.createdAtMs
        ? new Date(task.createdAtMs).toLocaleString(tr('zh-CN', 'en-US', 'es-419', 'pt-BR'))
        : '',
    ].filter(Boolean);
    say(io, `  ${parts.join(tr('　', '  ', '  ', '  '))}`);
  }
  for (const requestId of unconfirmed)
    say(
      io,
      tr(
        `  ${requestId}　结果未知（本机保存的请求，服务端还没有确认）`,
        `  ${requestId}  outcome unknown (saved on this machine, not yet confirmed by the server)`,
        `  ${requestId}  resultado desconocido (solicitud guardada en este equipo, aún sin confirmar por el servidor)`,
        `  ${requestId}  resultado desconhecido (solicitação salva nesta máquina, ainda não confirmada pelo servidor)`,
      ),
    );
  const kept = [
    results?.dynamicCover.length
      ? tr(
          `动态封面 ${results.dynamicCover.length} 条`,
          `${results.dynamicCover.length} dynamic cover(s)`,
          `${results.dynamicCover.length} portada(s) animada(s)`,
          `${results.dynamicCover.length} capa(s) animada(s)`,
        )
      : '',
    results?.introVideo.length
      ? tr(
          `介绍视频 ${results.introVideo.length} 条`,
          `${results.introVideo.length} intro video(s)`,
          `${results.introVideo.length} video(s) de presentación`,
          `${results.introVideo.length} vídeo(s) de apresentação`,
        )
      : '',
  ].filter(Boolean);
  say(io);
  if (kept.length)
    dim(
      io,
      results?.boundTo
        ? tr(
            `已随角色 ${results.boundTo} 提交：${kept.join('、')}。`,
            `Submitted with character ${results.boundTo}: ${kept.join(', ')}.`,
            `Enviados con el personaje ${results.boundTo}: ${kept.join(', ')}.`,
            `Enviados com o personagem ${results.boundTo}: ${kept.join(', ')}.`,
          )
        : tr(
            `已记下：${kept.join('、')}；yomi create 这个文件时一起提交（选用最新一条，试聊不带视频）。`,
            `Kept: ${kept.join(', ')}; they go with yomi create for this file (the newest is used; a preview does not include videos).`,
            `Guardados: ${kept.join(', ')}; se envían con yomi create para este archivo (se usa el más reciente; una vista previa no incluye videos).`,
            `Guardados: ${kept.join(', ')}; vão junto com yomi create para este arquivo (o mais recente é usado; uma prévia não inclui vídeos).`,
          ),
    );
  dim(
    io,
    tr(
      `查看或继续某个任务：${resumeCommand(spec.source, '<请求ID>')}`,
      `View or continue a task: ${resumeCommand(spec.source, '<request-ID>')}`,
      `Ver o continuar una tarea: ${resumeCommand(spec.source, '<ID-de-solicitud>')}`,
      `Ver ou continuar uma tarefa: ${resumeCommand(spec.source, '<ID-da-solicitação>')}`,
    ),
  );
}

function statusText(task: VideoTask): string {
  switch (task.status) {
    case 'ACCEPTED':
      return tr('已受理', 'accepted', 'aceptado', 'aceito');
    case 'QUEUED':
      return tr('排队中', 'queued', 'en cola', 'na fila');
    case 'RUNNING':
      return task.progress === null
        ? tr('生成中', 'generating', 'generando', 'gerando')
        : tr(
            `生成中 ${task.progress}%`,
            `generating ${task.progress}%`,
            `generando ${task.progress}%`,
            `gerando ${task.progress}%`,
          );
    case 'REVIEWING':
      return tr(
        '内容检查中',
        'content check in progress',
        'verificación de contenido en curso',
        'verificação de conteúdo em andamento',
      );
    case 'SUCCEEDED':
      return tr('已生成', 'generated', 'generado', 'gerado');
    default:
      return CONTENT_CODES.has(task.errorCode)
        ? tr(
            '未通过内容检查',
            'failed the content check',
            'no pasó la verificación de contenido',
            'não passou na verificação de conteúdo',
          )
        : tr(
            `失败${task.errorCode ? `（${task.errorCode}）` : ''}`,
            `failed${task.errorCode ? ` (${task.errorCode})` : ''}`,
            `falló${task.errorCode ? ` (${task.errorCode})` : ''}`,
            `falhou${task.errorCode ? ` (${task.errorCode})` : ''}`,
          );
  }
}

function billingText(task: VideoTask): string {
  switch (task.billing) {
    case 'PENDING':
      return tr('扣费确认中', 'charge pending', 'cobro pendiente', 'cobrança pendente');
    case 'FREE':
      return tr('免费', 'free', 'gratis', 'grátis');
    case 'CHARGED':
      return tr(
        `已扣 ${task.charged} 钻石`,
        `charged ${task.charged} gems`,
        `${task.charged} gemas cobradas`,
        `${task.charged} gemas cobradas`,
      );
    case 'REFUNDING':
      return tr(
        '退款中（还没有到账）',
        'refunding (not back yet)',
        'reembolso en curso (aún no se acreditó)',
        'reembolso em andamento (ainda não creditado)',
      );
    case 'REFUNDED':
      return tr('已退款', 'refunded', 'reembolsado', 'reembolsado');
    default:
      return tr('没有扣费', 'not charged', 'sin cobro', 'sem cobrança');
  }
}

// ---------------------------------------------------------------------------------------------
// Generating

function frameSource(run: Run): string {
  if (run.options.frame) return resolve(run.options.frame);
  const cover = run.spec.cover;
  if (cover?.kind === 'file') return cover.path;
  throw new SpecError([
    tr(
      '角色文件的 cover 不是本地图片：用 --frame 指定首帧图片（JPEG/PNG，会裁成 9:16）',
      "The character file's cover is not a local image: use --frame to give a first-frame image (JPEG/PNG, cropped to 9:16)",
      'La portada del archivo del personaje no es una imagen local: usa --frame para indicar una imagen de primer fotograma (JPEG/PNG, recortada a 9:16)',
      'A capa do arquivo do personagem não é uma imagem local: use --frame para indicar uma imagem de primeiro quadro (JPEG/PNG, recortada para 9:16)',
    ),
  ]);
}

function chooseTemplate(run: Run, config: VideoConfig): VideoTemplate | null {
  const { template: wanted, prompt } = run.options;
  if (!wanted) return null;
  if (prompt)
    throw new Error(
      tr(
        '用模板时不能写 --prompt：模板的描述是固定的（自定义视频不写 --template）',
        "--prompt can't be used with a template: a template's description is fixed (leave out --template for a custom video)",
        '--prompt no se puede usar con una plantilla: la descripción de una plantilla es fija (omite --template para un video personalizado)',
        '--prompt não pode ser usado com um template: a descrição de um template é fixa (omita --template para um vídeo personalizado)',
      ),
    );
  const template = findTemplate(config, wanted);
  if (!template)
    throw new Error(
      tr(
        `没有模板 ${wanted}。可选：${config.templates.map((item) => item.id).join('、') || '（无）'}（yomi video --options 查看）`,
        `No template ${wanted}. Available: ${config.templates.map((item) => item.id).join(', ') || '(none)'} (see yomi video --options)`,
        `No existe la plantilla ${wanted}. Disponibles: ${config.templates.map((item) => item.id).join(', ') || '(ninguna)'} (consulta yomi video --options)`,
        `Não existe o template ${wanted}. Disponíveis: ${config.templates.map((item) => item.id).join(', ') || '(nenhum)'} (veja yomi video --options)`,
      ),
    );
  return template;
}

/** The first-frame file: a regular file of at most 20 MB (checked before it is read). */
function readFrame(path: string): Buffer {
  const stat = statSync(path);
  if (!stat.isFile())
    throw new SpecError([
      tr(
        `首帧图片 ${path} 不是普通文件`,
        `First-frame image ${path} is not a regular file`,
        `La imagen del primer fotograma ${path} no es un archivo normal`,
        `A imagem do primeiro quadro ${path} não é um arquivo comum`,
      ),
    ]);
  if (stat.size > MAX_FRAME_BYTES)
    throw new SpecError([
      tr(
        `首帧图片 ${path} 太大（最多 20 MB）`,
        `First-frame image ${path} is too large (20 MB at most)`,
        `La imagen del primer fotograma ${path} es demasiado grande (máximo 20 MB)`,
        `A imagem do primeiro quadro ${path} é grande demais (no máximo 20 MB)`,
      ),
    ]);
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
      tr(
        `这个角色文件的 AI 视频已随角色 ${bound} 提交，新视频不能再绑定到它，也不能带给另一个角色。`,
        `This character file's AI videos were already submitted with character ${bound}; new videos can't be bound to it or go with another character. `,
        `Los videos con IA de este archivo del personaje ya se enviaron con el personaje ${bound}; los videos nuevos no se pueden vincular a él ni enviarse con otro personaje. `,
        `Os vídeos com IA deste arquivo do personagem já foram enviados com o personagem ${bound}; vídeos novos não podem ser vinculados a ele nem ir com outro personagem. `,
      ) +
        tr(
          '要给新角色做视频，把文件复制成新的角色文件（新的本机草稿）再运行 yomi video。',
          'To make videos for a new character, copy the file to a new character file (a new local draft) and run yomi video again.',
          'Para hacer videos para un personaje nuevo, copia el archivo a un nuevo archivo del personaje (un nuevo borrador local) y vuelve a ejecutar yomi video.',
          'Para fazer vídeos para um personagem novo, copie o arquivo para um novo arquivo do personagem (um novo rascunho local) e execute yomi video novamente.',
        ),
    ]);
  const use = parseVideoUse(options.as);
  const prompt = options.prompt;
  if ([...prompt].length > PROMPT_MAX)
    throw new Error(
      tr(
        `--prompt 最多 ${PROMPT_MAX} 个字符（现在 ${[...prompt].length}）`,
        `--prompt can be at most ${PROMPT_MAX} characters (now ${[...prompt].length})`,
        `--prompt admite como máximo ${PROMPT_MAX} caracteres (ahora tiene ${[...prompt].length})`,
        `--prompt aceita no máximo ${PROMPT_MAX} caracteres (agora tem ${[...prompt].length})`,
      ),
    );
  say(
    io,
    tr(
      `为角色「${spec.name || basename(spec.source)}」生成 AI 视频，用作${VIDEO_USE_LABEL[use]}（${describeEnvironment(context.env)}）`,
      `Generating an AI video for character "${spec.name || basename(spec.source)}" as its ${VIDEO_USE_LABEL[use]} (${describeEnvironment(context.env)})`,
      `Generando un video con IA para el personaje "${spec.name || basename(spec.source)}" como ${VIDEO_USE_LABEL[use]} (${describeEnvironment(context.env)})`,
      `Gerando um vídeo com IA para o personagem "${spec.name || basename(spec.source)}" como ${VIDEO_USE_LABEL[use]} (${describeEnvironment(context.env)})`,
    ),
  );
  const config = await loadVideoConfig(gateway);
  const template = chooseTemplate(run, config);
  const durations = template ? template.durations : config.customDurations;
  const seconds =
    options.duration ?? (template ? template.defaultDuration : config.customDefaultDuration);
  if (!durations.includes(seconds))
    throw new Error(
      tr(
        `--duration 只能是 ${durations.join(' / ')} 秒`,
        `--duration must be ${durations.join(' / ')} s`,
        `--duration debe ser ${durations.join(' / ')} s`,
        `--duration deve ser ${durations.join(' / ')} s`,
      ),
    );
  const shown = displayPrice(config, template, seconds);
  say(
    io,
    template
      ? tr(
          `模板：${template.name}（${template.id}），${seconds} 秒`,
          `Template: ${template.name} (${template.id}), ${seconds} s`,
          `Plantilla: ${template.name} (${template.id}), ${seconds} s`,
          `Template: ${template.name} (${template.id}), ${seconds} s`,
        )
      : tr(
          `自定义：${seconds} 秒${prompt ? `，描述「${prompt}」` : '，不写描述'}`,
          `Custom: ${seconds} s${prompt ? `, description "${prompt}"` : ', no description'}`,
          `Personalizado: ${seconds} s${prompt ? `, descripción "${prompt}"` : ', sin descripción'}`,
          `Personalizado: ${seconds} s${prompt ? `, descrição "${prompt}"` : ', sem descrição'}`,
        ),
  );

  // The frame is prepared here first: a picture that cannot be used stops before any request.
  const framePath = frameSource(run);
  let jpeg: Buffer;
  try {
    jpeg = prepare(readFrame(framePath), 'videoFrame');
  } catch (error) {
    if (error instanceof RasterError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new SpecError([
        tr(
          `首帧图片 ${framePath} 用不了：${error instanceof RasterError ? error.message : '文件不存在'}`,
          `First-frame image ${framePath} can't be used: ${error instanceof RasterError ? error.message : 'file not found'}`,
          `La imagen del primer fotograma ${framePath} no se puede usar: ${error instanceof RasterError ? error.message : 'archivo no encontrado'}`,
          `A imagem do primeiro quadro ${framePath} não pode ser usada: ${error instanceof RasterError ? error.message : 'arquivo não encontrado'}`,
        ),
      ]);
    throw error;
  }
  dim(
    io,
    tr(
      `首帧：${basename(framePath)}（居中裁成 9:16，720×1280 JPEG）`,
      `First frame: ${basename(framePath)} (center-cropped to 9:16, 720×1280 JPEG)`,
      `Primer fotograma: ${basename(framePath)} (recortado al centro a 9:16, JPEG de 720×1280)`,
      `Primeiro quadro: ${basename(framePath)} (recortado no centro para 9:16, JPEG de 720×1280)`,
    ),
  );

  const target: Target = { requestId: '', draftId, source: spec.source, use, amount: shown };
  // A request of this file whose answer was lost may already be charged: running the command
  // again must not quietly become a second paid request. Unattended runs settle it first.
  const unconfirmed = videoRequests(run.state, draftId).filter((record) => record.state === 'sent');
  if (unconfirmed.length) {
    warn(
      io,
      tr(
        `这个角色文件还有 ${unconfirmed.length} 个结果未知的视频请求，可能已经受理并扣费：`,
        `This character file has ${unconfirmed.length} video request(s) with an unknown outcome; they may have been accepted and charged:`,
        `Este archivo del personaje tiene ${unconfirmed.length} solicitud(es) de video con resultado desconocido; puede que ya se hayan aceptado y cobrado:`,
        `Este arquivo do personagem tem ${unconfirmed.length} solicitação(ões) de vídeo com resultado desconhecido; elas podem já ter sido aceitas e cobradas:`,
      ),
    );
    for (const record of unconfirmed)
      warn(io, `  ${resumeCommand(record.source, record.request.request_id)}`);
    if (!io.interactive) {
      warn(
        io,
        tr(
          '先用上面的命令确认（同一个请求 ID，不会重复扣费），再生成新的视频。没有上传首帧，也没有报价。',
          'Check them first with the commands above (same request ID, never charged twice), then generate a new video. No first frame was uploaded and no quote was requested.',
          'Primero verifícalas con los comandos de arriba (mismo ID de solicitud, nunca se cobra dos veces) y después genera un video nuevo. No se subió ningún primer fotograma ni se pidió cotización.',
          'Primeiro confira-as com os comandos acima (mesmo ID da solicitação, nunca cobrado duas vezes) e depois gere um vídeo novo. Nenhum primeiro quadro foi enviado e nenhuma cotação foi pedida.',
        ),
      );
      return outcomeOf(target, null, 'cancelled', {
        error_code: 'UNCONFIRMED_REQUEST',
        resume: resumeCommand(spec.source, unconfirmed[0].request.request_id),
      });
    }
    warn(
      io,
      tr(
        '继续的话是一条新的请求，会另外扣费，需要输入 yes 确认。',
        'Continuing sends a new request that is charged separately; you need to type yes to confirm.',
        'Si continúas, se envía una solicitud nueva que se cobra aparte; tienes que escribir yes para confirmar.',
        'Se continuar, uma nova solicitação será enviada e cobrada à parte; você precisa digitar yes para confirmar.',
      ),
    );
  }

  // The balance against the display price: a video that cannot be paid uploads nothing.
  const balance = await readBalance(gateway);
  if (balance === null) {
    warn(
      io,
      tr(
        '暂时读不到钻石余额，为避免扣费出错没有继续（没有上传首帧，也没有报价）。',
        'Could not read your gem balance right now; stopped to avoid a wrong charge (no first frame uploaded, no quote requested).',
        'No se pudo leer tu saldo de gemas en este momento; se detuvo para evitar un cobro incorrecto (no se subió el primer fotograma ni se pidió cotización).',
        'Não foi possível ler seu saldo de gemas agora; a operação foi interrompida para evitar uma cobrança incorreta (nenhum primeiro quadro enviado, nenhuma cotação pedida).',
      ),
    );
    return outcomeOf(target, null, 'refused', { error_code: 'WALLET_UNAVAILABLE' });
  }
  say(
    io,
    tr(
      `${shown === null ? '展示价未公布（以报价为准）' : `展示价 ${shown} 钻石`}，当前余额 ${balance} 钻石。`,
      `${shown === null ? 'Listed price not published (the quote applies)' : `Listed price ${shown} gems`}, current balance ${balance} gems.`,
      `${shown === null ? 'Precio de lista no publicado (se aplica la cotización)' : `Precio de lista ${shown} gemas`}, saldo actual ${balance} gemas.`,
      `${shown === null ? 'Preço de tabela não publicado (vale a cotação)' : `Preço de tabela ${shown} gemas`}, saldo atual ${balance} gemas.`,
    ),
  );
  if (shown !== null && balance < shown) {
    warn(
      io,
      tr(
        `钻石不足（还差 ${shown - balance}），请先在 Yomi App 或网页充值。没有上传首帧，也没有报价。`,
        `Not enough gems (${shown - balance} short). Top up in the Yomi app or on the web first. No first frame was uploaded and no quote was requested.`,
        `No tienes suficientes gemas (faltan ${shown - balance}). Recarga primero en la app de Yomi o en la web. No se subió ningún primer fotograma ni se pidió cotización.`,
        `Gemas insuficientes (faltam ${shown - balance}). Recarregue primeiro no app do Yomi ou na web. Nenhum primeiro quadro foi enviado e nenhuma cotação foi pedida.`,
      ),
    );
    return outcomeOf(target, null, 'refused', { error_code: 'INSUFFICIENT_BALANCE' });
  }
  if (
    !(await confirmProduction(
      context,
      tr(
        '上传首帧并生成 AI 视频（会扣钻石）',
        'upload the first frame and generate an AI video (charges gems)',
        'subir el primer fotograma y generar un video con IA (cobra gemas)',
        'enviar o primeiro quadro e gerar um vídeo com IA (cobra gemas)',
      ),
      options.confirmProd,
    ))
  )
    return outcomeOf(target, null, 'cancelled');

  dim(
    io,
    tr(
      '上传首帧…',
      'Uploading the first frame…',
      'Subiendo el primer fotograma…',
      'Enviando o primeiro quadro…',
    ),
  );
  let frameAssetId: string;
  try {
    frameAssetId = await uploadFrame(gateway, draftId, jpeg, context.fetch);
  } catch (error) {
    if (error instanceof UgcFailure && CONTENT_CODES.has(error.code)) {
      warn(
        io,
        tr(
          `首帧图片没有通过内容检查（${error.code}），请换一张（--frame）。没有扣费。`,
          `The first-frame image did not pass the content check (${error.code}); use another one (--frame). Nothing was charged.`,
          `La imagen del primer fotograma no pasó la verificación de contenido (${error.code}); usa otra (--frame). No se cobró nada.`,
          `A imagem do primeiro quadro não passou na verificação de conteúdo (${error.code}); use outra (--frame). Nada foi cobrado.`,
        ),
      );
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
  const action = tr(
    `生成 1 条 ${seconds} 秒的 AI 视频（${VIDEO_USE_LABEL[use]}）`,
    `Generate a ${seconds}-second AI video (${VIDEO_USE_LABEL[use]})`,
    `Generar un video con IA de ${seconds} segundos (${VIDEO_USE_LABEL[use]})`,
    `Gerar um vídeo com IA de ${seconds} segundos (${VIDEO_USE_LABEL[use]})`,
  );
  const notes = [
    tr(
      '生成失败或没有通过内容检查会自动退款。',
      'If generation fails or the video does not pass the content check, the gems are refunded automatically.',
      'Si la generación falla o el video no pasa la verificación de contenido, las gemas se reembolsan automáticamente.',
      'Se a geração falhar ou o vídeo não passar na verificação de conteúdo, as gemas são reembolsadas automaticamente.',
    ),
  ];
  if (shown !== null && quote.amount !== shown) {
    warn(
      io,
      tr(
        `报价 ${quote.amount} 钻石，和展示价 ${shown} 钻石不同。`,
        `The quote is ${quote.amount} gems, not the listed ${shown} gems.`,
        `La cotización es de ${quote.amount} gemas, no las ${shown} gemas del precio de lista.`,
        `A cotação é de ${quote.amount} gemas, não as ${shown} gemas do preço de tabela.`,
      ),
    );
    if (!io.interactive) {
      warn(
        io,
        tr(
          '价格和展示的不同，需要在终端里重新确认（--accept-price 只同意展示的价格）。没有扣费，也没有创建任务。',
          'The price differs from the listed one and must be confirmed again in a terminal (--accept-price only accepts the listed price). Nothing was charged and no task was created.',
          'El precio es distinto del de lista y hay que confirmarlo de nuevo en una terminal (--accept-price solo acepta el precio de lista). No se cobró nada ni se creó ninguna tarea.',
          'O preço é diferente do de tabela e precisa ser confirmado novamente em um terminal (--accept-price só aceita o preço de tabela). Nada foi cobrado e nenhuma tarefa foi criada.',
        ),
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
    say(
      io,
      tr(
        '没有扣费，也没有创建任务。',
        'Nothing was charged and no task was created.',
        'No se cobró nada ni se creó ninguna tarea.',
        'Nada foi cobrado e nenhuma tarefa foi criada.',
      ),
    );
    return outcomeOf(target, null, 'cancelled');
  }
  // A quote that ran out while the person decided is quoted again; a new price is asked again.
  for (let round = 0; !quoteUsable(quote); round++) {
    if (round === 2) {
      warn(
        io,
        tr(
          '报价一直在过期，没有创建任务，也没有扣费。请稍后重新运行。',
          'The quote keeps expiring; no task was created and nothing was charged. Run it again later.',
          'La cotización sigue venciendo; no se creó ninguna tarea ni se cobró nada. Vuelve a ejecutarlo más tarde.',
          'A cotação continua expirando; nenhuma tarefa foi criada e nada foi cobrado. Execute novamente mais tarde.',
        ),
      );
      return outcomeOf(target, null, 'cancelled');
    }
    dim(
      io,
      tr(
        '报价已过期，重新报价…',
        'The quote expired; getting a new one…',
        'La cotización venció; obteniendo una nueva…',
        'A cotação expirou; obtendo uma nova…',
      ),
    );
    const again = await quoteOrExplain(run, input, target);
    if ('outcome' in again) return again;
    if (again.amount !== quote.amount) {
      warn(
        io,
        tr(
          `价格变了：刚才 ${quote.amount} 钻石，现在 ${again.amount} 钻石。`,
          `The price changed: ${quote.amount} gems before, ${again.amount} gems now.`,
          `El precio cambió: antes ${quote.amount} gemas, ahora ${again.amount} gemas.`,
          `O preço mudou: antes ${quote.amount} gemas, agora ${again.amount} gemas.`,
        ),
      );
      if (!io.interactive) {
        warn(
          io,
          tr(
            '新价格需要重新确认：没有扣费，也没有创建任务，请重新运行。',
            'The new price needs confirming: nothing was charged and no task was created. Run it again.',
            'Hay que confirmar el precio nuevo: no se cobró nada ni se creó ninguna tarea. Vuelve a ejecutarlo.',
            'O novo preço precisa ser confirmado: nada foi cobrado e nenhuma tarefa foi criada. Execute novamente.',
          ),
        );
        return outcomeOf({ ...target, amount: again.amount }, null, 'cancelled');
      }
      const yes = await confirmSpend(io, gateway, {
        action,
        total: again.amount,
        acceptPrice: false,
        notes,
      });
      if (!yes) {
        say(
          io,
          tr(
            '没有扣费，也没有创建任务。',
            'Nothing was charged and no task was created.',
            'No se cobró nada ni se creó ninguna tarea.',
            'Nada foi cobrado e nenhuma tarefa foi criada.',
          ),
        );
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
  dim(
    run.io,
    tr('获取报价…', 'Getting a quote…', 'Obteniendo la cotización…', 'Obtendo a cotação…'),
  );
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
        tr(
          `创建请求的结果未知${code ? `（${code}）` : ''}：可能已经受理并扣费，也可能没有。CLI 不会自动重发，这个请求已保存在本机。`,
          `The create request's outcome is unknown${code ? ` (${code})` : ''}: it may or may not have been accepted and charged. The CLI does not resend it on its own; the request is saved on this machine.`,
          `El resultado de la solicitud de creación es desconocido${code ? ` (${code})` : ''}: puede que se haya aceptado y cobrado, o no. La CLI no la reenvía por su cuenta; la solicitud está guardada en este equipo.`,
          `O resultado da solicitação de criação é desconhecido${code ? ` (${code})` : ''}: ela pode ou não ter sido aceita e cobrada. A CLI não a reenvia sozinha; a solicitação está salva nesta máquina.`,
        ),
      );
      say(
        io,
        tr(
          `确认结果或重试同一个请求（同一个请求 ID，不会重复扣费）：${again}`,
          `Check the outcome or retry the same request (same request ID, never charged twice): ${again}`,
          `Verifica el resultado o reintenta la misma solicitud (mismo ID de solicitud, nunca se cobra dos veces): ${again}`,
          `Confira o resultado ou tente novamente a mesma solicitação (mesmo ID da solicitação, nunca cobrado duas vezes): ${again}`,
        ),
      );
      if (error instanceof NotSignedIn) throw error;
      return outcomeOf(target, null, 'unknown', { error_code: code, resume: again });
    }
    task = accepted;
  }
  saveVideoRequest(state, { ...record, state: 'accepted', task });
  say(
    io,
    tr(
      `已提交：请求 ${target.requestId}（任务 ${task.taskId}）。`,
      `Submitted: request ${target.requestId} (task ${task.taskId}).`,
      `Enviada: solicitud ${target.requestId} (tarea ${task.taskId}).`,
      `Enviada: solicitação ${target.requestId} (tarefa ${task.taskId}).`,
    ),
  );
  dim(
    io,
    tr(
      `停止查看（Ctrl+C）不会取消任务，也不会退款；之后用 ${again} 继续查看。`,
      `Stopping (Ctrl+C) neither cancels the task nor refunds it; continue later with ${again}.`,
      `Detener (Ctrl+C) no cancela la tarea ni la reembolsa; continúa más tarde con ${again}.`,
      `Parar (Ctrl+C) não cancela a tarefa nem a reembolsa; continue mais tarde com ${again}.`,
    ),
  );
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
    const line = tr(
      `${statusText(task)}　${billingText(task)}`,
      `${statusText(task)}  ${billingText(task)}`,
      `${statusText(task)}  ${billingText(task)}`,
      `${statusText(task)}  ${billingText(task)}`,
    );
    if (line !== shown) dim(io, line);
    shown = line;
  };
  if (initial) tick(initial);
  const watched = await watchTask(context.gateway, target.requestId, target.draftId, initial, {
    onTick: tick,
    onError: (error) =>
      warn(
        io,
        tr(
          `查询任务暂时失败（${codeOf(error)}），继续查询…`,
          `Could not check the task for now (${codeOf(error)}); still checking…`,
          `No se pudo consultar la tarea por ahora (${codeOf(error)}); se sigue consultando…`,
          `Não foi possível consultar a tarefa agora (${codeOf(error)}); continuando a consultar…`,
        ),
      ),
  });
  const task = watched.task;
  if (task && record) saveVideoRequest(state, { ...record, state: 'accepted', task });
  if (!task || !watched.settled) {
    say(
      io,
      tr(
        `还没有结束${task ? `（${statusText(task)}，${billingText(task)}）` : ''}。停止查看不会取消服务端的任务，也不会退款。`,
        `Not finished yet${task ? ` (${statusText(task)}, ${billingText(task)})` : ''}. Stopping does not cancel the task on the server or refund it.`,
        `Aún no terminó${task ? ` (${statusText(task)}, ${billingText(task)})` : ''}. Detenerse no cancela la tarea en el servidor ni la reembolsa.`,
        `Ainda não terminou${task ? ` (${statusText(task)}, ${billingText(task)})` : ''}. Parar não cancela a tarefa no servidor nem a reembolsa.`,
      ),
    );
    say(
      io,
      tr(
        `稍后继续查看：${again}`,
        `Continue later: ${again}`,
        `Continúa más tarde: ${again}`,
        `Continue mais tarde: ${again}`,
      ),
    );
    return outcomeOf(target, task, 'running', { resume: again });
  }
  if (task.status === 'SUCCEEDED') return succeeded(run, target, task);
  const rejected = CONTENT_CODES.has(task.errorCode);
  warn(
    io,
    rejected
      ? tr(
          `✗ 视频没有通过内容检查（${task.errorCode}）。`,
          `✗ The video did not pass the content check (${task.errorCode}).`,
          `✗ El video no pasó la verificación de contenido (${task.errorCode}).`,
          `✗ O vídeo não passou na verificação de conteúdo (${task.errorCode}).`,
        )
      : tr(
          `✗ 生成失败${task.errorCode ? `（${task.errorCode}）` : ''}。`,
          `✗ Generation failed${task.errorCode ? ` (${task.errorCode})` : ''}.`,
          `✗ La generación falló${task.errorCode ? ` (${task.errorCode})` : ''}.`,
          `✗ A geração falhou${task.errorCode ? ` (${task.errorCode})` : ''}.`,
        ),
  );
  if (task.billing === 'REFUNDED')
    say(
      io,
      tr(
        `钻石已退回${task.charged ? `（${task.charged} 钻石）` : ''}。`,
        `Gems refunded${task.charged ? ` (${task.charged} gems)` : ''}.`,
        `Gemas reembolsadas${task.charged ? ` (${task.charged} gemas)` : ''}.`,
        `Gemas reembolsadas${task.charged ? ` (${task.charged} gemas)` : ''}.`,
      ),
    );
  else if (task.billing === 'FREE')
    say(
      io,
      tr(
        '这条是免费的，没有扣费。',
        'This one was free; nothing was charged.',
        'Este era gratis; no se cobró nada.',
        'Este foi grátis; nada foi cobrado.',
      ),
    );
  else say(io, tr('没有扣费。', 'Nothing was charged.', 'No se cobró nada.', 'Nada foi cobrado.'));
  return outcomeOf(target, task, rejected ? 'rejected' : 'failed');
}

async function succeeded(run: Run, target: Target, task: VideoTask): Promise<Outcome> {
  const { io, state, context, options } = run;
  say(
    io,
    paint(
      io,
      'green',
      tr(
        `✓ 视频已生成（${task.billing === 'FREE' ? '免费' : `扣除 ${task.charged} 钻石`}），结果 ${task.resultAssetId}`,
        `✓ Video generated (${task.billing === 'FREE' ? 'free' : `charged ${task.charged} gems`}), result ${task.resultAssetId}`,
        `✓ Video generado (${task.billing === 'FREE' ? 'gratis' : `se cobraron ${task.charged} gemas`}), resultado ${task.resultAssetId}`,
        `✓ Vídeo gerado (${task.billing === 'FREE' ? 'grátis' : `${task.charged} gemas cobradas`}), resultado ${task.resultAssetId}`,
      ),
    ),
  );
  addVideoResult(state, target.draftId, target.source, target.use, task.resultAssetId);
  say(
    io,
    tr(
      `已记为${VIDEO_USE_LABEL[target.use]}：之后 yomi create -f ${basename(target.source)} 会一起提交（选用最新一条；yomi preview 试聊不带视频）。`,
      `Kept as the ${VIDEO_USE_LABEL[target.use]}: yomi create -f ${basename(target.source)} will submit it (the newest is used; yomi preview does not include videos).`,
      `Guardado como ${VIDEO_USE_LABEL[target.use]}: yomi create -f ${basename(target.source)} lo enviará (se usa el más reciente; yomi preview no incluye videos).`,
      `Guardado como ${VIDEO_USE_LABEL[target.use]}: yomi create -f ${basename(target.source)} vai enviá-lo (o mais recente é usado; yomi preview não inclui vídeos).`,
    ),
  );
  try {
    const path = await saveVideoPreview(
      context.gateway,
      task.resultAssetId,
      mediaDir(options.out),
      `video-${target.requestId}`,
      context.fetch,
    );
    say(
      io,
      tr(
        `已保存预览：${path}`,
        `Preview saved: ${path}`,
        `Vista previa guardada: ${path}`,
        `Prévia salva: ${path}`,
      ),
    );
    return outcomeOf(target, task, 'succeeded', { files: [path] });
  } catch (error) {
    if (error instanceof NotSignedIn) throw error;
    const again = resumeCommand(target.source, target.requestId);
    warn(
      io,
      tr(
        `预览下载失败（${codeOf(error)}）。结果已经记下，重新下载：${again}`,
        `Preview download failed (${codeOf(error)}). The result is kept; download again with: ${again}`,
        `Falló la descarga de la vista previa (${codeOf(error)}). El resultado está guardado; vuelve a descargarla con: ${again}`,
        `O download da prévia falhou (${codeOf(error)}). O resultado está guardado; baixe de novo com: ${again}`,
      ),
    );
    return { ...outcomeOf(target, task, 'succeeded', { resume: again }), ok: false };
  }
}

// ---------------------------------------------------------------------------------------------
// --resume

async function resume(run: Run, requestId: string): Promise<Outcome> {
  const { io, state, context, spec, options, draftId } = run;
  say(
    io,
    tr(
      `继续查看 AI 视频请求 ${requestId}（${describeEnvironment(context.env)}）`,
      `Continuing AI video request ${requestId} (${describeEnvironment(context.env)})`,
      `Retomando la solicitud de video con IA ${requestId} (${describeEnvironment(context.env)})`,
      `Retomando a solicitação de vídeo com IA ${requestId} (${describeEnvironment(context.env)})`,
    ),
  );
  const saved = videoRequest(state, requestId);
  if (!saved) {
    // Not saved here (another machine, cleared state): looked up on this file's draft.
    dim(
      io,
      tr(
        '本机没有这个请求的记录，按这个角色文件的草稿查询。',
        "No record of this request on this machine; looking it up under this character file's draft.",
        'No hay registro de esta solicitud en este equipo; se busca en el borrador de este archivo del personaje.',
        'Não há registro desta solicitação nesta máquina; buscando no rascunho deste arquivo do personagem.',
      ),
    );
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
        warn(
          io,
          tr(
            `这个角色文件的草稿下找不到请求 ${requestId}（用 --list 查看）。`,
            `Request ${requestId} not found under this character file's draft (see --list).`,
            `No se encontró la solicitud ${requestId} en el borrador de este archivo del personaje (consulta --list).`,
            `Solicitação ${requestId} não encontrada no rascunho deste arquivo do personagem (veja --list).`,
          ),
        );
        return outcomeOf(target, null, 'unknown', { error_code: 'NOT_FOUND' });
      }
      throw error;
    }
    return follow(run, target, null, task);
  }
  const target = targetOf(saved);
  const again = resumeCommand(saved.source, requestId);
  if (saved.request.draft_id !== draftId)
    warn(
      io,
      tr(
        `这个请求属于另一个角色文件：${saved.source}（结果记在那个文件下）。`,
        `This request belongs to another character file: ${saved.source} (the result is kept under that file).`,
        `Esta solicitud pertenece a otro archivo del personaje: ${saved.source} (el resultado se guarda bajo ese archivo).`,
        `Esta solicitação pertence a outro arquivo do personagem: ${saved.source} (o resultado fica guardado nesse arquivo).`,
      ),
    );
  if (saved.state === 'accepted') return follow(run, target, saved, saved.task);

  // The create's answer was lost: does the server have it?
  dim(
    io,
    tr(
      '上次创建请求的结果未知，先向服务端确认…',
      "The last create request's outcome is unknown; checking with the server first…",
      'El resultado de la última solicitud de creación es desconocido; primero se consulta con el servidor…',
      'O resultado da última solicitação de criação é desconhecido; consultando o servidor primeiro…',
    ),
  );
  let task: VideoTask | null = null;
  try {
    task = await readTask(context.gateway, requestId, saved.request.draft_id);
  } catch (error) {
    if (!(error instanceof UgcFailure) || error.code !== 'NOT_FOUND') {
      warn(
        io,
        tr(
          `暂时确认不了（${codeOf(error)}）。请求仍保存在本机，稍后再试：${again}`,
          `Can't confirm right now (${codeOf(error)}). The request is still saved on this machine; try again later: ${again}`,
          `No se puede confirmar ahora (${codeOf(error)}). La solicitud sigue guardada en este equipo; inténtalo más tarde: ${again}`,
          `Não é possível confirmar agora (${codeOf(error)}). A solicitação continua salva nesta máquina; tente novamente mais tarde: ${again}`,
        ),
      );
      if (error instanceof NotSignedIn) throw error;
      return outcomeOf(target, null, 'unknown', { error_code: codeOf(error), resume: again });
    }
  }
  if (task) {
    say(
      io,
      tr(
        '服务端已经受理了这个请求（没有重复扣费）。',
        'The server had already accepted this request (not charged twice).',
        'El servidor ya había aceptado esta solicitud (no se cobró dos veces).',
        'O servidor já tinha aceitado esta solicitação (não foi cobrado duas vezes).',
      ),
    );
    saveVideoRequest(state, { ...saved, state: 'accepted', task });
    return follow(run, target, saved, task);
  }
  // Not there: the same saved request goes again (same ID and body; accepted at most once).
  say(
    io,
    tr(
      '服务端没有这个请求的记录。将重发当时保存的同一个请求（同一个请求 ID 和参数）。',
      'The server has no record of this request. The same saved request will be resent (same request ID and parameters).',
      'El servidor no tiene registro de esta solicitud. Se reenviará la misma solicitud guardada (mismo ID de solicitud y parámetros).',
      'O servidor não tem registro desta solicitação. A mesma solicitação salva será reenviada (mesmo ID da solicitação e parâmetros).',
    ),
  );
  const agreed = await confirmSpend(io, context.gateway, {
    action: tr(
      `重发生成 AI 视频的请求（${VIDEO_USE_LABEL[saved.use]}）`,
      `Resend the AI video request (${VIDEO_USE_LABEL[saved.use]})`,
      `Reenviar la solicitud de video con IA (${VIDEO_USE_LABEL[saved.use]})`,
      `Reenviar a solicitação de vídeo com IA (${VIDEO_USE_LABEL[saved.use]})`,
    ),
    total: saved.amount,
    acceptPrice: options.acceptPrice,
    notes: [
      tr(
        '报价可能已经过期：过期时服务端会拒绝且不扣费，重新运行生成即可。',
        'The quote may have expired: the server then refuses without charging, and you can simply generate again.',
        'Puede que la cotización haya vencido: en ese caso el servidor la rechaza sin cobrar y basta con volver a generar.',
        'A cotação pode ter expirado: nesse caso o servidor recusa sem cobrar, e basta gerar de novo.',
      ),
    ],
    replay: true,
  });
  if (!agreed) {
    say(
      io,
      tr(
        `没有重发。请求仍保存在本机：${again}`,
        `Not resent. The request is still saved on this machine: ${again}`,
        `No se reenvió. La solicitud sigue guardada en este equipo: ${again}`,
        `Não reenviada. A solicitação continua salva nesta máquina: ${again}`,
      ),
    );
    return outcomeOf(target, null, 'cancelled', { resume: again });
  }
  if (
    !(await confirmProduction(
      context,
      tr(
        '重发生成 AI 视频的请求（会扣钻石）',
        'resend the AI video request (charges gems)',
        'reenviar la solicitud de video con IA (cobra gemas)',
        'reenviar a solicitação de vídeo com IA (cobra gemas)',
      ),
      options.confirmProd,
    ))
  )
    return outcomeOf(target, null, 'cancelled', { resume: again });
  return submit(run, saved);
}
