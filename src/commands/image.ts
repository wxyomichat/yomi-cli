import { NotSignedIn } from '../core/api.js';
import { describeEnvironment, UsageError } from '../core/env.js';
import { tr } from '../core/i18n.js';
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
    throw new UsageError(
      tr(
        '--resume 用来继续查看已有的一批，不能同时给 -p',
        '--resume is for watching an existing batch; it cannot be used with -p',
        '--resume sirve para seguir un lote existente; no se puede usar con -p',
        '--resume serve para acompanhar um lote existente; não pode ser usado com -p',
      ),
    );
  if (options.resume && !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.resume.trim()))
    throw new UsageError(
      tr(
        `--resume 需要批次 ID 或请求 ID，收到：${options.resume}`,
        `--resume needs a batch ID or request ID, got: ${options.resume}`,
        `--resume necesita un ID de lote o un ID de solicitud; se recibió: ${options.resume}`,
        `--resume precisa de um ID do lote ou um ID da solicitação; recebido: ${options.resume}`,
      ),
    );
  if (options.forget && !options.resume)
    throw new UsageError(
      tr(
        '--forget 需要配合 --resume <批次 ID 或请求 ID>',
        '--forget needs --resume <batch ID or request ID>',
        '--forget necesita --resume <ID de lote o ID de solicitud>',
        '--forget precisa de --resume <ID do lote ou ID da solicitação>',
      ),
    );
  if (options.forget && (options.pick !== null || options.into))
    throw new UsageError(
      tr(
        '--forget 只放弃本机的记录，不能同时用 --pick / --into',
        '--forget only stops tracking on this machine; it cannot be used with --pick / --into',
        '--forget solo deja de seguirlo en este equipo; no se puede usar con --pick / --into',
        '--forget só para de acompanhar nesta máquina; não pode ser usado com --pick / --into',
      ),
    );
  if (!options.resume && !options.prompt.trim())
    throw new UsageError(
      tr(
        '需要描述：yomi image -p "<描述>"（yomi image --options 查看可选模型和风格）',
        'A description is needed: yomi image -p "<description>" (yomi image --options lists the models and styles)',
        'Se necesita una descripción: yomi image -p "<descripción>" (yomi image --options muestra los modelos y estilos)',
        'É preciso uma descrição: yomi image -p "<descrição>" (yomi image --options lista os modelos e estilos)',
      ),
    );
  if (options.pick !== null && !options.into)
    throw new UsageError(
      tr(
        '--pick 需要配合 --into <角色文件> --as cover|avatar|both',
        '--pick needs --into <character file> --as cover|avatar|both',
        '--pick necesita --into <archivo del personaje> --as cover|avatar|both',
        '--pick precisa de --into <arquivo do personagem> --as cover|avatar|both',
      ),
    );
  if (options.into && options.pick === null)
    throw new UsageError(
      tr(
        '--into 需要配合 --pick N',
        '--into needs --pick N',
        '--into necesita --pick N',
        '--into precisa de --pick N',
      ),
    );
  if (options.as && !options.into)
    throw new UsageError(
      tr(
        '--as 需要配合 --pick N --into <角色文件>',
        '--as needs --pick N --into <character file>',
        '--as necesita --pick N --into <archivo del personaje>',
        '--as precisa de --pick N --into <arquivo do personagem>',
      ),
    );
  if (options.into && !PICK_TARGETS.includes(options.as))
    throw new UsageError(
      options.as
        ? tr(
            '--as 只能是 cover、avatar 或 both',
            '--as must be cover, avatar or both',
            '--as debe ser cover, avatar o both',
            '--as deve ser cover, avatar ou both',
          )
        : tr(
            '--into 需要配合 --as cover|avatar|both（写封面、头像或两者）',
            '--into needs --as cover|avatar|both (write the cover, the avatar or both)',
            '--into necesita --as cover|avatar|both (escribe la portada, el avatar o ambos)',
            '--into precisa de --as cover|avatar|both (grava a capa, o avatar ou ambos)',
          ),
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
    tr(
      `AI 生成角色图片：${config.enabled ? '可用' : paint(io, 'yellow', '暂未开放')}${config.version ? paint(io, 'dim', `（配置 ${config.version}）`) : ''}`,
      `AI character images: ${config.enabled ? 'available' : paint(io, 'yellow', 'not available yet')}${config.version ? paint(io, 'dim', ` (config ${config.version})`) : ''}`,
      `Imágenes de personaje con IA: ${config.enabled ? 'disponibles' : paint(io, 'yellow', 'aún no disponibles')}${config.version ? paint(io, 'dim', ` (configuración ${config.version})`) : ''}`,
      `Imagens de personagem com IA: ${config.enabled ? 'disponíveis' : paint(io, 'yellow', 'ainda não disponíveis')}${config.version ? paint(io, 'dim', ` (configuração ${config.version})`) : ''}`,
    ),
  );
  say(io);
  say(
    io,
    paint(
      io,
      'bold',
      tr(
        '模型（--model，默认第一个）',
        'Models (--model, default: the first)',
        'Modelos (--model, por defecto: el primero)',
        'Modelos (--model, padrão: o primeiro)',
      ),
    ),
  );
  for (const model of config.models) {
    const price =
      model.price === null
        ? paint(
            io,
            'yellow',
            tr(
              '价格未知（不能生成）',
              'price unknown (cannot generate)',
              'precio desconocido (no se puede generar)',
              'preço desconhecido (não é possível gerar)',
            ),
          )
        : tr(
            `${model.price} 钻石/张`,
            `${model.price} gems/image`,
            `${model.price} gemas/imagen`,
            `${model.price} gemas/imagem`,
          );
    const original =
      model.price !== null && model.originalPrice !== null && model.originalPrice > model.price
        ? paint(
            io,
            'dim',
            tr(
              `（原价 ${model.originalPrice}）`,
              ` (was ${model.originalPrice})`,
              ` (antes ${model.originalPrice})`,
              ` (antes ${model.originalPrice})`,
            ),
          )
        : '';
    say(io, `  ${paint(io, 'bold', model.id)}  ${model.name}  ${price}${original}`);
    if (model.description) say(io, paint(io, 'dim', `      ${model.description}`));
  }
  say(io);
  say(
    io,
    paint(
      io,
      'bold',
      tr(
        '风格（--style，默认不选；按模型）',
        'Styles (--style, default: none; per model)',
        'Estilos (--style, por defecto: ninguno; por modelo)',
        'Estilos (--style, padrão: nenhum; por modelo)',
      ),
    ),
  );
  for (const model of config.models) {
    const styles = stylesFor(config, model.id);
    say(
      io,
      tr(
        `  ${model.id}：${styles.length ? styles.map((style) => (style.name === style.id ? style.id : `${style.id}（${style.name}）`)).join('、') : paint(io, 'dim', '没有可选风格')}`,
        `  ${model.id}: ${styles.length ? styles.map((style) => (style.name === style.id ? style.id : `${style.id} (${style.name})`)).join(', ') : paint(io, 'dim', 'no styles')}`,
        `  ${model.id}: ${styles.length ? styles.map((style) => (style.name === style.id ? style.id : `${style.id} (${style.name})`)).join(', ') : paint(io, 'dim', 'sin estilos')}`,
        `  ${model.id}: ${styles.length ? styles.map((style) => (style.name === style.id ? style.id : `${style.id} (${style.name})`)).join(', ') : paint(io, 'dim', 'sem estilos')}`,
      ),
    );
  }
  say(io);
  say(
    io,
    tr(
      `比例（--ratio）：${config.ratios.length ? config.ratios.join('、') : '无'}${config.ratios.length ? paint(io, 'dim', `，默认 ${defaultRatio(config)}`) : ''}`,
      `Aspect ratios (--ratio): ${config.ratios.length ? config.ratios.join(', ') : 'none'}${config.ratios.length ? paint(io, 'dim', `, default ${defaultRatio(config)}`) : ''}`,
      `Relaciones de aspecto (--ratio): ${config.ratios.length ? config.ratios.join(', ') : 'ninguna'}${config.ratios.length ? paint(io, 'dim', `, por defecto ${defaultRatio(config)}`) : ''}`,
      `Proporções (--ratio): ${config.ratios.length ? config.ratios.join(', ') : 'nenhuma'}${config.ratios.length ? paint(io, 'dim', `, padrão ${defaultRatio(config)}`) : ''}`,
    ),
  );
  say(
    io,
    tr(
      `张数（--count）：1–${config.maxCount}，默认 ${Math.min(4, config.maxCount)}`,
      `Images (--count): 1–${config.maxCount}, default ${Math.min(4, config.maxCount)}`,
      `Imágenes (--count): 1–${config.maxCount}, por defecto ${Math.min(4, config.maxCount)}`,
      `Imagens (--count): 1–${config.maxCount}, padrão ${Math.min(4, config.maxCount)}`,
    ),
  );
  say(
    io,
    paint(
      io,
      'dim',
      tr(
        '价格按张计算；生成失败或未通过内容检查的那张自动退款。',
        'Priced per image; an image that fails to generate or fails the content check is refunded automatically.',
        'El precio es por imagen; una imagen que no se logra generar o no pasa la verificación de contenido se reembolsa automáticamente.',
        'O preço é por imagem; uma imagem que falha ao ser gerada ou não passa na verificação de conteúdo é reembolsada automaticamente.',
      ),
    ),
  );
}

