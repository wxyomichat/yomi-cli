import type { Context } from '../../commands/context.js';
import { asciiJson } from '../../core/credentials.js';
import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { sha256 } from '../../core/state.js';
import { readLine } from '../../core/prompt.js';
import { confirm, type Io, paint, say, warn } from '../../core/ui.js';
import type { BotRecord } from '../registry.js';
import { encodeQr, QrTooLong, qrWidth, renderQr } from './qr.js';
import type { CredentialRequest } from './setup.js';
import {
  isLoopbackOrigin,
  trustedUrl,
  UntrustedHost,
  WechatError,
  WechatLoginApi,
  wechatOrigin,
} from './wechat-api.js';

/**
 * `yomi relay --channel wechat --experimental --login` (design §10.2): the QR login, at a
 * terminal only, while the environment's lock is held (commands/relay.ts). Whoever scans becomes
 * the bot's owner and spends this Yomi account's gems by Yomi's normal rules (no cap unless the
 * relay runs with --max-spend), so the code is treated like a password: the link is printed only
 * with `--qr-link` (or when the terminal is too narrow to draw the code), the drawing and the link
 * are erased from the terminal when the flow ends, and the `qrcode` value is never logged or
 * stored. At most three codes per login (a code expires, or the phone's digits were wrong too
 * often), eight minutes in all.
 *
 * One WeChat account may link several ClawBots: each scan that WeChat confirms for a new ClawBot
 * adds a bot (`--login --character ID`), and `--login --bot NAME` signs that one bot in again,
 * sending only its token (multi-bot design §1.2). WeChat names no bot when it answers that the
 * ClawBot is bound here already (`binded_redirect`): signing a bot in again keeps its login, and
 * adding one writes nothing. On `confirmed` the command keeps the login (`CredentialRequest.save`)
 * and the bot's state gets the scanner as its owner, unless it already has them (the same person
 * keeps their budget, pending charge and records); another scanner of the same bot replaces its
 * owner, whose budget and records go.
 */

/** What `--login` keeps in the keychain (design §5.3). */
export type WechatCredentials = {
  botToken: string;
  baseUrl: string;
  ilinkBotId: string;
  /** The scanner: the relay's owner. */
  ilinkUserId: string;
  savedAt: number;
};

