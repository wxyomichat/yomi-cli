import { tr } from '../../core/i18n.js';
import { terminalText } from '../../core/ui.js';
import { type QqApi, qqGatewayUrl, QqError, tokenTooFrequent } from './qq-api.js';
import { QQ_CONSOLE_ZH as Z } from './qq-console.js';
import { ChannelError, RelayStopped } from './types.js';

/**
 * QQ's WebSocket gateway (https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)
 * as the relay keeps it: the address from `GET /gateway/bot`, Hello → Identify (intent
 * GROUP_AND_C2C_EVENT, `1 << 25`: private-chat messages, friend and active-message switches) or
 * Resume, heartbeats with the latest `s`, and the close codes of QQ's table. Starting a session
 * is rationed per day (`session_start_limit`), so the gateway Resumes whenever it has a session
 * (also one stored by the previous process) and Identifies only when none can be resumed: at most
 * once per 5 s, and never with the day's quota used up. Codes a restart cannot fix end the relay
 * (`RelayStopped`), as does a refused token (`tokenStop`); a token asked for too often (100001)
 * waits QQ's backoff (`TOKEN_RETRY_MS`); everything else reconnects, backing off from 1 s to 30 s.
 */

/** GROUP_AND_C2C_EVENT: C2C_MESSAGE_CREATE, FRIEND_ADD/DEL, C2C_MSG_REJECT/RECEIVE (and group events). */
export const C2C_INTENTS = 1 << 25;

export type QqDispatch = { t: string; d: unknown; s: number; id: string };

export type QqGatewayTimings = {
  backoffMinMs: number;
  backoffMaxMs: number;
  /** At most one Identify this often. */
  identifyIntervalMs: number;
  /** Op 9 (invalid session): wait 1-5 s before the next try. */
  invalidSessionDelayMs: () => number;
  /** No RESUMED this long after a Resume: the session is given up (Identify). */
  resumedTimeoutMs: number;
  /** Wake detection: a timer tick this often; a gap longer than `wakeGapMs` reconnects at once. */
  wakeTickMs: number;
  wakeGapMs: number;
  /** No Hello this long after connecting: try again. */
  helloTimeoutMs: number;
};

export const GATEWAY_TIMINGS: QqGatewayTimings = {
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  identifyIntervalMs: 5000,
  invalidSessionDelayMs: () => 1000 + Math.floor(Math.random() * 4000),
  resumedTimeoutMs: 10_000,
  wakeTickMs: 5000,
  wakeGapMs: 20_000,
  helloTimeoutMs: 15_000,
};

export type QqGatewayOptions = {
  api: QqApi;
  /** Ends the gateway (the relay's own signal). */
  signal: AbortSignal;
  log: (line: string) => void;
  /** Every dispatch other than READY and RESUMED, in order. */
  dispatch: (event: QqDispatch) => void;
  /**
   * A session is live: READY after an Identify (`resumed` false) or RESUMED. `lastAliveAt`: when
   * QQ was last heard from before this (0: not in this process).
   */
  ready: (info: { resumed: boolean; lastAliveAt: number }) => void;
  /** A session to resume first (stored by the previous process); null: Identify. */
  session: { sessionId: string; seq: number } | null;
  intents?: number;
  timings?: Partial<QqGatewayTimings>;
  /** What sets the AppSecret again, said when QQ refuses it (`tokenStopped`'s default). */
  renewCommand?: string;
};

/** How one connection ended. */
type Outcome =
  | { kind: 'closed'; code: number }
  | { kind: 'reconnect'; identify: boolean; delayMs: number };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** QQ's FAQ for bots. */
const QQ_FAQ = 'https://bot.q.qq.com/wiki/bot_FAQ/';

/**
 * QQ closed the gateway with 4014 (the intent is not allowed): only what is known. QQ's
 * documentation does not say where a bot gets private-chat events, so nothing here claims a switch.
 * The console's names are its own (`QQ_CONSOLE_ZH`), translated after them outside Chinese. The one
 * text for 4014: the relay, `--set-app` and the guide's check say it alike.
 */