function errorCode(error: unknown): string {
  if (error instanceof UgcFailure)
    return error.message && error.message !== error.code
      ? tr(
          `${error.code}：${error.message}`,
          `${error.code}: ${error.message}`,
          `${error.code}: ${error.message}`,
          `${error.code}: ${error.message}`,
        )
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
  say(
    human,
    tr(
      `AI 生成角色图片（${describeEnvironment(context.env)}）`,
      `AI character images (${describeEnvironment(context.env)})`,
      `Imágenes de personaje con IA (${describeEnvironment(context.env)})`,
      `Imagens de personagem com IA (${describeEnvironment(context.env)})`,
    ),
  );
  const config = await loadImageConfig(gateway);
  if (!config.enabled) {
    warn(
      human,
      tr(
        'AI 生成角色图片暂未开放。没有发出生成请求，没有扣费。',
        'AI character images are not available yet. No generation request was sent; nothing was charged.',
        'Las imágenes de personaje con IA aún no están disponibles. No se envió ninguna solicitud de generación; no se cobró nada.',
        'As imagens de personagem com IA ainda não estão disponíveis. Nenhuma solicitação de geração foi enviada; nada foi cobrado.',
      ),
    );
    report.refusal = { kind: 'unavailable', code: 'DISABLED' };
    return stop(report, 'refused');
  }
  const choice = chooseRequest(config, options);
  if (options.pick !== null && options.pick > choice.count)
    throw new UsageError(
      tr(
        `--pick 不能大于张数 ${choice.count}`,
        `--pick cannot be greater than the number of images (${choice.count})`,
        `--pick no puede ser mayor que la cantidad de imágenes (${choice.count})`,
        `--pick não pode ser maior que o número de imagens (${choice.count})`,
      ),
    );
  report.request = {
    prompt: choice.prompt,
    model: choice.model.id,
    style: choice.style?.id ?? '',
    ratio: choice.ratio,
    count: choice.count,
  };
  say(
    human,
    tr(
      `模型 ${choice.model.name}（${choice.model.id}）· 风格 ${choice.style ? choice.style.name : '不选'} · 比例 ${choice.ratio} · ${choice.count} 张`,
      `Model ${choice.model.name} (${choice.model.id}) · style ${choice.style ? choice.style.name : 'none'} · aspect ratio ${choice.ratio} · ${choice.count} image(s)`,
      `Modelo ${choice.model.name} (${choice.model.id}) · estilo ${choice.style ? choice.style.name : 'ninguno'} · relación de aspecto ${choice.ratio} · ${choice.count} imagen(es)`,
      `Modelo ${choice.model.name} (${choice.model.id}) · estilo ${choice.style ? choice.style.name : 'nenhum'} · proporção ${choice.ratio} · ${choice.count} imagem(ns)`,
    ),
  );
  const reference = options.reference ? loadReference(options.reference) : null;
  const intent = intentOf(choice, reference?.sha256 ?? '');
  const pending = pendingRecords(state);
  const others = pending.filter((record) => record.intent !== intent);
  if (others.length)
    warn(
      human,
      tr(
        `还有 ${others.length} 个结果未知的请求（${others.map((record) => record.requestId).join('、')}）：`,
        `There are still ${others.length} request(s) with an unknown outcome (${others.map((record) => record.requestId).join(', ')}): `,
        `Aún hay ${others.length} solicitud(es) con resultado desconocido (${others.map((record) => record.requestId).join(', ')}): `,
        `Ainda há ${others.length} solicitação(ões) com resultado desconhecido (${others.map((record) => record.requestId).join(', ')}): `,
      ) +
        tr(
          '可运行 yomi image --resume <请求 ID> 用原来的请求 ID 确认，避免重复生成；不要了就再加 --forget 放弃。',
          'run yomi image --resume <request ID> to confirm with the original request ID and avoid generating twice; to stop tracking one, add --forget.',
          'ejecuta yomi image --resume <ID de solicitud> para confirmar con el ID de solicitud original y no generar dos veces; para dejar de seguir una, agrega --forget.',
          'execute yomi image --resume <ID da solicitação> para confirmar com o ID da solicitação original e não gerar duas vezes; para parar de acompanhar uma, adicione --forget.',
        ),
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
    warn(
      human,
      tr(
        '生图配置缺少版本号，无法冻结报价。没有发出生成请求。',
        'The image configuration has no version, so the price cannot be locked. No generation request was sent.',
        'La configuración de imágenes no tiene versión, así que no se puede fijar el precio. No se envió ninguna solicitud de generación.',
        'A configuração de imagens não tem versão, então não é possível fixar o preço. Nenhuma solicitação de geração foi enviada.',
      ),
    );
    return stop(report, 'refused');
  }
  const price = batchPrice(choice.model, choice.count);
  if (!price) {
    warn(
      human,
      tr(
        `读不到模型 ${choice.model.id} 的价格，为避免扣费出错没有继续。`,
        `Could not read the price of model ${choice.model.id}; stopped to avoid a wrong charge.`,
        `No se pudo leer el precio del modelo ${choice.model.id}; se detuvo para evitar un cobro incorrecto.`,
        `Não foi possível ler o preço do modelo ${choice.model.id}; a operação foi interrompida para evitar uma cobrança incorreta.`,
      ),
    );
    return stop(report, 'refused');
  }
  const replay = pending.find((record) => record.intent === intent) ?? null;
  if (replay)
    warn(
      human,
      tr(
        `上次同样的请求（${replay.requestId}）结果未知。这次用同一个请求 ID 重发：服务端已受理过就直接返回原来的批次，不会重复扣费。`,
        `The outcome of the same request last time (${replay.requestId}) is unknown. Resending it with the same request ID: if the server already accepted it, it returns the original batch and nothing is charged twice.`,
        `El resultado de la misma solicitud la última vez (${replay.requestId}) es desconocido. Se reenvía con el mismo ID de solicitud: si el servidor ya la aceptó, devuelve el lote original y no se cobra dos veces.`,
        `O resultado da mesma solicitação da última vez (${replay.requestId}) é desconhecido. Ela será reenviada com o mesmo ID da solicitação: se o servidor já a aceitou, ele devolve o lote original e nada é cobrado duas vezes.`,
      ) +
        tr(
          `（不想重发它：yomi image --resume ${replay.requestId} --forget）`,
          ` (if you don't want to resend it: yomi image --resume ${replay.requestId} --forget)`,
          ` (si no quieres reenviarla: yomi image --resume ${replay.requestId} --forget)`,
          ` (se não quiser reenviá-la: yomi image --resume ${replay.requestId} --forget)`,
        ),
    );
  const unit = replay?.unitPrice ?? price.unit;
  const total = replay?.total ?? price.total;
  report.unitPrice = unit;
  report.total = total;
  const notes: string[] = [];
  if (!replay && price.original !== null)
    notes.push(
      tr(
        `原价 ${price.original} 钻石（划线价，仅展示）`,
        `Original price ${price.original} gems (shown struck through, for display only)`,
        `Precio original ${price.original} gemas (se muestra tachado, solo como referencia)`,
        `Preço original ${price.original} gemas (exibido riscado, apenas como referência)`,
      ),
    );
  notes.push(
    tr(
      '按张扣费：生成失败或未通过内容检查的那张自动退款。',
      'Charged per image: an image that fails to generate or fails the content check is refunded automatically.',
      'Cobro por imagen: una imagen que no se logra generar o no pasa la verificación de contenido se reembolsa automáticamente.',
      'Cobrança por imagem: uma imagem que falha ao ser gerada ou não passa na verificação de conteúdo é reembolsada automaticamente.',
    ),
  );
  const agreed = await confirmSpend(human, gateway, {
    action: tr(
      `生成 ${choice.count} 张角色图片`,
      `Generate ${choice.count} character image(s)`,
      `Generar ${choice.count} imagen(es) de personaje`,
      `Gerar ${choice.count} imagem(ns) de personagem`,
    ),
    total,
    unit: {
      price: unit,
      count: choice.count,
      label: tr('张', 'image', 'imagen', 'imagem'),
    },
    acceptPrice: options.acceptPrice,
    notes,
    replay: Boolean(replay),
  });
  if (!agreed) {
    say(
      human,
      tr(
        '没有发出生成请求，没有扣费。',
        'No generation request was sent; nothing was charged.',
        'No se envió ninguna solicitud de generación; no se cobró nada.',
        'Nenhuma solicitação de geração foi enviada; nada foi cobrado.',
      ),
    );
    return stop(report, 'cancelled');
  }
  const production = await confirmProduction(
    { ...context, io: human },
    tr(
      `花 ${total} 钻石生成 ${choice.count} 张角色图片`,
      `spend ${total} gems to generate ${choice.count} character image(s)`,
      `gastar ${total} gemas para generar ${choice.count} imagen(es) de personaje`,
      `gastar ${total} gemas para gerar ${choice.count} imagem(ns) de personagem`,
    ),
    options.confirmProd,
  );
  if (!production) {
    say(
      human,
      tr(
        '已取消，没有扣费。',
        'Cancelled; nothing was charged.',
        'Cancelado; no se cobró nada.',
        'Cancelado; nada foi cobrado.',
      ),
    );
    return stop(report, 'cancelled');
  }
  let record = replay;
  if (!record) {
    let uploaded: { uploadId: string; sha256: string } | null = null;
    if (reference) {
      say(
        human,
        paint(
          human,
          'dim',
          tr(
            `上传并审核参考图（${reference.width}×${reference.height}）…`,
            `Uploading and reviewing the reference image (${reference.width}×${reference.height})…`,
            `Subiendo y revisando la imagen de referencia (${reference.width}×${reference.height})…`,
            `Enviando e revisando a imagem de referência (${reference.width}×${reference.height})…`,
          ),
        ),
      );
      try {
        const receipt = await uploadReference(gateway, state, reference, context.fetch);
        uploaded = { uploadId: receipt.uploadId, sha256: reference.sha256 };
      } catch (error) {
        if (error instanceof UgcFailure && error.code === 'IMAGE_REJECTED') {
          warn(
            human,
            tr(
              '参考图未通过审核，请换一张。没有发出生成请求，没有扣费。',
              'The reference image did not pass review; please use another one. No generation request was sent; nothing was charged.',
              'La imagen de referencia no pasó la revisión; usa otra. No se envió ninguna solicitud de generación; no se cobró nada.',
              'A imagem de referência não passou na revisão; use outra. Nenhuma solicitação de geração foi enviada; nada foi cobrado.',
            ),
          );
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
      say(
        human,
        tr(
          '同样的请求刚由另一个 yomi 进程提交并已受理：这里接着查看那一批，不会再扣费。',
          'Another yomi process just sent the same request and it was accepted: watching that batch here; nothing more is charged.',
          'Otro proceso de yomi acaba de enviar la misma solicitud y fue aceptada: aquí se sigue ese lote; no se cobra nada más.',
          'Outro processo do yomi acabou de enviar a mesma solicitação e ela foi aceita: aqui acompanhamos esse lote; nada mais é cobrado.',
        ),
      );
      await continueBatch(context, human, state, record, options, target, report);
      return;
    }
    if (frozen.existing) {
      report.requestId = record.requestId;
      warn(
        human,
        tr(
          `同样的请求刚由另一个 yomi 进程提交（请求 ID ${record.requestId}），结果还没回来：这里没有再发，没有扣费。`,
          `Another yomi process just sent the same request (request ID ${record.requestId}) and its result is not back yet: nothing was sent here and nothing was charged. `,
          `Otro proceso de yomi acaba de enviar la misma solicitud (ID de solicitud ${record.requestId}) y su resultado aún no llega: aquí no se envió nada y no se cobró nada. `,
          `Outro processo do yomi acabou de enviar a mesma solicitação (ID da solicitação ${record.requestId}) e o resultado ainda não voltou: nada foi enviado aqui e nada foi cobrado. `,
        ) +
          tr(
            `稍后运行 yomi image --resume ${record.requestId} 查看它。`,
            `Run yomi image --resume ${record.requestId} later to check on it.`,
            `Ejecuta yomi image --resume ${record.requestId} más tarde para revisarla.`,
            `Execute yomi image --resume ${record.requestId} mais tarde para conferir.`,
          ),
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
      throw new UsageError(
        tr(
          `--pick 不能大于张数 ${record.count}`,
          `--pick cannot be greater than the number of images (${record.count})`,
          `--pick no puede ser mayor que la cantidad de imágenes (${record.count})`,
          `--pick não pode ser maior que o número de imagens (${record.count})`,
        ),
      );
  }
  if (record && !record.batchId) {
    // The create's answer was lost: the same request again, same ID, same body.
    say(
      human,
      tr(
        `重新确认结果未知的请求 ${record.requestId}（${record.count} 张 · ${record.modelId}，${describeEnvironment(context.env)}）`,
        `Rechecking request ${record.requestId}, whose outcome is unknown (${record.count} image(s) · ${record.modelId}, ${describeEnvironment(context.env)})`,
        `Volviendo a verificar la solicitud ${record.requestId}, con resultado desconocido (${record.count} imagen(es) · ${record.modelId}, ${describeEnvironment(context.env)})`,
        `Verificando de novo a solicitação ${record.requestId}, com resultado desconhecido (${record.count} imagem(ns) · ${record.modelId}, ${describeEnvironment(context.env)})`,
      ),
    );
    const agreed = await confirmSpend(human, context.gateway, {
      action: tr(
        `重发同一请求：生成 ${record.count} 张角色图片`,
        `Resend the same request: generate ${record.count} character image(s)`,
        `Reenviar la misma solicitud: generar ${record.count} imagen(es) de personaje`,
        `Reenviar a mesma solicitação: gerar ${record.count} imagem(ns) de personagem`,
      ),
      total: record.total,
      unit: {
        price: record.unitPrice,
        count: record.count,
        label: tr('张', 'image', 'imagen', 'imagem'),
      },
      acceptPrice: options.acceptPrice,
      notes: [
        tr(
          '用的是原来的请求 ID 和请求内容：服务端已受理过就直接返回原来的批次，不会重复扣费。',
          'It uses the original request ID and content: if the server already accepted it, it returns the original batch and nothing is charged twice.',
          'Usa el ID de solicitud y el contenido originales: si el servidor ya la aceptó, devuelve el lote original y no se cobra dos veces.',
          'Usa o ID da solicitação e o conteúdo originais: se o servidor já a aceitou, ele devolve o lote original e nada é cobrado duas vezes.',
        ),
      ],
      replay: true,
    });
    if (!agreed) {
      say(
        human,
        tr(
          '没有重发，没有扣费。这个请求仍然记着，可以之后再 --resume。',
          'Not resent; nothing was charged. The request is still saved, so you can --resume it later.',
          'No se reenvió; no se cobró nada. La solicitud sigue guardada, así que puedes usar --resume más tarde.',
          'Não foi reenviada; nada foi cobrado. A solicitação continua salva, então você pode usar --resume mais tarde.',
        ),
      );
      return stop(report, 'cancelled');
    }
    const production = await confirmProduction(
      { ...context, io: human },
      tr(
        `重发一个可能扣 ${record.total} 钻石的生图请求`,
        `resend an image request that may charge ${record.total} gems`,
        `reenviar una solicitud de imágenes que puede cobrar ${record.total} gemas`,
        `reenviar uma solicitação de imagens que pode cobrar ${record.total} gemas`,
      ),
      options.confirmProd,
    );
    if (!production) {
      say(
        human,
        tr(
          '已取消，没有重发。',
          'Cancelled; nothing was resent.',
          'Cancelado; no se reenvió nada.',
          'Cancelado; nada foi reenviado.',
        ),
      );
      return stop(report, 'cancelled');
    }
    // Resent on purpose: a request let go earlier is followed again.
    const sent = record.forgottenAt ? (adoptRecord(state, record.key) ?? record) : record;
    if (record.forgottenAt)
      say(
        human,
        paint(
          human,
          'dim',
          tr(
            '这个请求之前已放弃；现在按原样重发，之后同样的命令也会接着用它。',
            'Tracking of this request was stopped earlier; it is now resent as it was, and the same command uses it again from now on.',
            'Antes se dejó de seguir esta solicitud; ahora se reenvía tal cual, y desde ahora el mismo comando vuelve a usarla.',
            'Esta solicitação tinha deixado de ser acompanhada; agora ela é reenviada como estava, e a partir de agora o mesmo comando volta a usá-la.',
          ),
        ),
      );
    report.replayed = true;
    await submitAndFollow(context, human, state, sent, options, target, report);
    return;
  }
  const batchId = record?.batchId || id;
  report.batchId = batchId;
  say(
    human,
    tr(
      `继续查看批次 ${batchId}（只读取结果，不会扣费）`,
      `Watching batch ${batchId} (reading results only; nothing is charged)`,
      `Siguiendo el lote ${batchId} (solo se leen los resultados; no se cobra nada)`,
      `Acompanhando o lote ${batchId} (apenas lendo os resultados; nada é cobrado)`,
    ),
  );
  if (record && recordStatus(record) === 'forgotten')
    say(
      human,
      paint(
        human,
        'dim',
        tr(
          '这一批之前已放弃跟踪；查看不会改变这一点。',
          'Tracking of this batch was stopped earlier; viewing it does not change that.',
          'Antes se dejó de seguir este lote; verlo no cambia eso.',
          'Este lote tinha deixado de ser acompanhado; visualizá-lo não muda isso.',
        ),
      ),
    );
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
      tr(
        `上次同样的请求已受理（批次 ${record.batchId}），还没有结束：继续查看这一批，不会再扣费。`,
        `The same request was accepted last time (batch ${record.batchId}) and has not finished: watching that batch; nothing more is charged. `,
        `La misma solicitud se aceptó la última vez (lote ${record.batchId}) y no ha terminado: se sigue ese lote; no se cobra nada más. `,
        `A mesma solicitação foi aceita da última vez (lote ${record.batchId}) e ainda não terminou: acompanhando esse lote; nada mais é cobrado. `,
      ) +
        tr(
          '这一批结束后，再运行同样的命令才会生成新的一批（重新扣费）。',
          'Only after it finishes does the same command generate a new batch (charged again).',
          'Solo cuando termine, el mismo comando generará un lote nuevo (con un nuevo cobro).',
          'Só depois que ele terminar o mesmo comando vai gerar um novo lote (com nova cobrança).',
        ),
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
        tr(
          `读不到批次 ${batchId}（${errorCode(error)}）。它可能还在服务端进行，稍后再试；在它结束前，同样的命令只会继续查看它。`,
          `Could not read batch ${batchId} (${errorCode(error)}). It may still be running on the server; try again later. Until it finishes, the same command only watches it. `,
          `No se pudo leer el lote ${batchId} (${errorCode(error)}). Puede que siga en curso en el servidor; inténtalo más tarde. Hasta que termine, el mismo comando solo lo sigue. `,
          `Não foi possível ler o lote ${batchId} (${errorCode(error)}). Ele pode ainda estar em andamento no servidor; tente novamente mais tarde. Até ele terminar, o mesmo comando só o acompanha. `,
        ) +
          tr(
            `确定不再等它：运行 yomi image --resume ${batchId} --forget 放弃跟踪（之后同样的命令会生成新的一批并重新扣费）。`,
            `To stop waiting for it: run yomi image --resume ${batchId} --forget to stop tracking it (the same command then generates a new batch and charges again).`,
            `Para dejar de esperarlo: ejecuta yomi image --resume ${batchId} --forget para dejar de seguirlo (después el mismo comando genera un lote nuevo y vuelve a cobrar).`,
            `Para parar de esperar por ele: execute yomi image --resume ${batchId} --forget para parar de acompanhá-lo (depois o mesmo comando gera um novo lote e cobra de novo).`,
          ),
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
    throw new UsageError(
      tr(
        `本机没有 ${id} 的记录（--forget 只能放弃这台电脑记着的批次或请求）`,
        `No record of ${id} on this machine (--forget can only stop tracking batches or requests recorded on this machine)`,
        `No hay registro de ${id} en este equipo (--forget solo puede dejar de seguir lotes o solicitudes registrados en este equipo)`,
        `Não há registro de ${id} nesta máquina (--forget só pode parar de acompanhar lotes ou solicitações registrados nesta máquina)`,
      ),
    );
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
  const label = record.batchId
    ? tr(
        `批次 ${record.batchId}`,
        `Batch ${record.batchId}`,
        `Lote ${record.batchId}`,
        `Lote ${record.batchId}`,
      )
    : tr(
        `请求 ${record.requestId}`,
        `Request ${record.requestId}`,
        `Solicitud ${record.requestId}`,
        `Solicitação ${record.requestId}`,
      );
  if (status === 'settled') {
    say(
      human,
      tr(
        `${label} 已经结束，不需要放弃：同样的命令会生成新的一批。`,
        `${label} has already finished, so there is nothing to stop tracking: the same command generates a new batch.`,
        `${label} ya terminó, así que no hay nada que dejar de seguir: el mismo comando genera un lote nuevo.`,
        `${label} já terminou, então não há nada para parar de acompanhar: o mesmo comando gera um novo lote.`,
      ),
    );
    report.status = 'done';
    return;
  }
  report.status = 'forgotten';
  if (status === 'forgotten') {
    say(
      human,
      tr(
        `${label} 之前已经放弃，没有变化。`,
        `${label} was already untracked; nothing changed.`,
        `${label}: ya se había dejado de seguir; no cambió nada.`,
        `${label}: o acompanhamento já tinha sido interrompido; nada mudou.`,
      ),
    );
    return;
  }
  forgetRecord(state, record.key);
  if (status === 'running') {
    say(
      human,
      tr(
        `已放弃跟踪批次 ${record.batchId}：同样的命令不会再继续查看它，而会生成新的一批（重新扣费）。`,
        `Stopped tracking batch ${record.batchId}: the same command no longer watches it but generates a new batch (charged again).`,
        `Se dejó de seguir el lote ${record.batchId}: el mismo comando ya no lo sigue, sino que genera un lote nuevo (con un nuevo cobro).`,
        `O lote ${record.batchId} deixou de ser acompanhado: o mesmo comando não o acompanha mais e gera um novo lote (com nova cobrança).`,
      ),
    );
    warn(
      human,
      tr(
        '放弃跟踪不会取消服务端的生成，也不会退款：这一批已扣的钻石照常扣除，生成失败的那张仍会自动退款。',
        'This does not cancel the generation on the server or refund anything: the gems charged for this batch stay charged, and an image that fails to generate is still refunded automatically.',
        'Esto no cancela la generación en el servidor ni reembolsa nada: las gemas cobradas por este lote siguen cobradas, y una imagen que no se logra generar se sigue reembolsando automáticamente.',
        'Isso não cancela a geração no servidor nem reembolsa nada: as gemas cobradas por este lote continuam cobradas, e uma imagem que falha ao ser gerada continua sendo reembolsada automaticamente.',
      ),
    );
    say(
      human,
      tr(
        `之后仍可运行 yomi image --resume ${record.batchId} 查看和下载这一批（不会扣费）。`,
        `You can still run yomi image --resume ${record.batchId} later to view and download this batch (nothing is charged).`,
        `Aún puedes ejecutar yomi image --resume ${record.batchId} más tarde para ver y descargar este lote (no se cobra nada).`,
        `Você ainda pode executar yomi image --resume ${record.batchId} mais tarde para ver e baixar este lote (nada é cobrado).`,
      ),
    );
    return;
  }
  say(
    human,
    tr(
      `已放弃请求 ${record.requestId}：同样的命令不会再重发它，而会作为新请求重新扣费。`,
      `Stopped tracking request ${record.requestId}: the same command no longer resends it but sends a new request and charges again.`,
      `Se dejó de seguir la solicitud ${record.requestId}: el mismo comando ya no la reenvía, sino que envía una solicitud nueva y vuelve a cobrar.`,
      `A solicitação ${record.requestId} deixou de ser acompanhada: o mesmo comando não a reenvia mais e envia uma nova solicitação, cobrando de novo.`,
    ),
  );
  warn(
    human,
    tr(
      `注意：如果这个请求其实已经被服务端受理，它的扣费照常生效（最多 ${record.total} 钻石，生成失败的那张仍会自动退款），`,
      `Note: if the server did accept this request, its charge stands (at most ${record.total} gems; an image that fails to generate is still refunded automatically), `,
      `Nota: si el servidor sí aceptó esta solicitud, su cobro se mantiene (como máximo ${record.total} gemas; una imagen que no se logra generar se sigue reembolsando automáticamente), `,
      `Atenção: se o servidor de fato aceitou esta solicitação, a cobrança continua valendo (no máximo ${record.total} gemas; uma imagem que falha ao ser gerada continua sendo reembolsada automaticamente), `,
    ) +
      tr(
        '只是本机没有它的批次 ID，看不到也下载不到那批结果。',
        'but this machine has no batch ID for it, so those results cannot be viewed or downloaded.',
        'pero este equipo no tiene su ID de lote, así que esos resultados no se pueden ver ni descargar.',
        'mas esta máquina não tem o ID do lote dela, então esses resultados não podem ser vistos nem baixados.',
      ),
  );
  say(
    human,
    tr(
      `改主意了可以运行 yomi image --resume ${record.requestId}：用原来的请求 ID 重发，已受理就拿回原来的批次，不会重复扣费。`,
      `Changed your mind? Run yomi image --resume ${record.requestId}: it resends with the original request ID, gets the original batch back if it was accepted, and charges nothing twice.`,
      `¿Cambiaste de opinión? Ejecuta yomi image --resume ${record.requestId}: la reenvía con el ID de solicitud original, recupera el lote original si fue aceptada y no cobra dos veces.`,
      `Mudou de ideia? Execute yomi image --resume ${record.requestId}: a solicitação é reenviada com o ID da solicitação original, recupera o lote original se tiver sido aceita e nada é cobrado duas vezes.`,
    ),
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
  say(
    human,
    paint(
      human,
      'dim',
      tr(
        `提交生成请求（请求 ID ${record.requestId}）…`,
        `Sending the generation request (request ID ${record.requestId})…`,
        `Enviando la solicitud de generación (ID de solicitud ${record.requestId})…`,
        `Enviando a solicitação de geração (ID da solicitação ${record.requestId})…`,
      ),
    ),
  );
  let batch: ImageBatch;
  try {
    batch = await submitBatch(context.gateway, state, record, { replay: report.replayed });
  } catch (error) {
    if (error instanceof ReplayRefused) {
      explainRefusal(human, error.refusal);
      warn(
        human,
        tr(
          `被拒的只是这次重发。上次那次的结果一直未知，可能已经受理并扣了钻石（最多 ${record.total} 钻石），所以请求 ${record.requestId} 仍然记着：`,
          `Only this resend was refused. The outcome of the earlier send is still unknown; it may have been accepted and charged (at most ${record.total} gems), so request ${record.requestId} is still saved: `,
          `Solo se rechazó este reenvío. El resultado del envío anterior sigue siendo desconocido; puede que se haya aceptado y cobrado (como máximo ${record.total} gemas), así que la solicitud ${record.requestId} sigue guardada: `,
          `Só este reenvio foi recusado. O resultado do envio anterior continua desconhecido; ele pode ter sido aceito e cobrado (no máximo ${record.total} gemas), então a solicitação ${record.requestId} continua salva: `,
        ) +
          tr(
            `之后运行 yomi image --resume ${record.requestId} 用同一个请求 ID 再确认，服务端按请求 ID 去重，最多扣一次；确定不要了就再加 --forget。`,
            `run yomi image --resume ${record.requestId} later to confirm with the same request ID (the server deduplicates by request ID and charges at most once); if you no longer want it, add --forget.`,
            `ejecuta yomi image --resume ${record.requestId} más tarde para confirmar con el mismo ID de solicitud (el servidor elimina duplicados por ID de solicitud y cobra como máximo una vez); si ya no la quieres, agrega --forget.`,
            `execute yomi image --resume ${record.requestId} mais tarde para confirmar com o mesmo ID da solicitação (o servidor elimina duplicatas pelo ID da solicitação e cobra no máximo uma vez); se não quiser mais, adicione --forget.`,
          ),
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
      tr(
        `这次生成请求的结果未知（${errorCode(error)}）：可能已经受理并扣费，也可能没有。没有自动重发。`,
        `The outcome of this generation request is unknown (${errorCode(error)}): it may or may not have been accepted and charged. It was not resent automatically.`,
        `El resultado de esta solicitud de generación es desconocido (${errorCode(error)}): puede que se haya aceptado y cobrado, o puede que no. No se reenvió automáticamente.`,
        `O resultado desta solicitação de geração é desconhecido (${errorCode(error)}): ela pode ou não ter sido aceita e cobrada. Ela não foi reenviada automaticamente.`,
      ),
    );
    warn(
      human,
      tr(
        `运行 yomi image --resume ${record.requestId} 会用同一个请求 ID 重新确认，不会重复扣费。`,
        `Run yomi image --resume ${record.requestId} to confirm with the same request ID; nothing is charged twice.`,
        `Ejecuta yomi image --resume ${record.requestId} para confirmar con el mismo ID de solicitud; no se cobra dos veces.`,
        `Execute yomi image --resume ${record.requestId} para confirmar com o mesmo ID da solicitação; nada é cobrado duas vezes.`,
      ),
    );
    warn(
      human,
      tr(
        `同样的命令也会这样重发它；不想要这个请求了，运行 yomi image --resume ${record.requestId} --forget 放弃（如果其实已经受理，扣费照常生效）。`,
        `The same command resends it the same way; if you no longer want this request, run yomi image --resume ${record.requestId} --forget to stop tracking it (if it was in fact accepted, the charge stands).`,
        `El mismo comando la reenvía de la misma forma; si ya no quieres esta solicitud, ejecuta yomi image --resume ${record.requestId} --forget para dejar de seguirla (si en realidad se aceptó, el cobro se mantiene).`,
        `O mesmo comando a reenvia da mesma forma; se não quiser mais esta solicitação, execute yomi image --resume ${record.requestId} --forget para parar de acompanhá-la (se ela foi de fato aceita, a cobrança continua valendo).`,
      ),
    );
    return stop(report, 'unknown');
  }
  report.batchId = batch.id;
  say(
    human,
    tr(
      `已受理，批次 ${batch.id}。生成在服务端进行，中途退出不会取消；之后可运行 yomi image --resume ${batch.id} 继续查看（不会再扣费）。`,
      `Accepted, batch ${batch.id}. Generation runs on the server and quitting does not cancel it; run yomi image --resume ${batch.id} later to keep watching it (nothing more is charged).`,
      `Aceptada, lote ${batch.id}. La generación se hace en el servidor y salir no la cancela; ejecuta yomi image --resume ${batch.id} más tarde para seguir viéndolo (no se cobra nada más).`,
      `Aceita, lote ${batch.id}. A geração acontece no servidor e sair não a cancela; execute yomi image --resume ${batch.id} mais tarde para continuar acompanhando (nada mais é cobrado).`,
    ),
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
        onError: (error) =>
          warn(
            human,
            tr(
              `查询进度失败（${errorCode(error)}），继续查询…`,
              `Checking progress failed (${errorCode(error)}); still checking…`,
              `Falló la consulta del progreso (${errorCode(error)}); se sigue consultando…`,
              `Falha ao consultar o progresso (${errorCode(error)}); continuando a consultar…`,
            ),
          ),
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
  if (stopped)
    say(
      human,
      tr(
        '已停止查看。',
        'Stopped watching.',
        'Seguimiento detenido.',
        'Acompanhamento interrompido.',
      ),
    );
  if (done && record) markSettled(state, record.key);
  if (!done) {
    warn(
      human,
      tr(
        `还没有全部完成。停止查看不会取消服务端的生成，也不影响退款；稍后运行 yomi image --resume ${batchId} 继续查看（不会再扣费）。`,
        `Not everything has finished. Stopping does not cancel the generation on the server or affect refunds; run yomi image --resume ${batchId} later to keep watching (nothing more is charged).`,
        `Aún no ha terminado todo. Detenerse no cancela la generación en el servidor ni afecta los reembolsos; ejecuta yomi image --resume ${batchId} más tarde para seguir viéndolo (no se cobra nada más).`,
        `Nem tudo terminou ainda. Parar não cancela a geração no servidor nem afeta os reembolsos; execute yomi image --resume ${batchId} mais tarde para continuar acompanhando (nada mais é cobrado).`,
      ),
    );
    const tracked = record ? findRecord(state, record.key) : null;
    if (tracked && recordStatus(tracked) === 'running')
      warn(
        human,
        tr(
          '在这一批结束前，同样的命令只会继续查看它，不会重新生成。',
          'Until this batch finishes, the same command only watches it and does not generate again. ',
          'Hasta que este lote termine, el mismo comando solo lo sigue y no vuelve a generar. ',
          'Até este lote terminar, o mesmo comando só o acompanha e não gera de novo. ',
        ) +
          tr(
            `如果它一直不结束、确定不再等：运行 yomi image --resume ${batchId} --forget 放弃跟踪。`,
            `If it never finishes and you want to stop waiting: run yomi image --resume ${batchId} --forget to stop tracking it.`,
            `Si nunca termina y quieres dejar de esperar: ejecuta yomi image --resume ${batchId} --forget para dejar de seguirlo.`,
            `Se ele nunca terminar e você quiser parar de esperar: execute yomi image --resume ${batchId} --forget para parar de acompanhá-lo.`,
          ),
      );
  }

  // Results: addresses are read again right before downloading (they may expire).
  const saved = new Map<number, SavedImage>();
  const problems = new Map<number, string>();
  if (batch.outputs.some((output) => outcomeOf(output) === 'succeeded')) {
    try {
      batch = await readBatch(gateway, batchId);
    } catch (error) {
      warn(
        human,
        tr(
          `重新读取结果地址失败（${errorCode(error)}），先用刚才的结果。`,
          `Could not re-read the result URLs (${errorCode(error)}); using the ones already read.`,
          `No se pudieron volver a leer las URL de los resultados (${errorCode(error)}); se usan las ya leídas.`,
          `Não foi possível reler as URLs dos resultados (${errorCode(error)}); usando as já lidas.`,
        ),
      );
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
        problems.set(
          output.index,
          tr(
            '服务端没有给出可下载的地址',
            'the server gave no download URL',
            'el servidor no dio una URL de descarga',
            'o servidor não forneceu uma URL de download',
          ),
        );
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
      say(
        human,
        tr(
          `    原图     ${files.original}`,
          `    Original   ${files.original}`,
          `    Original    ${files.original}`,
          `    Original   ${files.original}`,
        ),
      );
      if (files.cover) {
        say(
          human,
          tr(
            `    封面 1:2 ${files.cover}`,
            `    Cover 1:2  ${files.cover}`,
            `    Portada 1:2 ${files.cover}`,
            `    Capa 1:2   ${files.cover}`,
          ),
        );
        say(
          human,
          tr(
            `    头像 1:1 ${files.avatar}`,
            `    Avatar 1:1 ${files.avatar}`,
            `    Avatar 1:1  ${files.avatar}`,
            `    Avatar 1:1 ${files.avatar}`,
          ),
        );
      } else {
        say(
          human,
          paint(
            human,
            'yellow',
            tr(
              `    本机不能裁剪这张原图（${files.note}），只保留了原图。`,
              `    This machine cannot crop this image (${files.note}); only the original was kept.`,
              `    Este equipo no puede recortar esta imagen (${files.note}); solo se guardó la original.`,
              `    Esta máquina não consegue recortar esta imagem (${files.note}); só a original foi mantida.`,
            ),
          ),
        );
        if (usableAsset(output.assetId))
          say(
            human,
            tr(
              `    角色文件里可以直接引用这次的生成结果（未裁剪）：cover: { asset_id: "${output.assetId}" }`,
              `    A character file can use this result directly (not cropped): cover: { asset_id: "${output.assetId}" }`,
              `    Un archivo del personaje puede usar este resultado directamente (sin recortar): cover: { asset_id: "${output.assetId}" }`,
              `    Um arquivo do personagem pode usar este resultado diretamente (sem recorte): cover: { asset_id: "${output.assetId}" }`,
            ),
          );
      }
    }
    const problem = problems.get(output.index);
    if (problem)
      warn(
        human,
        tr(
          `    下载失败：${problem}。可运行 yomi image --resume ${batchId} 重新下载。`,
          `    Download failed: ${problem}. Run yomi image --resume ${batchId} to download again.`,
          `    Falló la descarga: ${problem}. Ejecuta yomi image --resume ${batchId} para descargar de nuevo.`,
          `    Falha no download: ${problem}. Execute yomi image --resume ${batchId} para baixar de novo.`,
        ),
      );
  }
  const totals = billingTotals(batch, unit);
  if (unit !== null) {
    const parts = [
      tr(
        `共扣 ${totals.charged} 钻石`,
        `Charged ${totals.charged} gems in total`,
        `Se cobraron ${totals.charged} gemas en total`,
        `Foram cobradas ${totals.charged} gemas no total`,
      ),
    ];
    if (totals.refunded)
      parts.push(
        tr(
          `已退回 ${totals.refunded} 钻石`,
          `refunded ${totals.refunded} gems`,
          `se reembolsaron ${totals.refunded} gemas`,
          `${totals.refunded} gemas reembolsadas`,
        ),
      );
    if (totals.refunding)
      parts.push(
        tr(
          `退款中 ${totals.refunding} 钻石`,
          `refunding ${totals.refunding} gems`,
          `se están reembolsando ${totals.refunding} gemas`,
          `${totals.refunding} gemas em reembolso`,
        ),
      );
    if (totals.pending)
      parts.push(
        tr(
          `扣费确认中 ${totals.pending} 钻石`,
          `confirming the charge of ${totals.pending} gems`,
          `se está confirmando el cobro de ${totals.pending} gemas`,
          `confirmando a cobrança de ${totals.pending} gemas`,
        ),
      );
    say(human, parts.join(tr('，', ', ', ', ', ', ')) + tr('。', '.', '.', '.'));
  } else {
    const { pictures } = totals;
    say(
      human,
      tr(
        `已扣费 ${pictures.charged} 张，已退款 ${pictures.refunded} 张${pictures.refunding ? `，退款中 ${pictures.refunding} 张` : ''}。`,
        `Charged ${pictures.charged} image(s), refunded ${pictures.refunded}${pictures.refunding ? `, refunding ${pictures.refunding}` : ''}.`,
        `Imágenes cobradas: ${pictures.charged}, reembolsadas: ${pictures.refunded}${pictures.refunding ? `, en proceso de reembolso: ${pictures.refunding}` : ''}.`,
        `Imagens cobradas: ${pictures.charged}, reembolsadas: ${pictures.refunded}${pictures.refunding ? `, em reembolso: ${pictures.refunding}` : ''}.`,
      ),
    );
  }
  const unsettled = batch.outputs.some((output) => {
    const outcome = outcomeOf(output);
    return outcome === 'interrupted' || outcome === 'working';
  });
  if (done && unsettled)
    warn(
      human,
      tr(
        `有的图片还在确认结果；稍后运行 yomi image --resume ${batchId} 再查看（不会再扣费）。`,
        `Some images are still being confirmed; run yomi image --resume ${batchId} later to check again (nothing more is charged).`,
        `Algunas imágenes aún se están confirmando; ejecuta yomi image --resume ${batchId} más tarde para revisar de nuevo (no se cobra nada más).`,
        `Algumas imagens ainda estão sendo confirmadas; execute yomi image --resume ${batchId} mais tarde para conferir de novo (nada mais é cobrado).`,
      ),
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
      warn(
        human,
        tr(
          `第 ${options.pick} 张没有可用的结果，没有写入 ${options.into}。`,
          `Image ${options.pick} has no usable result; nothing was written to ${options.into}.`,
          `La imagen ${options.pick} no tiene un resultado utilizable; no se escribió nada en ${options.into}.`,
          `A imagem ${options.pick} não tem um resultado utilizável; nada foi gravado em ${options.into}.`,
        ),
      );
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
          tr(
            `✓ 已把第 ${options.pick} 张写进 ${options.into}：${Object.entries(values)
              .map(([key, value]) => `${key}: ${value}`)
              .join('，')}`,
            `✓ Wrote image ${options.pick} into ${options.into}: ${Object.entries(values)
              .map(([key, value]) => `${key}: ${value}`)
              .join(', ')}`,
            `✓ Se escribió la imagen ${options.pick} en ${options.into}: ${Object.entries(values)
              .map(([key, value]) => `${key}: ${value}`)
              .join(', ')}`,
            `✓ A imagem ${options.pick} foi gravada em ${options.into}: ${Object.entries(values)
              .map(([key, value]) => `${key}: ${value}`)
              .join(', ')}`,
          ),
        ),
      );
      if (!files.cover)
        warn(
          human,
          tr(
            '这张没有裁剪成 1:2 / 1:1，写入的是生成结果本身的引用；如果创建时不被接受，请自己裁好原图后改成文件路径。',
            'This image was not cropped to 1:2 / 1:1, so a reference to the generated result itself was written; if creating the character rejects it, crop the original yourself and use its file path instead.',
            'Esta imagen no se recortó a 1:2 / 1:1, así que se escribió una referencia al resultado generado en sí; si al crear el personaje se rechaza, recorta tú la original y usa la ruta de ese archivo.',
            'Esta imagem não foi recortada em 1:2 / 1:1, então foi gravada uma referência ao próprio resultado gerado; se a criação do personagem a recusar, recorte você mesmo a original e use o caminho desse arquivo.',
          ),
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