export function parseCredentials(secret: string | null): WechatCredentials | null {
  if (!secret) return null;
  try {
    const value = JSON.parse(secret) as Partial<WechatCredentials>;
    if (
      typeof value.botToken !== 'string' ||
      !value.botToken ||
      typeof value.ilinkUserId !== 'string' ||
      !value.ilinkUserId
    )
      return null;
    return {
      botToken: value.botToken,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      ilinkBotId: typeof value.ilinkBotId === 'string' ? value.ilinkBotId : '',
      ilinkUserId: value.ilinkUserId,
      savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** The 16 hex characters the scope and the lock are named with: the scanner, hashed. */
export const ownerHash = (ilinkUserId: string) => sha256(ilinkUserId).slice(0, 16);
/** The relay state's scope: `wx:<sha256(ilink_user_id)[0:16]>` (design §5.2). */
export const wechatScope = (ilinkUserId: string) => `wx:${ownerHash(ilinkUserId)}`;

/** What the QR flow ended with. */
export type QrLoginResult =
  | { kind: 'confirmed'; credentials: WechatCredentials }
  /** WeChat says this ClawBot is already bound to this host: no new credentials. */
  | { kind: 'bound' };

export type QrLoginOptions = {
  /** Also print the QR code's link (`--qr-link`). */
  qrLink: boolean;
  /** `YOMI_WECHAT_API_ORIGIN` (a loopback mock); unset is iLink. */
  apiOrigin?: string;
  fetch?: typeof fetch;
  /** The whole flow at most (8 min, as the plugin waits). */
  overallMs?: number;
  /** One get_qrcode_status long poll at most (45 s). */
  pollTimeoutMs?: number;
  /** QR codes per login (3). */
  maxCodes?: number;
  signal?: AbortSignal;
};

const OVERALL_MS = 8 * 60_000;
const MAX_CODES = 3;
const DIGITS = /^[0-9]{4,8}$/;
/** Polls that bring the same status again are at least this far apart (the plugin waits 1 s). */
const POLL_GAP_MS = 1000;

/** Ends early when `signal` aborts; leaves no listener behind (a login may sleep hundreds of times). */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** East Asian wide and fullwidth code points (Hangul, CJK, kana, fullwidth forms): two columns each. */
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

const columnsOf = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
};

/**
 * How many terminal rows `text` takes on a terminal `columns` wide: a line longer than the
 * terminal wraps, and a wide character takes two columns. Colour codes take none.
 */
export function terminalRows(text: string, columns: number | undefined): number {
  let rows = 0;
  for (const line of text.split('\n')) {
    const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
    let width = 0;
    for (const character of plain) width += columnsOf(character);
    rows += columns && columns > 0 && width > columns ? Math.ceil(width / columns) : 1;
  }
  return rows;
}

const cancelled = () =>
  new UsageError(
    tr('已取消登录。', 'Login cancelled.', 'Inicio de sesión cancelado.', 'Login cancelado.'),
  );

/**
 * The lines the flow prints while a code is on screen, so they can all be erased at the end when
 * stdout is a terminal (the code is as good as the link to whoever sees it).
 */
class Screen {
  private lines = 0;

  constructor(private readonly io: Io) {}

  get tty(): boolean {
    return Boolean((this.io.stdout as { isTTY?: boolean }).isTTY);
  }

  get columns(): number | undefined {
    return (this.io.stdout as { columns?: number }).columns;
  }

  /** A line; counted in terminal rows, so a long link that wraps is erased whole. */
  say(text = '') {
    say(this.io, text);
    this.lines += terminalRows(text, this.columns);
  }

  /** A line typed on the terminal (a prompt on stderr, the digits, its newline). */
  typed(prompt: string) {
    this.lines += terminalRows(`${prompt}12345678`, this.columns);
  }

  /** Erases everything printed since the code was first drawn (a terminal only). */
  erase() {
    if (this.tty && this.lines) this.io.stdout.write(`\u001b[${this.lines}A\r\u001b[J`);
    this.lines = 0;
  }
}

/** Draws the code (or prints its link when it cannot be drawn here, or with --qr-link). */
function show(screen: Screen, io: Io, link: string, qrLink: boolean, count: number) {
  screen.erase();
  let drawn = false;
  try {
    const modules = encodeQr(link);
    const columns = screen.columns;
    if (!columns || columns >= qrWidth(modules.length)) {
      for (const line of renderQr(modules, io.colour)) screen.say(line);
      drawn = true;
    }
  } catch (error) {
    if (!(error instanceof QrTooLong)) throw error;
  }
  screen.say(
    count > 1
      ? tr(
          `二维码已刷新（第 ${count} 个）。用手机微信扫码并确认：`,
          `New QR code (number ${count}). Scan it with WeChat on your phone and confirm:`,
          `Nuevo código QR (número ${count}). Escanéalo con WeChat en tu teléfono y confirma:`,
          `Novo código QR (número ${count}). Escaneie com o WeChat no celular e confirme:`,
        )
      : tr(
          '用手机微信扫上面的二维码并确认：',
          'Scan the QR code above with WeChat on your phone and confirm:',
          'Escanea el código QR de arriba con WeChat en tu teléfono y confirma:',
          'Escaneie o código QR acima com o WeChat no celular e confirme:',
        ),
  );
  if (!drawn)
    screen.say(
      paint(
        io,
        'yellow',
        tr(
          '终端太窄，画不下二维码：在手机上打开下面的链接（不要发给别人）。',
          'The terminal is too narrow to draw the QR code: open the link below on your phone (do not send it to anyone).',
          'La terminal es demasiado estrecha para dibujar el código QR: abre el enlace de abajo en tu teléfono (no se lo envíes a nadie).',
          'O terminal é estreito demais para desenhar o código QR: abra o link abaixo no celular (não o envie a ninguém).',
        ),
      ),
    );
  if (qrLink || !drawn) screen.say(`  ${link}`);
}

/**
 * The QR flow on iLink's login host (`apiOrigin` in tests): a code, then `get_qrcode_status`
 * until it is confirmed, expired, refused or bound. Every host a response names is checked
 * before anything is sent to it.
 */
export async function qrLogin(
  io: Io,
  options: QrLoginOptions,
  storedTokens: string[],
): Promise<QrLoginResult> {
  const api = new WechatLoginApi(wechatOrigin(options.apiOrigin), options.fetch);
  const loopback = isLoopbackOrigin(api.origin);
  const screen = new Screen(io);
  const deadline = Date.now() + (options.overallMs ?? OVERALL_MS);
  const maxCodes = options.maxCodes ?? MAX_CODES;
  const signal = options.signal;
  const late = () =>
    new UsageError(
      tr(
        '登录超时（8 分钟内没有完成）：再运行一次 --login。',
        'The login timed out (not finished within 8 minutes): run --login again.',
        'El inicio de sesión expiró (no terminó en 8 minutos): vuelve a ejecutar --login.',
        'O login expirou (não terminou em 8 minutos): execute --login de novo.',
      ),
    );
  try {
    for (let codes = 1; ; codes++) {
      if (codes > maxCodes)
        throw new UsageError(
          tr(
            `二维码已经换了 ${maxCodes} 次还没有完成登录：再运行一次 --login。`,
            `${maxCodes} QR codes went by without a login: run --login again.`,
            `Pasaron ${maxCodes} códigos QR sin iniciar sesión: vuelve a ejecutar --login.`,
            `${maxCodes} códigos QR passaram sem login: execute --login de novo.`,
          ),
        );
      const code = await api.qrCode(storedTokens, signal);
      show(screen, io, code.qrcode_img_content, options.qrLink, codes);
      let origin = api.origin;
      let verifyCode = '';
      let scanned = false;
      let wrongDigits = false;
      let previous = '';
      for (;;) {
        if (signal?.aborted) throw cancelled();
        if (Date.now() > deadline) throw late();
        const polledAt = Date.now();
        const status = await api.qrStatus(origin, code.qrcode, verifyCode, {
          signal,
          timeoutMs: Math.min(options.pollTimeoutMs ?? 45_000, Math.max(1, deadline - Date.now())),
        });
        const sentDigits = Boolean(verifyCode);
        // Digits go with the next poll only.
        verifyCode = '';
        const value = status.status;
        // A failed poll, or a server answering the same at once, is not asked again right away.
        if (status.failed) await sleep(POLL_GAP_MS, signal);
        else if (value === previous && Date.now() - polledAt < POLL_GAP_MS)
          await sleep(POLL_GAP_MS - (Date.now() - polledAt), signal);
        previous = value;
        if (value === 'wait') continue;
        if (value === 'scaned') {
          if (!scanned)
            screen.say(
              tr(
                '已扫码，请在手机上确认。',
                'Scanned: confirm on your phone.',
                'Escaneado: confirma en tu teléfono.',
                'Escaneado: confirme no celular.',
              ),
            );
          scanned = true;
          continue;
        }
        if (value === 'scaned_but_redirect') {
          // Checked before the code is sent there.
          if (status.redirect_host)
            origin = trustedUrl(status.redirect_host, 'redirect_host', loopback);
          continue;
        }
        if (value.includes('need_verifycode')) {
          wrongDigits = wrongDigits || sentDigits;
          verifyCode = await askDigits(io, screen, wrongDigits);
          continue;
        }
        if (value === 'verify_code_blocked' || value === 'expired') {
          screen.say(
            value === 'expired'
              ? tr(
                  '二维码过期了。',
                  'The QR code expired.',
                  'El código QR expiró.',
                  'O código QR expirou.',
                )
              : tr(
                  '手机上的数字输错太多次了。',
                  'Too many wrong digits.',
                  'Demasiados dígitos incorrectos.',
                  'Dígitos errados demais.',
                ),
          );
          break;
        }
        if (value === 'binded_redirect') return { kind: 'bound' };
        if (value === 'confirmed')
          return { kind: 'confirmed', credentials: confirmed(status, api.origin, loopback) };
        if (/realname|spam/i.test(value))
          throw new UsageError(
            tr(
              '不支持绑定别人的 ClawBot：请用你自己的微信扫码。',
              "Binding another person's ClawBot is not supported: scan with your own WeChat.",
              'No se admite vincular el ClawBot de otra persona: escanea con tu propio WeChat.',
              'Não é possível vincular o ClawBot de outra pessoa: escaneie com o seu próprio WeChat.',
            ),
          );
        // A status this client does not know: keep waiting (the overall limit still applies).
      }
    }
  } finally {
    screen.erase();
  }
}

/** The login's credentials, its `baseurl` checked (iLink's login host when it names none). */
function confirmed(
  status: Awaited<ReturnType<WechatLoginApi['qrStatus']>>,
  origin: string,
  loopback: boolean,
): WechatCredentials {
  if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id)
    throw new WechatError('get_qrcode_status', 0, 'confirmed without credentials', 200);
  return {
    botToken: status.bot_token,
    baseUrl: trustedUrl(status.baseurl || origin, 'baseurl', loopback),
    ilinkBotId: status.ilink_bot_id,
    ilinkUserId: status.ilink_user_id,
    savedAt: Date.now(),
  };
}

/** The digits the phone shows (sent with the next poll only). */
async function askDigits(io: Io, screen: Screen, wrong: boolean): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    screen.say(
      wrong || attempt
        ? tr(
            '数字不对：请再输入一次手机上显示的数字。',
            'Those digits did not match: type the digits shown on your phone again.',
            'Esos dígitos no coinciden: vuelve a escribir los dígitos que muestra tu teléfono.',
            'Esses dígitos não conferem: digite de novo os dígitos mostrados no celular.',
          )
        : tr(
            '微信要求确认：输入手机上显示的数字。',
            'WeChat asks for a check: type the digits shown on your phone.',
            'WeChat pide una comprobación: escribe los dígitos que muestra tu teléfono.',
            'O WeChat pede uma verificação: digite os dígitos mostrados no celular.',
          ),
    );
    const prompt = tr('数字：', 'Digits: ', 'Dígitos: ', 'Dígitos: ');
    screen.typed(prompt);
    const digits = await readLine(io, prompt);
    if (DIGITS.test(digits)) return digits;
  }
  throw cancelled();
}