export function noPrivateChatText(): string {
  return tr(
    `QQ 说这个 bot 没有私聊（单聊）消息事件的权限（4014），但 QQ 的文档没有写这个权限在哪里开启。请确认 q.qq.com 上这个机器人的${Z.devSettings} → ${Z.eventSubscription}用的是 WebSocket 方式；还不行的话，看 QQ 的常见问题 ${QQ_FAQ} 或者联系 QQ。`,
    `QQ says this bot has no permission for private chat (C2C) message events (4014), but QQ's documentation doesn't say where to enable it. On q.qq.com, check that ${Z.eventSubscription} (Event subscription) in the bot's ${Z.devSettings} (Development settings) uses WebSocket; if that doesn't help, see QQ's FAQ at ${QQ_FAQ} or contact QQ.`,
    `QQ dice que este bot no tiene permiso para los eventos de chat privado (C2C) (4014), pero la documentación de QQ no dice dónde activarlo. En q.qq.com, comprueba que ${Z.eventSubscription} (Suscripción de eventos), en ${Z.devSettings} (Configuración de desarrollo) del bot, use WebSocket; si no se soluciona, consulta las preguntas frecuentes de QQ en ${QQ_FAQ} o contacta con QQ.`,
    `O QQ diz que este bot não tem permissão para os eventos de chat privado (C2C) (4014), mas a documentação do QQ não diz onde ativá-la. Em q.qq.com, confira se ${Z.eventSubscription} (Assinatura de eventos), em ${Z.devSettings} (Configurações de desenvolvimento) do bot, usa WebSocket; se não resolver, veja as perguntas frequentes do QQ em ${QQ_FAQ} ou entre em contato com o QQ.`,
  );
}

/** QQ closed the gateway with 4013 (an invalid intent): this yomi and QQ's gateway disagree. */
export function gatewayProtocolText(): string {
  return tr(
    '这个版本的 yomi 和 QQ 网关的协议对不上（4013，无效的 intent）：请用 npm install -g @yomichat/cli 升级 yomi。',
    "This version of yomi doesn't match QQ's gateway protocol (4013, invalid intent): update yomi with npm install -g @yomichat/cli.",
    'Esta versión de yomi no coincide con el protocolo del gateway de QQ (4013, intent no válido): actualiza yomi con npm install -g @yomichat/cli.',
    'Esta versão do yomi não corresponde ao protocolo do gateway do QQ (4013, intent inválido): atualize o yomi com npm install -g @yomichat/cli.',
  );
}

/** "QQ … (code)": why the relay cannot go on, in the terminal's language. */
export function gatewayStopped(code: number): RelayStopped {
  if (code === 4014) return new RelayStopped('intents', noPrivateChatText());
  if (code === 4013) return new RelayStopped('protocol', gatewayProtocolText());
  if (code === 4914)
    return new RelayStopped(
      'delisted',
      tr(
        'QQ 说这个 bot 已下架，只能连接沙箱（4914）：请在 q.qq.com 查看这个 bot 的状态。',
        "QQ says this bot is delisted and may only connect to the sandbox (4914): check the bot's status on q.qq.com.",
        'QQ dice que este bot fue retirado y solo puede conectarse al entorno de pruebas (4914): revisa el estado del bot en q.qq.com.',
        'O QQ diz que este bot foi retirado e só pode se conectar ao ambiente de testes (4914): verifique o status do bot em q.qq.com.',
      ),
    );
  if (code === 4915)
    return new RelayStopped(
      'banned',
      tr(
        'QQ 封禁了这个 bot（4915）：只能在 q.qq.com 申请解封，relay 不会再连接。',
        'QQ has banned this bot (4915): an unban can only be requested on q.qq.com; the relay will not connect again.',
        'QQ bloqueó este bot (4915): solo se puede pedir el desbloqueo en q.qq.com; el relay no volverá a conectarse.',
        'O QQ bloqueou este bot (4915): só é possível pedir o desbloqueio em q.qq.com; o relay não vai se conectar de novo.',
      ),
    );
  return new RelayStopped(
    'protocol',
    tr(
      `QQ 网关拒绝了 relay 的请求（${code}）：这是 relay 的问题，请升级 yomi 或报告这个问题。`,
      `QQ's gateway refused the relay's request (${code}): this is a problem in the relay; update yomi or report it.`,
      `El gateway de QQ rechazó la solicitud del relay (${code}): es un problema del relay; actualiza yomi o repórtalo.`,
      `O gateway do QQ recusou a solicitação do relay (${code}): é um problema do relay; atualize o yomi ou relate o problema.`,
    ),
  );
}

