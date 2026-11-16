import { randomBytes, randomUUID } from 'node:crypto';

import {
  ChatRefusal,
  characterProfile,
  characterReportReasons,
  ConsumptionMode,
  conversationId,
  type FeedbackReason,
  feedbackReasons,
  listMessages,
  openingOf,
  pollMessages,
  replyCost,
  type SendAnswer,
  sendMessage,
  submitCharacterReport,
  submitFeedback,
} from '../chat/api.js';
import { ApiError, type Gateway, NotSignedIn } from '../core/api.js';
import { VERSION } from '../core/version.js';
import { ImConnection, type SocketFactory } from '../im/connection.js';
import { asidePlainText, type ImParagraph, SenderType } from '../im/models.js';
import { BusinessType, Command } from '../im/packet.js';
import {
  type AsideEvent,
  ConversationPurpose,
  type StreamEvent,
  StreamEventType,
} from '../im/thrift.js';
import { walletBalance } from '../ugc/api.js';
import { PairingCode } from './pairing.js';
import { compareVersions, DEFAULT_POLICY, type RelayPolicy, relayPolicy } from './policy.js';
import { ReplyPresenter } from './presenter.js';
import { escapeHtml, renderReply } from './render.js';
import { type RelayCharacter, type RelayState } from './state.js';
import {
  type InlineKeyboard,
  type TelegramBot,
  type TelegramCallbackQuery,
  TelegramError,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram.js';
import { COMMANDS, relayTexts, type RelayTexts } from './texts.js';

/**
 * `yomi relay --telegram`: the owner's private chat with their own bot ⇄ a published Yomi
 * character, through the same chat APIs as the app.
 *
 * - Only the paired owner is served (private chat, their user id, not a bot); anyone else is
 *   ignored before anything reaches Yomi, so strangers cost nothing. Groups are left.
 * - A reply is ours only if its `stream_id` came back from our own `send_message`: the account's
 *   other devices get the same pushes, and none of them is ever relayed.
 * - Only reviewed `paragraphs` are shown; a chunk's `text` and `thinking_content` never are.
 * - Money: no gems until the owner sets a budget (`/budget`, confirmed with a button), and never
 *   more than `--max-spend` on this computer, whose running total nothing from Telegram resets.
 *   Every send is measured: the server's `charged_diamonds`, else the balance before and after. A
 *   charge that could not be measured yet stays pending (across restarts) and is settled before the
 *   next send; when the balance cannot be read, nothing is sent. A spent budget pauses the relay,
 *   and so does a "free" reply that was charged. A send is never repeated.
 * - The long connection never gives up, reconnects after sleep, and reads `poll_message` on every
 *   connect; a reply that still did not arrive is read back from history.
 * - What the server promises lives in `relay/get_policy`; until it
 *   exists, the strictest defaults apply.
 */

export type RelayOptions = {
  /** Gems the relay may spend at most, set on this computer (`--max-spend`); 0: none. */
  maxSpend: number;
  /** Start the local ceiling's running total over (`--reset-spend`). */
  resetSpend?: boolean;
  /** Character to start with (`--character`), '' to keep the saved one. */
  characterId: string;
  /** Pairing code while unpaired (foreground runs only), else null. */
  pairing: PairingCode | null;
  /** Called when a spent or expired code is replaced (the terminal shows the new one). */
  onPairingCode?: (code: PairingCode) => void;
  replyTimeoutMs: number;
  /** Minimum time between two Telegram calls in the chat. */
  intervalMs: number;
  /** Messages older than this (sent while the relay was off) are not relayed. */
  staleMs: number;
  pollTimeoutSeconds: number;
  drafts: boolean;
  language: string;
  log: (line: string) => void;
  createSocket?: SocketFactory;
  /** How often a paused (signed out) relay looks for a new sign-in. */
  resumeCheckMs?: number;
};

export class RelayStopped extends Error {
  constructor(
    readonly reason: 'conflict' | 'token' | 'otherAccount' | 'webhook',
    message: string,
  ) {
    super(message);
    this.name = 'RelayStopped';
  }
}

type Turn = {
  character: RelayCharacter;
  chatId: number;
  streamId: string;
  assistantMid: string;
  cid: string;
  presenter: ReplyPresenter;
  lastSeq: number;
  settled: boolean;
  mode: 'free' | 'paid';
  /** The server reported this turn's charge and it is booked. */
  booked: boolean;
  /** Once settled: shown and booked (`finishTurn`). */
  finished: Promise<void> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
};

/** Pauses that come from the session or the server; worked out again on every start. */
type Gate = '' | 'signedOut' | 'disabled' | 'tooOld';

type Button =
  | { kind: 'budget'; amount: number; messageId: number }
  | { kind: 'report'; npcId: string; mid: string; reasons: FeedbackReason[]; messageId: number }
  | { kind: 'reportCharacter'; npcId: string; reasons: FeedbackReason[]; messageId: number };

/** Server notices the relay passes on whatever reply they follow (contract §5). */
const NOTICE_SCENES = new Set([
  'ai_disclosure',
  'break_reminder',
  'minor_notice',
  'crisis_support',
]);
const THREE_HOURS = 3 * 60 * 60 * 1000;
const OFFSET_MAX_AGE = 6 * 24 * 60 * 60 * 1000;
const PRICE_TTL = 5 * 60 * 1000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Whether a failed send may still have been accepted (and charged): no answer at all, a timeout,
 * or a server error. A 4xx (other than a timeout) or a named refusal means it was not.
 */
export function unknownOutcome(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== ApiError.transport) return false;
  const status = error.httpStatus;
  return status === 0 || status === 408 || status >= 500;
}