/** The notice before the code is shown; true when the person typed `yes`. */
async function agreed(io: Io): Promise<boolean> {
  const dim = (text: string) => say(io, paint(io, 'dim', text));
  dim(
    tr(
      '实验功能：微信 ClawBot（iLink）不是给第三方客户端的官方接口，对这类客户端的使用条款还不明确。请先在手机微信里阅读 ClawBot 的条款。仅限个人使用：relay 只转发你本人和你自己的 ClawBot 之间的消息。',
      "Experimental: WeChat ClawBot (iLink) is not an official API for third-party clients, and its terms for such clients are unclear. Read ClawBot's terms in WeChat on your phone first. Personal use only: this relays your own messages to your own ClawBot.",
      'Experimental: WeChat ClawBot (iLink) no es una API oficial para clientes de terceros y sus condiciones para esos clientes no están claras. Lee primero las condiciones de ClawBot en WeChat en tu teléfono. Solo para uso personal: esto reenvía tus propios mensajes a tu propio ClawBot.',
      'Experimental: o WeChat ClawBot (iLink) não é uma API oficial para clientes de terceiros, e os termos para esses clientes não são claros. Leia primeiro os termos do ClawBot no WeChat do celular. Somente para uso pessoal: isto repassa as suas próprias mensagens para o seu próprio ClawBot.',
    ),
  );
  dim(
    tr(
      '扫码的微信号会成为这个 relay 的主人，按 Yomi 的正常规则花这个账号的钻石（除非用 --max-spend 启动 relay，否则没有上限）：不要在共享屏幕、录屏或直播里显示二维码。',
      "Whoever scans becomes the owner of this relay and spends this account's gems by Yomi's normal rules (with no cap unless the relay runs with --max-spend): do not show the QR code on a shared screen, a recording or a stream.",
      'Quien escanee se convierte en el dueño de este relay y gasta las gemas de esta cuenta según las reglas habituales de Yomi (sin límite, salvo que el relay se ejecute con --max-spend): no muestres el código QR en una pantalla compartida, una grabación o una transmisión.',
      'Quem escanear vira o dono deste relay e gasta as gemas desta conta pelas regras normais do Yomi (sem limite, a menos que o relay rode com --max-spend): não mostre o código QR em tela compartilhada, gravação ou transmissão.',
    ),
  );
  return confirm(
    io,
    tr(
      '输入 yes 继续：',
      'Type yes to continue: ',
      'Escribe yes para continuar: ',
      'Digite yes para continuar: ',
    ),
    'yes',
  );
}