/** QQ refused the AppID/AppSecret (token, REST 401, gateway 4004 twice). */
export function tokenStopped(again = 'yomi relay --channel qq --set-app'): RelayStopped {
  return new RelayStopped(
    'token',
    tr(
      `QQ 不认这个 AppID/AppSecret（可能在 q.qq.com 重置了）。请用 ${again} 重新设置。`,
      `QQ does not accept this AppID/AppSecret (it may have been reset on q.qq.com). Set them again with ${again}.`,
      `QQ no acepta este AppID/AppSecret (puede que se haya restablecido en q.qq.com). Vuelve a configurarlos con ${again}.`,
      `O QQ não aceita este AppID/AppSecret (ele pode ter sido redefinido em q.qq.com). Configure-os novamente com ${again}.`,
    ),
  );
}

/** Where QQ explains the server IP whitelist (its guide, §8.2). */
const IP_WHITELIST_GUIDE =
  'https://bot.q.qq.com/wiki/#_8-2-%E6%9C%8D%E5%8A%A1%E5%99%A8-ip-%E7%99%BD%E5%90%8D%E5%8D%95';

/** QQ's token says the bot is not there (100007, 10004): a wrong AppID, or banned or deleted. */
export function botGoneText(code: number | string): string {
  return tr(
    `QQ 说没有这个机器人，或者它已被封禁、删除（${code}）：请在 q.qq.com 核对 AppID 和这个机器人的状态；删除后 7 天内可以在 https://q.qq.com/qqbot/openclaw/ 恢复。`,
    `QQ says there is no such bot, or it was banned or deleted (${code}): check the AppID and the bot's status on q.qq.com; a deleted bot can be restored within 7 days at https://q.qq.com/qqbot/openclaw/.`,
    `QQ dice que ese bot no existe, o que fue bloqueado o eliminado (${code}): revisa el AppID y el estado del bot en q.qq.com; un bot eliminado se puede restaurar en un plazo de 7 días en https://q.qq.com/qqbot/openclaw/.`,
    `O QQ diz que esse bot não existe, ou que foi bloqueado ou excluído (${code}): confira o AppID e o status do bot em q.qq.com; um bot excluído pode ser restaurado em até 7 dias em https://q.qq.com/qqbot/openclaw/.`,
  );
}

/**
 * QQ refused the token with a code of its own: its words (made safe to print), and the server IP
 * whitelist as a guess QQ's documentation does not confirm.
 */
export function tokenRefusedText(code: number | string, words: string): string {
  const said = terminalText(words.trim());
  return tr(
    `QQ 拒绝了换取令牌（${code}${said ? `：${said}` : ''}）。如果在这个机器人的「服务器 IP 白名单」里加过 IP，有可能是白名单拦了（未确认）：把这台电脑现在的公网 IPv4 加进去，或者清空白名单。说明：${IP_WHITELIST_GUIDE}`,
    `QQ refused to issue a token (${code}${said ? `: ${said}` : ''}). If you added IPs to the bot's server IP whitelist on q.qq.com, the whitelist may be blocking this computer (unconfirmed): add this computer's current public IPv4, or empty the whitelist. Guide: ${IP_WHITELIST_GUIDE}`,
    `QQ se negó a emitir un token (${code}${said ? `: ${said}` : ''}). Si agregaste IP a la lista blanca de IP del servidor del bot en q.qq.com, puede que la lista esté bloqueando este equipo (sin confirmar): agrega la IPv4 pública actual de este equipo o vacía la lista. Guía: ${IP_WHITELIST_GUIDE}`,
    `O QQ se recusou a emitir um token (${code}${said ? `: ${said}` : ''}). Se você adicionou IPs à lista de permissões de IP do servidor do bot em q.qq.com, talvez ela esteja bloqueando este computador (não confirmado): adicione o IPv4 público atual deste computador ou esvazie a lista. Guia: ${IP_WHITELIST_GUIDE}`,
  );
}