export class Relay {
  private turn: Turn | null = null;
  private early = new Map<string, StreamEvent[]>();
  private connection: ImConnection | null = null;
  private policy: RelayPolicy = DEFAULT_POLICY;
  private readonly texts: RelayTexts;
  private price: { npcId: string; value: number | null; at: number } | null = null;
  private buttons = new Map<string, Button>();
  private asides = new Set<string>();
  private noticed = new Set<string>();
  /** Assistant mids of replies this relay asked for (asides anchored on them are ours). */
  private ownMids = new Set<string>();
  /** Characters whose price the owner saw under the current budget. */
  private priceShown = new Set<string>();
  private gate: Gate = '';
  private strangers = 0;
  private resumeTimer: ReturnType<typeof setInterval> | null = null;
  private stopReason: RelayStopped | null = null;
  private readonly abort = new AbortController();
  private readonly userId: string;

  constructor(
    private readonly gateway: Gateway,
    private readonly bot: TelegramBot,
    private readonly state: RelayState,
    private readonly options: RelayOptions,
  ) {
    this.texts = relayTexts(options.language);
    this.userId = gateway.requireCredential().userId;
  }

  private log(line: string) {
    this.options.log(line);
  }

  /** Runs until `signal` aborts or the relay has to stop (`RelayStopped`). */
  async run(signal: AbortSignal): Promise<void> {
    const onAbort = () => this.abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.prepare();
      await this.poll();
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.shutdown();
    }
    if (this.stopReason) throw this.stopReason;
  }

  private async prepare() {
    const me = await this.bot.getMe();
    this.state.update({ botUsername: me.username ?? '' });
    const webhook = await this.bot.call<{ url?: string }>('getWebhookInfo');
    if (webhook.url)
      throw new RelayStopped(
        'webhook',
        '这个 bot 设置了 webhook（正被别的服务使用）。relay 不会删除它：请为 relay 单独建一个 bot。',
      );
    const commands = /^zh/i.test(this.options.language) ? COMMANDS.zh : COMMANDS.en;
    await this.bot.setMyCommands(commands).catch(() => undefined);
    if (this.state.bindAccount(this.userId))
      this.log('这台电脑上登录的 Yomi 账号和上次不同：预算、角色和记录已重置');
    this.state.useAllowance(this.options.maxSpend, Boolean(this.options.resetSpend));
    this.policy = await relayPolicy(this.gateway);
    this.applyPolicy();
    if (this.options.characterId) await this.chooseCharacter(this.options.characterId, false);
    if (this.state.data.pending && !(await this.settlePending()))
      this.log('上次有一条消息的花费还没核对：读不到余额，下一条发送前再核对');
    const { billing, allowance } = this.state.data;
    if (billing.mode === 'paid')
      this.log(
        `预算 ${billing.budget} 钻石（已用 ${billing.spent}）；本机上限 ${allowance.maxSpend}，还可花 ${Math.max(0, this.left())}`,
      );
    this.connect();
  }

  /** The server's switches: off, too old, or back on. */
  private applyPolicy() {
    if (!this.policy.enabled) this.gate = 'disabled';
    else if (this.policy.minVersion && compareVersions(VERSION, this.policy.minVersion) < 0)
      this.gate = 'tooOld';
    else this.gate = '';
    if (this.gate === 'tooOld')
      this.log(`yomi ${VERSION} 低于服务端要求的 ${this.policy.minVersion}，relay 暂停`);
    this.log(
      `服务端策略：${this.policy.source === 'server' ? '已读取' : '未提供（按最严格的默认值）'}` +
        `；只用免费额度${this.policy.freeOnly ? '已支持' : '未确认'}` +
        `；合规提示${this.policy.complianceNotices ? '由服务端注入' : '由 relay 显示'}`,
    );
  }

  private async poll() {
    const saved = this.state.data;
    // Update ids restart at random after a quiet week: an old offset could skip new messages.
    let offset = Date.now() - saved.offsetSavedAt < OFFSET_MAX_AGE ? saved.offset : 0;
    let backoff = 1000;
    while (!this.abort.signal.aborted && !this.stopReason) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.bot.getUpdates(
          offset,
          this.options.pollTimeoutSeconds,
          this.abort.signal,
        );
        backoff = 1000;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        if (error instanceof TelegramError && error.conflict)
          throw new RelayStopped(
            'conflict',
            '另一个程序正在用这个 bot 收消息（Telegram 409）。同一个 bot 只能运行一个 relay。',
          );
        if (error instanceof TelegramError && error.unauthorized)
          throw new RelayStopped(
            'token',
            'Telegram 不认这个 bot token（可能在 BotFather 里重置了）。请用 yomi relay --telegram --set-token 重新设置。',
          );
        this.log(`Telegram 暂时连不上，${Math.round(backoff / 1000)} 秒后重试`);
        await sleep(backoff, this.abort.signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        this.state.update({ offset, offsetSavedAt: Date.now() });
        try {
          await this.handle(update);
        } catch (error) {
          await this.unexpected(error);
        }
        if (this.stopReason) break;
      }
    }
  }

  private shutdown() {
    this.connection?.stop();
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = null;
    const turn = this.turn;
    if (turn) {
      if (turn.watchdog) clearTimeout(turn.watchdog);
      // Its charge, if any, stays pending in the state and is settled on the next run.
      turn.presenter.stop().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Telegram updates

  private owns(userId: number | undefined, chatId: number | undefined): boolean {
    const owner = this.state.data.owner;
    return Boolean(owner && userId === owner.userId && chatId === owner.chatId);
  }

  private async handle(update: TelegramUpdate) {
    const stopped = update.stopped_message_generation;
    if (stopped) {
      const turn = this.turn;
      if (
        turn &&
        stopped.chat.id === turn.chatId &&
        String(stopped.draft_id) === String(turn.presenter.draftId)
      )
        await this.stopTurn();
      return;
    }
    if (update.my_chat_member) {
      const { chat, new_chat_member: member } = update.my_chat_member;
      // A relay lives in private chats only: added to a group, it leaves.
      if (
        chat.type !== 'private' &&
        ['member', 'administrator', 'restricted'].includes(member.status)
      ) {
        this.log('有人把 bot 拉进了群，已退出');
        await this.bot.leaveChat(chat.id).catch(() => undefined);
      }
      return;
    }
    if (update.callback_query) return this.callback(update.callback_query);
    const message = update.message;
    if (!message || message.chat.type !== 'private' || !message.from || message.from.is_bot) return;
    if (!this.state.data.owner) return this.pair(message);
    if (!this.owns(message.from.id, message.chat.id)) {
      this.strangers += 1;
      if (this.strangers === 1 || this.strangers % 20 === 0)
        this.log(`已忽略非主人的消息（共 ${this.strangers} 条，没有转发、没有扣费）`);
      return;
    }
    if (Date.now() - message.date * 1000 > this.options.staleMs)
      return void (await this.say(this.texts.stale));
    const text = message.text?.trim() ?? '';
    if (!text) return void (await this.say(this.texts.textOnly));
    if (text.startsWith('/')) return this.command(message, text);
    return this.chat(message, text);
  }

  private async pair(message: TelegramMessage) {
    const code = this.options.pairing;
    const match = /^\/(?:start|pair)(?:@\w+)?\s+(\S+)/.exec(message.text ?? '');
    if (!code || !match || !message.from) return;
    const result = code.check(match[1], message.from.id);
    if (result === 'ignored') return;
    if (result !== 'ok') {
      await this.bot
        .sendMessage(message.chat.id, escapeHtml(this.texts.badCode))
        .catch(() => undefined);
      // Only time replaces the code: wrong guesses by others never use up the owner's.
      if (result === 'expired') {
        const next = new PairingCode();
        this.options.pairing = next;
        this.options.onPairingCode?.(next);
      }
      return;
    }
    this.options.pairing = null;
    this.state.update({
      owner: {
        userId: message.from.id,
        chatId: message.chat.id,
        name: message.from.first_name.slice(0, 64),
        language: message.from.language_code ?? '',
        pairedAt: Date.now(),
      },
    });
    this.log(`已配对：Telegram 用户 ${message.from.first_name}（${message.from.id}）`);
    await this.say(this.texts.paired(`@${this.state.data.botUsername}`));
    const character = this.state.data.character;
    if (character) await this.say(this.texts.characterIs(character.name, character.npcId));
    else await this.say(this.texts.noCharacter);
  }

  private async command(message: TelegramMessage, text: string) {
    const [head, ...rest] = text.split(/\s+/);
    const [name, target] = head.slice(1).split('@');
    if (target && target.toLowerCase() !== this.state.data.botUsername.toLowerCase()) return;
    const argument = rest.join(' ').trim();
    switch (name.toLowerCase()) {
      case 'start':
      case 'help':
        return void (await this.say(this.texts.help));
      case 'character':
        if (!argument) {
          const character = this.state.data.character;
          return void (await this.say(
            character
              ? this.texts.characterIs(character.name, character.npcId)
              : this.texts.noCharacter,
          ));
        }
        await this.afterBooking();
        if (this.turn) return void (await this.say(this.texts.busy));
        return this.chooseCharacter(argument, true);
      case 'price':
        return this.showPrice();
      case 'budget':
        return this.budget(argument);
      case 'report':
        return this.report(message);
      case 'stop':
        return this.stopTurn();
      default:
        return void (await this.say(this.texts.unknownCommand));
    }
  }

  // -------------------------------------------------------------------------------------------
  // Characters, notices, price

  private async chooseCharacter(input: string, announce: boolean) {
    const npcId = /([1-9][0-9]{5,19})/.exec(input)?.[1] ?? '';
    if (!npcId) return void (await this.say(this.texts.characterBad));
    let profile;
    try {
      profile = await characterProfile(this.gateway, npcId);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      this.log('角色读取失败');
      if (announce) await this.say(this.texts.characterBad);
      return;
    }
    const character: RelayCharacter = { npcId, name: profile.name, group: profile.group };
    this.state.update({ character });
    this.price = null;
    this.log(`当前角色：${character.name}（${npcId}${character.group ? '，群聊' : ''}）`);
    if (!announce) return;
    await this.say(this.texts.characterSet(character.name));
    await this.notice(character, true);
    // A first chat shows the opening, as the app does; the server keeps no message for it.
    const greeted = this.state.data.greeted;
    if (greeted.includes(npcId)) return;
    const cid = await conversationId(this.gateway, npcId).catch(() => 'unknown');
    if (cid !== '') return;
    const opening = openingOf(profile);
    for (const html of renderReply(opening, {
      characterName: character.name,
      group: character.group,
    }))
      await this.sayHtml(html);
    this.state.update({ greeted: [...greeted, npcId].slice(-200) });
  }

  /** The relay's own AI notice: at the start of a run and every 3 hours, unless the server does it. */
  private async notice(character: RelayCharacter, force: boolean) {
    if (this.policy.complianceNotices) return;
    const last = this.state.data.noticeAt[character.npcId] ?? 0;
    if (!force && this.noticed.has(character.npcId) && Date.now() - last < THREE_HOURS) return;
    await this.say(this.texts.aiNotice(character.name));
    this.noticed.add(character.npcId);
    this.state.update({ noticeAt: { ...this.state.data.noticeAt, [character.npcId]: Date.now() } });
  }

  private async replyPrice(npcId: string): Promise<number | null> {
    if (this.price && this.price.npcId === npcId && Date.now() - this.price.at < PRICE_TTL)
      return this.price.value;
    let value: number | null = null;
    try {
      value = await replyCost(this.gateway, npcId);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
    }
    // An unknown price is asked again next time: it must not stand in for a real one.
    if (value !== null) this.price = { npcId, value, at: Date.now() };
    return value;
  }

  /** The gem balance; one retry; null when it cannot be read. */
  private async balance(): Promise<number | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await walletBalance(this.gateway);
      } catch (error) {
        if (error instanceof NotSignedIn) throw error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    return null;
  }

  /** Gems the relay may still spend: the budget's rest, never past the local ceiling. */
  private left(): number {
    const { billing, allowance } = this.state.data;
    const budget = billing.mode === 'paid' ? billing.budget - billing.spent : 0;
    return Math.min(budget, this.options.maxSpend - allowance.spent);
  }

  private ceilingLeft(): number {
    return this.options.maxSpend - this.state.data.allowance.spent;
  }

  private async priceAndBalance(): Promise<string> {
    const character = this.state.data.character;
    const price = character ? await this.replyPrice(character.npcId) : null;
    if (character) this.priceShown.add(character.npcId);
    return this.texts.priceLine(price) + this.texts.balanceLine(await this.balance());
  }

  private budgetLine(): string {
    const { mode, budget, spent } = this.state.data.billing;
    return this.texts.budgetLine(mode, budget, spent, this.ceilingLeft(), this.options.maxSpend);
  }

  private async showPrice() {
    await this.say((await this.priceAndBalance()) + '\n' + this.budgetLine());
  }

  private async budget(argument: string) {
    if (!argument) return void (await this.say(this.budgetLine() + '\n' + this.texts.budgetUsage));
    if (/^(off|free|0|关|免费)$/i.test(argument)) {
      // A charged "free" reply stays paused: free-only is what failed.
      this.state.update({
        billing: { mode: 'free', budget: 0, spent: 0, setAt: Date.now() },
        billingPause: this.state.data.billingPause === 'budget' ? '' : this.state.data.billingPause,
      });
      return void (await this.say(this.texts.budgetOff));
    }
    const amount = Number(argument);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000)
      return void (await this.say(this.texts.budgetUsage));
    if (amount > this.ceilingLeft())
      return void (await this.say(
        this.texts.budgetTooHigh(this.ceilingLeft(), this.options.maxSpend),
      ));
    const nonce = randomBytes(4).toString('hex');
    const sent = await this.say(
      this.texts.budgetAsk(amount) + '\n' + (await this.priceAndBalance()),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: this.texts.budgetConfirm(amount), callback_data: `${nonce}:y` },
              { text: this.texts.cancel, callback_data: `${nonce}:n` },
            ],
          ],
        },
      },
    );
    if (sent) this.buttons.set(nonce, { kind: 'budget', amount, messageId: sent.message_id });
  }

  // -------------------------------------------------------------------------------------------
  // Reports

  private async report(message: TelegramMessage) {
    const character = this.state.data.character;
    if (!character) return void (await this.say(this.texts.noCharacter));
    const replied = message.reply_to_message?.message_id;
    const mid = replied ? this.state.replyMid(replied) : this.state.lastReplyMid;
    let reasons: FeedbackReason[] = [];
    if (mid) {
      try {
        const all = await feedbackReasons(this.gateway);
        reasons = all.filter((reason) => reason.isReport);
        if (reasons.length === 0) reasons = all;
      } catch (error) {
        if (error instanceof NotSignedIn) throw error;
      }
    }
    const nonce = randomBytes(4).toString('hex');
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        ...reasons
          .slice(0, 8)
          .map((reason, index) => [{ text: reason.label, callback_data: `${nonce}:${index}` }]),
        [{ text: this.texts.reportCharacter, callback_data: `${nonce}:c` }],
      ],
    };
    const sent = await this.say(mid ? this.texts.reportPick : this.texts.reportNothing, {
      reply_markup: keyboard,
    });
    if (sent)
      this.buttons.set(nonce, {
        kind: 'report',
        npcId: character.npcId,
        mid,
        reasons,
        messageId: sent.message_id,
      });
  }

  private async callback(query: TelegramCallbackQuery) {
    const chatId = query.message?.chat.id;
    if (!this.owns(query.from.id, chatId) || chatId === undefined) {
      await this.bot.answerCallbackQuery(query.id).catch(() => undefined);
      return;
    }
    const [nonce, choice] = (query.data ?? '').split(':');
    const button = this.buttons.get(nonce);
    if (!button) {
      await this.bot.answerCallbackQuery(query.id, this.texts.expired).catch(() => undefined);
      return;
    }
    this.buttons.delete(nonce);
    await this.bot.answerCallbackQuery(query.id).catch(() => undefined);
    await this.bot.editMessageReplyMarkup(chatId, button.messageId, null).catch(() => undefined);
    if (button.kind === 'budget') {
      if (choice !== 'y') return void (await this.say(this.texts.budgetCancelled));
      // Spending may have gone on since the prompt: the ceiling is checked again.
      if (button.amount > this.ceilingLeft())
        return void (await this.say(
          this.texts.budgetTooHigh(this.ceilingLeft(), this.options.maxSpend),
        ));
      const character = this.state.data.character;
      const seen = character ? this.priceShown.has(character.npcId) : false;
      this.priceShown.clear();
      if (character && seen) this.priceShown.add(character.npcId);
      this.state.update({
        billing: { mode: 'paid', budget: button.amount, spent: 0, setAt: Date.now() },
        billingPause: '',
      });
      this.log(`主人确认了预算 ${button.amount} 钻石`);
      return void (await this.say(this.texts.budgetSet(button.amount)));
    }
    if (choice === 'c') {
      let reasons: FeedbackReason[] = [];
      try {
        reasons = await characterReportReasons(this.gateway);
      } catch (error) {
        if (error instanceof NotSignedIn) throw error;
        return void (await this.say(this.texts.reportFailed));
      }
      const next = randomBytes(4).toString('hex');
      const sent = await this.say(this.texts.reportPick, {
        reply_markup: {
          inline_keyboard: reasons
            .slice(0, 8)
            .map((reason, index) => [{ text: reason.label, callback_data: `${next}:${index}` }]),
        },
      });
      if (sent)
        this.buttons.set(next, {
          kind: 'reportCharacter',
          npcId: button.npcId,
          reasons,
          messageId: sent.message_id,
        });
      return;
    }
    const reason = button.reasons[Number(choice)];
    if (!reason) return;
    try {
      if (button.kind === 'report')
        await submitFeedback(this.gateway, button.npcId, button.mid, [reason.key]);
      else await submitCharacterReport(this.gateway, button.npcId, [reason.key]);
      await this.say(this.texts.reportDone);
    } catch (error) {
      if (error instanceof NotSignedIn) throw error;
      await this.say(this.texts.reportFailed);
    }
  }

  // -------------------------------------------------------------------------------------------
  // A turn

  /** Why nothing can be sent now, '' when it can. */
  private pausedText(): string {
    switch (this.gate) {
      case 'signedOut':
        return this.texts.signedOut;
      case 'tooOld':
        return this.texts.tooOld;
      case 'disabled':
        return this.texts.disabled(this.policy.message);
    }
    switch (this.state.data.billingPause) {
      case 'budget':
        return this.texts.budgetExhausted(this.state.data.billing.spent);
      case 'freeCharged':
        return this.texts.paused(this.texts.budgetUsage);
    }
    return '';
  }

  /** A reply that is done and only being booked is waited for, not answered with "busy". */
  private async afterBooking() {
    const finished = this.turn?.settled ? this.turn.finished : null;
    if (finished) await finished.catch(() => undefined);
  }

  private async chat(message: TelegramMessage, text: string) {
    await this.afterBooking();
    if (this.turn) return void (await this.say(this.texts.busy));
    const blocked = this.pausedText();
    if (blocked) return void (await this.say(blocked));
    const character = this.state.data.character;
    if (!character) return void (await this.say(this.texts.noCharacter));
    // What earlier sends cost is booked before anything more is spent.
    if (!(await this.settlePending())) return void (await this.say(this.texts.walletUnavailable));
    const afterSettling = this.pausedText();
    if (afterSettling) return void (await this.say(afterSettling));
    const billing = this.state.data.billing;
    let consumptionMode: number;
    let maxCost: number | undefined;
    let price: number | null = null;
    if (billing.mode === 'free') {
      // Without the server's word that FreeOnly is honoured, any message may be charged.
      if (!this.policy.freeOnly) return void (await this.say(this.texts.freeOnlyUnsupported));
      consumptionMode = ConsumptionMode.freeOnly;
    } else {
      const left = this.left();
      if (left <= 0) {
        this.state.update({ billingPause: 'budget' });
        return void (await this.say(this.texts.budgetExhausted(billing.spent)));
      }
      price = await this.replyPrice(character.npcId);
      // An unknown price is "not free": without the server's cap it could overrun the budget.
      if (price === null && !this.policy.spendCap)
        return void (await this.say(this.texts.priceUnknown));
      if (price !== null && price > left)
        return void (await this.say(this.texts.budgetShort(price, left)));
      consumptionMode = ConsumptionMode.allowPaid;
      if (this.policy.spendCap) maxCost = left;
    }
    await this.notice(character, false);
    const before = await this.balance();
    // A paid send needs something to measure its cost against.
    if (before === null && billing.mode === 'paid')
      return void (await this.say(this.texts.walletUnavailable));
    if (billing.mode === 'paid' && !this.priceShown.has(character.npcId)) {
      await this.say(this.texts.priceLine(price) + this.texts.balanceLine(before));
      this.priceShown.add(character.npcId);
    }
    if (before === null) this.log('读不到余额：这条只用免费额度的回复无法核对是否扣费');
    else this.state.update({ pending: { before, mode: billing.mode, price, at: Date.now() } });
    const presenter = new ReplyPresenter(this.bot, message.chat.id, {
      render: { characterName: character.name, group: character.group },
      intervalMs: this.options.intervalMs,
      drafts: this.options.drafts,
      log: (line) => this.log(line),
    });
    const turn: Turn = {
      character,
      chatId: message.chat.id,
      streamId: '',
      assistantMid: '',
      cid: '',
      presenter,
      lastSeq: 0,
      settled: false,
      mode: billing.mode,
      booked: false,
      finished: null,
      watchdog: null,
    };
    this.turn = turn;
    this.early.clear();
    presenter.start();
    let answer: SendAnswer;
    try {
      answer = await sendMessage(this.gateway, {
        npcId: character.npcId,
        text,
        clientRequestId: randomUUID(),
        consumptionMode,
        maxCostDiamonds: maxCost,
      });
    } catch (error) {
      // Refused for sure: nothing was charged. Unknown: the pending charge is settled later.
      if (!unknownOutcome(error)) this.state.update({ pending: null });
      this.turn = null;
      this.early.clear();
      await presenter.stop().catch(() => undefined);
      await this.refused(error);
      return;
    }
    this.log(`已转发一条消息给「${character.name}」`);
    turn.streamId = answer.streamId;
    turn.assistantMid = answer.assistantMid;
    turn.cid = answer.cid;
    if (answer.assistantMid) this.ownMids.add(answer.assistantMid);
    if (this.ownMids.size > 1000) this.ownMids = new Set([...this.ownMids].slice(-500));
    if (answer.chargedDiamonds !== null) {
      // The server says what it took: booked now, so a stop or restart cannot lose it.
      this.state.update({ pending: null });
      turn.booked = true;
      await this.book(answer.chargedDiamonds, turn.mode);
    }
    for (const notice of answer.notices) await this.say(notice);
    this.armWatchdog(turn);
    const early = this.early.get(answer.streamId) ?? [];
    this.early.clear();
    for (const event of early) this.onStream(event);
  }

  private async refused(error: unknown) {
    if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
      return this.signedOut();
    if (error instanceof ChatRefusal) {
      this.log(`发送被拒绝：${error.kind}（${error.code}）`);
      switch (error.kind) {
        case 'gems':
          return void (await this.say(this.texts.insufficientGems));
        case 'membership':
          return void (await this.say(this.texts.membership));
        case 'freeExhausted':
          return void (await this.say(this.texts.freeExhausted(...(await this.priceParts()))));
        case 'spendCap': {
          const character = this.state.data.character;
          const price = character ? await this.replyPrice(character.npcId) : null;
          return void (await this.say(this.texts.budgetShort(price ?? 0, this.left())));
        }
        case 'rateLimited':
          return void (await this.say(
            this.texts.rateLimited(Math.ceil(error.retryAfterMs / 1000)),
          ));
        case 'busy':
          return void (await this.say(this.texts.busy));
        case 'ageGate':
          return void (await this.say(this.texts.ageGate));
        case 'unavailable':
          return void (await this.say(this.texts.unavailable));
        case 'disabled':
          this.gate = 'disabled';
          return void (await this.say(this.texts.disabled(error.message)));
        case 'tooOld':
          this.gate = 'tooOld';
          return void (await this.say(this.texts.tooOld));
        default:
          return void (await this.say(this.texts.refused(error.dialog?.content || error.message)));
      }
    }
    if (unknownOutcome(error)) return void (await this.say(this.texts.sendUnknown));
    this.log(`发送失败：${error instanceof Error ? error.name : 'error'}`);
    await this.say(this.texts.refused(''));
  }

  private async priceParts(): Promise<[string, string]> {
    const character = this.state.data.character;
    const price = character ? await this.replyPrice(character.npcId) : null;
    return [this.texts.priceLine(price), this.texts.balanceLine(await this.balance())];
  }

  private onStream(event: StreamEvent) {
    const turn = this.turn;
    // Nothing in flight, or another character: not ours.
    if (!turn || event.entityId !== turn.character.npcId) return;
    if (!turn.streamId) {
      // The send's answer is still on its way: keep the events until it says which stream is ours.
      const list = this.early.get(event.streamId) ?? [];
      if (list.length < 200 && this.early.size < 20) list.push(event);
      this.early.set(event.streamId, list);
      return;
    }
    // Another device of this account chatting with the same character.
    if (event.streamId !== turn.streamId) return;
    if (turn.settled || event.seq <= turn.lastSeq) return;
    turn.lastSeq = event.seq;
    if (event.type === StreamEventType.messageChunk && event.chunk) {
      if (turn.assistantMid && event.chunk.mid !== turn.assistantMid) return;
      // Reviewed paragraphs only; `chunk.text` and `thinking_content` are never shown.
      if (event.chunk.paragraphs) turn.presenter.update(event.chunk.paragraphs);
      this.armWatchdog(turn);
    } else if (event.type === StreamEventType.messageCompleted && event.message) {
      if (turn.assistantMid && event.message.mid !== turn.assistantMid) return;
      this.complete(turn, event.message.content.paragraphs, event.message.mid).catch((error) =>
        this.unexpected(error),
      );
    } else if (event.type === StreamEventType.error) {
      this.failTurn(
        turn,
        event.error?.message ?? '',
        event.message?.content.paragraphs ?? [],
      ).catch((error) => this.unexpected(error));
    }
  }

  private onAside(event: AsideEvent) {
    const character = this.state.data.character;
    if (!character || event.entityId !== character.npcId || this.asides.has(event.asideId)) return;
    const anchor = event.anchorMid;
    const ours =
      Boolean(anchor) &&
      (this.ownMids.has(anchor) || this.state.data.replies.some(([, mid]) => mid === anchor));
    if (!NOTICE_SCENES.has(event.aside.scene) && !(ours && event.aside.scene !== 'memory_updated'))
      return;
    this.asides.add(event.asideId);
    if (this.asides.size > 500) this.asides = new Set([...this.asides].slice(-200));
    const text = asidePlainText(event.aside).trim() || event.aside.title.trim();
    if (text) void this.say(text);
  }

  private armWatchdog(turn: Turn) {
    if (turn.watchdog) clearTimeout(turn.watchdog);
    turn.watchdog = setTimeout(
      () => this.catchUp(turn, true).catch((error) => this.unexpected(error)),
      this.options.replyTimeoutMs,
    );
    turn.watchdog.unref?.();
  }

  /** Reads the reply back from history; `final`: give up when it is not there. */
  private async catchUp(turn: Turn, final: boolean) {
    if (turn.settled) return;
    let reply = null;
    if (turn.cid && turn.assistantMid) {
      try {
        const messages = await listMessages(this.gateway, turn.cid, 20);
        reply = messages.find(
          (message) =>
            message.mid === turn.assistantMid && message.senderType === SenderType.assistant,
        );
      } catch (error) {
        if (error instanceof NotSignedIn) return this.signedOut();
      }
    }
    // The stream (or another catch-up) may have finished it while history was read.
    if (turn.settled) return;
    if (reply) return this.complete(turn, reply.content.paragraphs, reply.mid);
    if (!final) return;
    turn.settled = true;
    await this.finishTurn(turn, () =>
      turn.presenter.stop(turn.presenter.isClosed ? '' : this.texts.replyMissing),
    );
  }

  private async complete(turn: Turn, paragraphs: readonly ImParagraph[], mid: string) {
    if (turn.settled) return;
    turn.settled = true;
    await this.finishTurn(turn, async () => {
      if (turn.presenter.isClosed) return;
      const ids = await turn.presenter.finish(paragraphs, this.texts.emptyReply);
      for (const id of ids) this.state.rememberReply(id, mid || turn.assistantMid);
    });
  }

  private async failTurn(turn: Turn, detail: string, paragraphs: readonly ImParagraph[]) {
    if (turn.settled) return;
    turn.settled = true;
    await this.finishTurn(turn, async () => {
      if (turn.presenter.isClosed) return;
      if (paragraphs.length) {
        const ids = await turn.presenter.finish(paragraphs, this.texts.emptyReply);
        for (const id of ids) this.state.rememberReply(id, turn.assistantMid);
        await this.say(this.texts.replyFailed(detail));
      } else await turn.presenter.stop(this.texts.replyFailed(detail));
    });
  }

  /**
   * The end of a turn, whatever Telegram does: show it (a failure is logged), book what it cost,
   * and only then accept the next message, so a send never overtakes the previous charge.
   */
  private finishTurn(turn: Turn, show: () => Promise<void>): Promise<void> {
    turn.finished = this.showAndBook(turn, show);
    return turn.finished;
  }

  private async showAndBook(turn: Turn, show: () => Promise<void>) {
    if (turn.watchdog) clearTimeout(turn.watchdog);
    try {
      await show();
    } catch (error) {
      this.log(
        `回复发到 Telegram 失败${error instanceof TelegramError ? `（${error.method} ${error.code}）` : ''}`,
      );
    }
    try {
      if (!turn.booked && !(await this.settlePending()))
        this.log('暂时读不到余额：这条回复的花费会在下一条发送前核对');
    } catch (error) {
      if (error instanceof NotSignedIn) await this.signedOut();
      else throw error;
    } finally {
      this.endTurn(turn);
    }
  }

  private endTurn(turn: Turn) {
    if (this.turn === turn) this.turn = null;
  }

  /** `/stop` or the draft's Stop button: stop showing it; the server still finishes (and charges). */
  private async stopTurn() {
    const turn = this.turn;
    if (!turn || turn.settled || turn.presenter.isClosed)
      return void (await this.say(this.texts.nothingToStop));
    this.log('主人停止了这条回复的转发');
    await turn.presenter.stop(this.texts.stopped);
  }

  /**
   * Books the pending send's cost from the balance now: the drop, if any. A balance that rose
   * meanwhile (a top-up) hides the cost, so the quoted price is booked instead (or, unknown, the
   * rest of the budget). False when the balance cannot be read: it stays pending.
   */
  private async settlePending(): Promise<boolean> {
    const pending = this.state.data.pending;
    if (!pending) return true;
    const now = await this.balance();
    if (now === null) return false;
    this.state.update({ pending: null });
    const drop = pending.before - now;
    if (drop >= 0) await this.book(drop, pending.mode);
    else if (pending.mode === 'paid') {
      const estimate = pending.price ?? Math.max(0, this.left());
      this.log(`余额在这条回复期间增加了，无法量出花费：按 ${estimate} 钻石计入预算`);
      await this.book(estimate, pending.mode);
    }
    return true;
  }

  /** Counts `amount` gems against the budget and the local ceiling; pauses when either is spent. */
  private async book(amount: number, mode: 'free' | 'paid') {
    if (amount <= 0) return;
    const allowance = this.state.data.allowance;
    this.state.update({ allowance: { ...allowance, spent: allowance.spent + amount } });
    if (mode === 'free') {
      this.log(`只用免费额度时被扣了 ${amount} 钻石，relay 暂停`);
      this.state.update({ billingPause: 'freeCharged' });
      await this.say(this.texts.freeCharged(amount));
      return;
    }
    const billing = this.state.data.billing;
    const spent = billing.spent + amount;
    this.state.update({ billing: { ...billing, spent } });
    this.log(
      `这条回复花了 ${amount} 钻石（预算 ${billing.budget}，已用 ${spent}；本机还可花 ${Math.max(0, this.ceilingLeft())}）`,
    );
    if (this.left() <= 0) {
      this.state.update({ billingPause: 'budget' });
      await this.say(this.texts.budgetExhausted(spent));
    }
  }

  // -------------------------------------------------------------------------------------------
  // The long connection and the session

  private connect() {
    const credential = this.gateway.credential;
    if (!credential) return;
    this.connection?.stop();
    const connection = new ImConnection({
      url: () => {
        if (this.gateway.reloadCredential() === 'otherAccount') this.otherAccount();
        return this.gateway.connectionURL();
      },
      headers: () => this.gateway.connectionHeaders(),
      userId: credential.userId,
      deviceId: credential.deviceId,
      businessTypes: [BusinessType.conversationStream, BusinessType.conversationAside],
      purpose: ConversationPurpose.normal,
      maxBackoffMs: 30_000,
      watchWake: true,
      createSocket: this.options.createSocket,
      onConnected: () => {
        this.drain(connection).catch((error) => this.unexpected(error));
      },
      onState: (state) => {
        if (state === 'retrying' && connection.reconnects % 10 === 1)
          this.log('Yomi 长连接断开，正在重连');
      },
    });
    connection.on((event) => {
      if (event.kind === 'stream') this.onStream(event.event);
      else if (event.kind === 'aside') this.onAside(event.event);
    });
    this.connection = connection;
    connection.start();
  }

  /** What arrived while no socket was open (`poll_message`), then a missed reply from history. */
  private async drain(connection: ImConnection) {
    for (let page = 0; page < 10; page++) {
      let result;
      try {
        result = await pollMessages(this.gateway, 50);
      } catch (error) {
        if (error instanceof NotSignedIn) await this.signedOut();
        break;
      }
      result.packets
        .filter(
          (packet) =>
            packet.command === Command.business || packet.command === Command.businessStreaming,
        )
        .sort((a, b) => a.sid - b.sid)
        .forEach((packet) => connection.ingest(packet));
      if (!result.hasMore) break;
    }
    const turn = this.turn;
    if (turn && !turn.settled && connection.reconnects > 0) await this.catchUp(turn, false);
  }

  private async signedOut() {
    if (this.gate === 'signedOut') return;
    this.log('Yomi 登录已失效，relay 暂停；在这台电脑上运行 yomi login 后自动恢复');
    this.gate = 'signedOut';
    this.connection?.stop();
    const turn = this.turn;
    if (turn && !turn.settled) {
      // Its charge, if any, stays pending and is settled before the next send.
      turn.settled = true;
      if (turn.watchdog) clearTimeout(turn.watchdog);
      await turn.presenter.stop().catch(() => undefined);
      this.endTurn(turn);
    }
    await this.say(this.texts.signedOut);
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = setInterval(
      () => this.tryResume().catch((error) => this.unexpected(error)),
      this.options.resumeCheckMs ?? 15_000,
    );
    this.resumeTimer.unref?.();
  }

  private async tryResume() {
    this.gateway.reloadCredential();
    const credential = this.gateway.credential;
    if (!credential) return;
    if (credential.userId !== this.userId) return this.otherAccount();
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.resumeTimer = null;
    if (this.gate === 'signedOut') this.gate = '';
    this.log('Yomi 登录已恢复');
    this.connect();
    await this.say(this.texts.resumed);
  }

  private otherAccount() {
    if (this.stopReason) return;
    this.stopReason = new RelayStopped(
      'otherAccount',
      '这台电脑上登录的 Yomi 账号变了，relay 已停止。',
    );
    void this.say(this.texts.otherAccount);
    this.abort.abort();
  }

  private async unexpected(error: unknown) {
    if (error instanceof NotSignedIn || (error instanceof ApiError && error.needsSignIn))
      return this.signedOut();
    this.log(
      `处理消息出错：${error instanceof Error ? `${error.name} ${error.message}`.slice(0, 200) : 'error'}`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Talking to the owner

  /** Plain text to the owner (escaped). Null when it could not be sent. */
  private say(text: string, extra: Record<string, unknown> = {}) {
    return this.sayHtml(escapeHtml(text), extra);
  }

  private async sayHtml(
    html: string,
    extra: Record<string, unknown> = {},
  ): Promise<TelegramMessage | null> {
    const owner = this.state.data.owner;
    if (!owner || !html) return null;
    try {
      return await this.bot.sendMessage(owner.chatId, html, extra);
    } catch (error) {
      if (error instanceof TelegramError && error.blocked) this.log('主人屏蔽了 bot，消息发不出去');
      else
        this.log(`发给 Telegram 失败${error instanceof TelegramError ? `（${error.code}）` : ''}`);
      return null;
    }
  }
}