export type WechatLoginSeams = Omit<QrLoginOptions, 'qrLink' | 'apiOrigin' | 'signal'>;

/** `--login`: the notice, the QR flow, then the login kept and the owner. */
export async function wechatLogin(
  context: Context,
  request: CredentialRequest,
  seams: WechatLoginSeams = {},
): Promise<BotRecord | null> {
  const { io, store } = context;
  if (!io.interactive)
    throw new UsageError(
      tr(
        '--login 要在终端里运行：需要用手机微信扫码并确认。',
        '--login needs a terminal: you scan a QR code with WeChat on your phone and confirm.',
        '--login necesita una terminal: escaneas un código QR con WeChat en tu teléfono y confirmas.',
        '--login precisa de um terminal: você escaneia um código QR com o WeChat no celular e confirma.',
      ),
    );
  if (!(await agreed(io))) {
    say(io, cancelled().message);
    return null;
  }
  // The tokens this computer holds go with the request for a code: a ClawBot already linked here
  // is answered `binded_redirect`, never linked a second time.
  const tokens = request.stored.flatMap((secret) => parseCredentials(secret)?.botToken ?? []);
  // Ctrl+C ends the flow cleanly, so the code is erased from the terminal.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  let result: QrLoginResult;
  try {
    result = await qrLogin(
      io,
      {
        ...seams,
        qrLink: request.options.qrLink,
        apiOrigin: process.env.YOMI_WECHAT_API_ORIGIN,
        signal: controller.signal,
      },
      tokens,
    );
  } catch (error) {
    if (controller.signal.aborted) throw cancelled();
    if (error instanceof UntrustedHost) throw new UsageError(error.message);
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
  }
  if (result.kind === 'bound') {
    if (request.renew && tokens.length) {
      say(
        io,
        tr(
          '微信说这个 ClawBot 已经绑定在这台电脑上：保留已经保存的登录。',
          'WeChat says this ClawBot is already bound here: kept the saved login.',
          'WeChat dice que este ClawBot ya está vinculado aquí: se mantiene el inicio de sesión guardado.',
          'O WeChat diz que este ClawBot já está vinculado aqui: o login salvo foi mantido.',
        ),
      );
      return null;
    }
    // Which of this computer's ClawBots it is, WeChat does not say: nothing is written.
    if (tokens.length)
      throw new UsageError(
        tr(
          '微信说这个 ClawBot 已经是这台电脑上的一个 bot 了，没有保存任何东西。要重新登录它，运行 yomi relay --bot 名字 --login（名字见 yomi relay --list）。',
          'WeChat says this ClawBot is one of the bots on this computer already, so nothing was saved. To sign it in again, run yomi relay --bot NAME --login (the names are in yomi relay --list).',
          'WeChat dice que este ClawBot ya es uno de los bots de este equipo, así que no se guardó nada. Para volver a iniciar su sesión, ejecuta yomi relay --bot NOMBRE --login (los nombres están en yomi relay --list).',
          'O WeChat diz que este ClawBot já é um dos bots deste computador, então nada foi salvo. Para entrar com ele de novo, execute yomi relay --bot NOME --login (os nomes estão em yomi relay --list).',
        ),
      );
    throw new UsageError(
      tr(
        '微信说这个 ClawBot 已经绑定了，但这台电脑上没有保存登录：先在手机微信的设置里解除 ClawBot 的绑定，再运行 --login。',
        "WeChat says this ClawBot is already bound, but no login is saved on this computer: unbind ClawBot in WeChat's settings on your phone, then run --login again.",
        'WeChat dice que este ClawBot ya está vinculado, pero no hay ningún inicio de sesión guardado en este equipo: desvincula ClawBot en los ajustes de WeChat en tu teléfono y vuelve a ejecutar --login.',
        'O WeChat diz que este ClawBot já está vinculado, mas não há login salvo neste computador: desvincule o ClawBot nas configurações do WeChat no celular e execute --login de novo.',
      ),
    );
  }
  const { credentials } = result;
  const secret = asciiJson(credentials);
  const stored = {
    platformId: credentials.ilinkBotId,
    scope: wechatScope(credentials.ilinkUserId),
    lockName: `wx-${ownerHash(credentials.ilinkUserId)}`,
  };
  request.check(stored);
  let fresh = false;
  let replaced = false;
  const identity = { id: credentials.ilinkBotId, name: '', handle: '' };
  const record = request.save({ secret, stored, identity }, (state) => {
    // Another person scanned this bot: its owner, their budget and records go.
    const owner = state.data.owner;
    replaced = Boolean(owner && String(owner.userId) !== credentials.ilinkUserId);
    if (replaced) state.resetOwner();
    fresh = !state.data.owner;
    // The same person keeps their owner record, budget, pending charge and queue. A new owner is
    // owed the welcome, given before the answer to their first message.
    if (fresh)
      state.bindOwner({
        userId: credentials.ilinkUserId,
        chatId: credentials.ilinkUserId,
        name: '',
        language: '',
        pairedAt: Date.now(),
      });
    // A new login starts healthy: an hour's pause or a count of stale logins is the old one's.
    const channel = state.channelStore();
    if (channel.get('pausedUntil') !== undefined) channel.set('pausedUntil', undefined);
    if (channel.get('expiredCount') !== undefined) channel.set('expiredCount', undefined);
  });
  say(
    io,
    tr(
      `已保存微信 ClawBot 的登录（${store.kind === 'file' ? '本地文件 0600' : '系统钥匙串'}）。`,
      `Saved the WeChat ClawBot login (${store.kind === 'file' ? 'local file, mode 0600' : 'system keychain'}).`,
      `Se guardó el inicio de sesión de WeChat ClawBot (${store.kind === 'file' ? 'archivo local, permisos 0600' : 'llavero del sistema'}).`,
      `Login do WeChat ClawBot salvo (${store.kind === 'file' ? 'arquivo local, modo 0600' : 'Keychain do sistema'}).`,
    ),
  );
  if (replaced)
    warn(
      io,
      tr(
        `bot ${record.name} 换了一个微信号扫码：之前的主人、预算和记录已清除。`,
        `Another WeChat account scanned for the bot ${record.name}: its previous owner, budget and records were removed.`,
        `Otra cuenta de WeChat escaneó para el bot ${record.name}: se eliminaron su dueño anterior, su presupuesto y sus registros.`,
        `Outra conta do WeChat escaneou para o bot ${record.name}: o dono anterior, o orçamento e os registros dele foram removidos.`,
      ),
    );
  say(
    io,
    fresh
      ? tr(
          '扫码的微信号现在是这个 relay 的主人。',
          'The WeChat account that scanned is now the owner of this relay.',
          'La cuenta de WeChat que escaneó es ahora la dueña de este relay.',
          'A conta do WeChat que escaneou agora é a dona deste relay.',
        )
      : tr(
          '还是同一个微信号：主人、预算和记录都保留。',
          'The same WeChat account as before: its owner record, budget and records are kept.',
          'La misma cuenta de WeChat que antes: se conservan su registro de dueño, su presupuesto y sus registros.',
          'A mesma conta do WeChat de antes: o registro de dono, o orçamento e os registros foram mantidos.',
        ),
  );
  if (!request.atStart)
    say(
      io,
      tr(
        '接下来运行 yomi relay --channel wechat --experimental（可以加 --character 和 --max-spend）。',
        'Next, run yomi relay --channel wechat --experimental (with --character and --max-spend as needed).',
        'A continuación, ejecuta yomi relay --channel wechat --experimental (con --character y --max-spend si hace falta).',
        'Em seguida, execute yomi relay --channel wechat --experimental (com --character e --max-spend se precisar).',
      ),
    );
  return record;
}