/** QQ said the token was asked for too often (100001): when the next request goes. */
export function tokenRetryText(error: QqError): string {
  const seconds = Math.max(1, Math.round(error.retryAfterMs / 1000));
  return tr(
    `QQ 说换取令牌的请求太频繁（${error.code}），${seconds} 秒后重试`,
    `QQ says the token was requested too often (${error.code}); retrying in ${seconds} s`,
    `QQ dice que el token se pidió con demasiada frecuencia (${error.code}); se reintentará en ${seconds} s`,
    `O QQ diz que o token foi pedido com frequência demais (${error.code}); tentando novamente em ${seconds} s`,
  );
}

/**
 * What ends the relay when QQ refuses its token (or REST twice in a row with 401): the
 * AppID/AppSecret ('token', set them again with `again`), a bot that is gone ('gone'), another
 * refusal ('refused'); null for anything else.
 */
export function tokenStop(error: unknown, again?: string): RelayStopped | null {
  if (!(error instanceof ChannelError)) return null;
  if (error.reason === 'unauthorized') return tokenStopped(again);
  if (error.reason === 'gone') return new RelayStopped('gone', botGoneText(error.code));
  if (error.reason === 'refused')
    return new RelayStopped('refused', tokenRefusedText(error.code, error.description));
  return null;
}

const STOP_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);

/**
 * Resumes in a row that QQ neither confirmed (RESUMED) nor refused (op 9, 4006/4007) before the
 * connection ended: the session is given up and the next connection Identifies, so a session QQ
 * no longer knows cannot keep the relay reconnecting forever.
 */
const RESUME_TRIES_MAX = 3;

export class QqGateway {
  /** The live (or resumable) session; '' when the next connection must Identify. */
  sessionId = '';
  /** The latest `s` received (heartbeats and in-process Resumes). */
  seq = 0;
  /** When the gateway last heard from QQ (a dispatch or a heartbeat ACK). */
  aliveAt = 0;
  private readonly timings: QqGatewayTimings;
  private readonly stop = new AbortController();
  private socket: WebSocket | null = null;
  private lastIdentifyAt = 0;
  private quotaLogged = false;
  /** Resumes sent since a session was last established (READY or RESUMED). */
  private resumeTries = 0;

  constructor(private readonly options: QqGatewayOptions) {
    this.timings = { ...GATEWAY_TIMINGS, ...options.timings };
    if (options.session) {
      this.sessionId = options.session.sessionId;
      this.seq = options.session.seq;
    }
    const onAbort = () => this.close();
    if (options.signal.aborted) this.stop.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  /** Stops the gateway: the socket is closed and run() returns. */
  close(): void {
    this.stop.abort();
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
  }

  /** Connects and keeps the connection until close(); rejects with RelayStopped. */
  async run(): Promise<void> {
    const { log } = this.options;
    const signal = this.stop.signal;
    let backoff = this.timings.backoffMinMs;
    let authFailures = 0;
    while (!signal.aborted) {
      let outcome: Outcome;
      let established = false;
      try {
        outcome = await this.connectOnce(() => {
          established = true;
        });
      } catch (error) {
        if (error instanceof RelayStopped) throw error;
        if (signal.aborted) return;
        const stopped = tokenStop(error, this.options.renewCommand);
        if (stopped) throw stopped;
        // Too many token requests (100001): no new one before QQ's backoff ends.
        if (tokenTooFrequent(error)) {
          log(tokenRetryText(error));
          await sleep(Math.max(backoff, error.retryAfterMs), signal);
        } else {
          log(
            tr(
              `QQ 暂时连不上，${Math.round(backoff / 1000)} 秒后重试`,
              `Can't reach QQ right now, retrying in ${Math.round(backoff / 1000)} s`,
              `No se puede conectar con QQ en este momento, se reintentará en ${Math.round(backoff / 1000)} s`,
              `Não foi possível conectar ao QQ agora, tentando novamente em ${Math.round(backoff / 1000)} s`,
            ),
          );
          await sleep(backoff, signal);
        }
        backoff = Math.min(backoff * 2, this.timings.backoffMaxMs);
        continue;
      }
      if (signal.aborted) return;
      if (established) {
        backoff = this.timings.backoffMinMs;
        authFailures = 0;
      }
      if (outcome.kind === 'reconnect') {
        if (outcome.identify) this.sessionId = '';
        // A connection that never got a session (op 7 or 9 right away, no RESUMED) waits like
        // any failure: never a tight loop of /gateway/bot calls and sockets.
        let delay = outcome.delayMs;
        if (!established) {
          delay = Math.max(delay, backoff);
          backoff = Math.min(backoff * 2, this.timings.backoffMaxMs);
        }
        await sleep(delay, signal);
        continue;
      }
      const code = outcome.code;
      if (STOP_CODES.has(code)) throw gatewayStopped(code);
      if (code === 4004) {
        // The token was refused: a new one, and the session is kept.
        authFailures += 1;
        if (authFailures >= 2) throw tokenStopped(this.options.renewCommand);
        this.options.api.tokens.invalidate();
        continue;
      }
      // Invalid session or seq; QQ's own failures (4900-4913) allow no Resume either.
      if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) this.sessionId = '';
      log(
        tr(
          `QQ 连接断开（${code}），${Math.round(backoff / 1000)} 秒后重连`,
          `QQ connection closed (${code}), reconnecting in ${Math.round(backoff / 1000)} s`,
          `Se cerró la conexión con QQ (${code}), se reconectará en ${Math.round(backoff / 1000)} s`,
          `A conexão com o QQ foi fechada (${code}), reconectando em ${Math.round(backoff / 1000)} s`,
        ),
      );
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, this.timings.backoffMaxMs);
    }
  }

  /** `/gateway/bot`; before an Identify, also waits for the day's quota and the 5 s spacing. */
  private async address(identify: boolean): Promise<string> {
    const signal = this.stop.signal;
    for (;;) {
      const info = await this.options.api.gatewayBot();
      const url = qqGatewayUrl(String(info.url ?? ''), this.options.api.origin);
      if (!identify) return url;
      const limit = info.session_start_limit;
      if (limit && limit.remaining === 0) {
        const wait = Math.max(Number(limit.reset_after) || 60_000, 1000);
        if (!this.quotaLogged) {
          const at = new Date(Date.now() + wait);
          const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
          this.options.log(
            tr(
              `QQ 今天的连接次数已用完，${time} 再试`,
              `QQ's connection quota for today is used up; next try at ${time}`,
              `Se agotó la cuota de conexiones de QQ de hoy; se volverá a intentar a las ${time}`,
              `A cota de conexões do QQ de hoje acabou; nova tentativa às ${time}`,
            ),
          );
          this.quotaLogged = true;
        }
        await sleep(wait, signal);
        if (signal.aborted) throw new Error('stopped');
        continue;
      }
      this.quotaLogged = false;
      const wait = this.lastIdentifyAt + this.timings.identifyIntervalMs - Date.now();
      if (wait > 0) await sleep(wait, signal);
      if (signal.aborted) throw new Error('stopped');
      return url;
    }
  }

  private async connectOnce(established: () => void): Promise<Outcome> {
    if (this.sessionId && this.resumeTries >= RESUME_TRIES_MAX) this.sessionId = '';
    if (!this.sessionId) this.resumeTries = 0;
    const identify = !this.sessionId;
    const url = await this.address(identify);
    const signal = this.stop.signal;
    // Stopped while /gateway/bot was answering: no socket may outlive the relay (it would keep
    // the process running and take the owner's messages).
    if (signal.aborted) return { kind: 'reconnect', identify: false, delayMs: 0 };
    const { api, intents = C2C_INTENTS } = this.options;
    return new Promise<Outcome>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let resumed: ReturnType<typeof setTimeout> | null = null;
      let acked = true;
      let missed = 0;
      let lastTick = Date.now();
      const hello = setTimeout(
        () => finish({ kind: 'closed', code: 0 }),
        this.timings.helloTimeoutMs,
      );
      // A computer that slept (or a network that changed) is noticed by a late tick.
      const wake = setInterval(() => {
        const now = Date.now();
        if (now - lastTick > this.timings.wakeGapMs)
          finish({ kind: 'reconnect', identify: false, delayMs: 0 });
        lastTick = now;
      }, this.timings.wakeTickMs);
      wake.unref?.();
      // An outcome, or a refused token that run() handles as when /gateway/bot met it.
      const finish = (outcome: Outcome | QqError) => {
        if (settled) return;
        settled = true;
        clearTimeout(hello);
        clearInterval(wake);
        if (heartbeat) clearInterval(heartbeat);
        if (resumed) clearTimeout(resumed);
        signal.removeEventListener('abort', onAbort);
        socket.onmessage = socket.onclose = socket.onerror = null;
        if (this.socket === socket) this.socket = null;
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        if (outcome instanceof QqError) reject(outcome);
        else resolve(outcome);
      };
      const onAbort = () => finish({ kind: 'reconnect', identify: false, delayMs: 0 });
      signal.addEventListener('abort', onAbort, { once: true });
      const send = (payload: unknown) => {
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          // The close handler reconnects.
        }
      };
      const beat = () => send({ op: 1, d: this.seq || null });
      // The payload is built right after asking for the token: a Resume after a refresh carries
      // the fresh one.
      const authenticate = async () => {
        let token: string;
        try {
          token = await api.tokens.get();
        } catch (error) {
          if (error instanceof QqError && error.reason === 'unauthorized') {
            finish({ kind: 'closed', code: 4004 });
            return;
          }
          // A bot gone, another refusal, too many requests: not a connection that failed.
          if (error instanceof QqError && error.reason !== 'transient') {
            finish(error);
            return;
          }
          finish({ kind: 'closed', code: 0 });
          return;
        }
        if (settled) return;
        if (this.sessionId) {
          this.resumeTries += 1;
          send({
            op: 6,
            d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq },
          });
          resumed = setTimeout(
            () => finish({ kind: 'reconnect', identify: true, delayMs: 0 }),
            this.timings.resumedTimeoutMs,
          );
        } else {
          this.lastIdentifyAt = Date.now();
          send({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents,
              shard: [0, 1],
              properties: { $os: process.platform, $browser: 'yomi-cli', $device: 'yomi-cli' },
            },
          });
        }
      };
      socket.onmessage = (event) => {
        let payload: { op?: number; d?: unknown; s?: number; t?: string; id?: string };
        try {
          payload = JSON.parse(String(event.data)) as typeof payload;
        } catch {
          return;
        }
        switch (payload.op) {
          case 10: {
            clearTimeout(hello);
            const interval = Number(
              (payload.d as { heartbeat_interval?: number })?.heartbeat_interval,
            );
            heartbeat = setInterval(
              () => {
                if (!acked) {
                  missed += 1;
                  // No ACK for two intervals: the connection is dead even if the socket is not.
                  if (missed >= 2)
                    return finish({ kind: 'reconnect', identify: false, delayMs: 0 });
                }
                acked = false;
                beat();
              },
              interval > 0 ? interval : 41_250,
            );
            heartbeat.unref?.();
            void authenticate();
            return;
          }
          case 11:
            acked = true;
            missed = 0;
            this.aliveAt = Date.now();
            return;
          case 1:
            beat();
            return;
          case 7:
            return finish({ kind: 'reconnect', identify: false, delayMs: 0 });
          case 9:
            return finish({
              kind: 'reconnect',
              identify: !payload.d,
              delayMs: this.timings.invalidSessionDelayMs(),
            });
          case 0: {
            if (typeof payload.s === 'number' && payload.s > 0) this.seq = payload.s;
            const lastAliveAt = this.aliveAt;
            this.aliveAt = Date.now();
            if (payload.t === 'READY') {
              const data = payload.d as { session_id?: string } | undefined;
              this.sessionId = String(data?.session_id ?? '');
              this.resumeTries = 0;
              established();
              this.options.ready({ resumed: false, lastAliveAt });
              return;
            }
            if (payload.t === 'RESUMED') {
              if (resumed) clearTimeout(resumed);
              resumed = null;
              this.resumeTries = 0;
              established();
              this.options.ready({ resumed: true, lastAliveAt });
              return;
            }
            this.options.dispatch({
              t: String(payload.t ?? ''),
              d: payload.d,
              s: Number(payload.s ?? 0),
              id: String(payload.id ?? ''),
            });
            return;
          }
          default:
        }
      };
      socket.onclose = (event) => finish({ kind: 'closed', code: event.code });
    });
  }
}

/** What one check of the gateway found (`probeGatewayDetail`). */
export type GatewayProbe = {
  /**
   * 'ok': READY; 'intents': QQ closed it with 4014 (the bot may not have the intent); 'protocol':
   * 4013 (QQ calls the intent invalid); 'failed': anything else (no answer within the time, another
   * close: `closeCode`, the network).
   */
  result: 'ok' | 'intents' | 'protocol' | 'failed';
  /** The close code QQ ended the connection with (0: none). */
  closeCode: number;
  /** Session starts left today, as `/gateway/bot` said before the check (null: not said). */
  remaining: number | null;
  /** When they come back, in ms from then (null: not said). */
  resetAfterMs: number | null;
  /** When the Identify went (0: none went), for QQ's 5 s between two of them. */
  identifiedAt: number;
};

/**
 * One Identify with the private-chat intent (it uses one of the day's session starts), then the
 * socket is closed: what QQ answered (`GatewayProbe`). `signal` ends it early ('failed').
 */
export async function probeGatewayDetail(
  api: QqApi,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GatewayProbe> {
  const probe: GatewayProbe = {
    result: 'failed',
    closeCode: 0,
    remaining: null,
    resetAfterMs: null,
    identifiedAt: 0,
  };
  let url: string;
  try {
    const info = await api.gatewayBot();
    const limit = info.session_start_limit;
    if (limit && typeof limit.remaining === 'number') probe.remaining = limit.remaining;
    if (limit && typeof limit.reset_after === 'number') probe.resetAfterMs = limit.reset_after;
    url = qqGatewayUrl(String(info.url ?? ''), api.origin);
  } catch {
    return probe;
  }
  const { signal } = options;
  if (signal?.aborted) return probe;
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(url);
    const done = (result: GatewayProbe['result'], closeCode = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve({ ...probe, result, closeCode });
    };
    const onAbort = () => done('failed');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => done('failed'), options.timeoutMs ?? 10_000);
    socket.onmessage = (event) => {
      let payload: { op?: number; t?: string };
      try {
        payload = JSON.parse(String(event.data)) as typeof payload;
      } catch {
        return;
      }
      if (payload.op === 10)
        void api.tokens.get().then(
          (token) => {
            if (settled) return;
            probe.identifiedAt = Date.now();
            socket.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `QQBot ${token}`,
                  intents: C2C_INTENTS,
                  shard: [0, 1],
                  properties: { $os: process.platform, $browser: 'yomi-cli', $device: 'yomi-cli' },
                },
              }),
            );
          },
          () => done('failed'),
        );
      else if (payload.op === 0 && payload.t === 'READY') done('ok');
    };
    socket.onclose = (event) =>
      done(
        event.code === 4014 ? 'intents' : event.code === 4013 ? 'protocol' : 'failed',
        event.code,
      );
  });
}

/**
 * `--set-app`'s check of the gateway (`probeGatewayDetail`): 'intents': the bot may not have the
 * intent (4014); 'protocol': QQ says the intent is invalid (4013); 'failed': no answer within
 * `timeoutMs` or another close.
 */
export async function probeGateway(
  api: QqApi,
  timeoutMs = 10_000,
): Promise<'ok' | 'intents' | 'protocol' | 'failed'> {
  return (await probeGatewayDetail(api, { timeoutMs })).result;
}
