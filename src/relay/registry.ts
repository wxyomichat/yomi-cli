import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CredentialStore } from '../core/credentials.js';
import { UsageError } from '../core/env.js';
import { configDir, readJsonFile, writeJsonFile } from '../core/files.js';
import { tr } from '../core/i18n.js';
import { withFileLockSync } from '../core/lock.js';
import { sha256 } from '../core/state.js';
import { CHANNEL_KINDS, type ChannelKind, channelSetup } from './channels/index.js';
import type { StoredBot } from './channels/setup.js';
import {
  characterOwner,
  ownerKey,
  type RelayCharacter,
  RelayState,
  relayStatePath,
} from './state.js';

export { characterOwner };

/**
 * The bots of one Yomi account and environment on this computer, in
 * `relay/bots-<sha256(account)[0:16]>.json` (0600, no secrets): what each bot is (channel, name,
 * platform id), where its secret, state and lock are, and which character it talks as.
 *
 * - Every `yomi relay` takes over the bots the channels' credentials stored before the registry
 *   (`migrateRegistry`): one per channel, under the secret name, state scope and lock it always
 *   had, with its character, and with its owner as already welcomed (`welcomeBaseline`). Nothing
 *   else is written: the state file keeps the owner, the budget, the charge still to be measured,
 *   the openings shown, the welcomes and the cursor, and nothing of it is resent.
 * - A bot added later (`yomi relay --telegram --set-token`, `--set-app`, `--login`, with or without
 *   `--character`) is a record of its own (`add`): a random key, its secret under
 *   `<the channel's secret name>#<key>`, the state scope and lock its platform id gives (Telegram's
 *   bot id, `qq:<AppID>`), and for WeChat, whose ClawBots one person may link several of, a scope
 *   and lock of its own (`bot:<key>`, `bot-<key>`). A bot already registered is never added twice.
 * - Credentials set again for a bot (`renew`) must be that bot's: the same Telegram bot id, the
 *   same QQ AppID; a WeChat login may come with a new ClawBot id, never another registered one.
 * - A run checks the stored credentials against the record (`sameBot`): credentials of another bot
 *   (written by something that did not update the registry) are never run as this one.
 * - Each bot talks as the one character of its record, set when it is added or with `yomi relay
 *   --bot NAME --character ID` (`rebind`), never from the chat. One character goes with one bot: a
 *   second bot set to it is refused (`DuplicateCharacter`), or registered without one when it is
 *   taken over.
 * - `characterOwners` remembers whom each character was last shown to (the owner a bot of it was
 *   last paired, started or welcomed with), so a welcome after the character changed hands shows
 *   its opening, never the earlier owner's latest reply. It outlives the bots: the conversation
 *   stays on the account.
 *
 * Every change is a short read-modify-write under `locks/relay-registry-<hash>.lock` (`commit`),
 * checked again there (names, characters, platform ids, limits); what goes with it (a bot's secret
 * and state) is written there too, right before the registry. A registry that cannot be read is an
 * error, never repaired on its own.
 */

/** The owner a bot had before the registry, as `RelayState` keeps owners (a hash), and its character then. */
export type WelcomeBaseline = { owner: string; npcId: string };

export type BotRecord = {
  /** Random, stable: never shown, never reused. */
  key: string;
  /** How the owner names it on this computer (`--list`): `^[a-z0-9][a-z0-9_-]{0,31}$`, unique. */
  name: string;
  kind: ChannelKind;
  /** The character it talks as; null: none yet. */
  character: RelayCharacter | null;
  /** `StoredBot.platformId`: Telegram's bot id, QQ's AppID, WeChat's ilink_bot_id ('' when unknown). */
  platformId: string;
  /** Telegram: the bot's username, without '@'. */
  platformUser?: string;
  /** How the terminal names it (`ChannelSetup.label`: '@lin_bot', the QQ bot's name). */
  label: string;
  /** Its relay state's scope (`RelayChannel.scope`). */
  scope: string;
  /** Its keychain entry. */
  secretName: string;
  /** Its lock, `locks/relay-<lockName>.lock`. */
  lockName: string;
  /** WeChat: when `--experimental` was accepted for it. */
  experimentalAcceptedAt?: number;
  createdAt: number;
  /** When its character was last set (0: never). */
  boundAt: number;
  /** Counts the changes to what it is bound to. */
  generation: number;
  /** Taken over from the channel's credentials of before the registry. */
  migratedFrom?: ChannelKind;
  /** The owner it had when it was taken over: already welcomed (`RelayState.welcomedBefore`). */
  welcomeBaseline?: WelcomeBaseline;
};

export type BotRegistryFile = {
  version: 1;
  account: string;
  /** The Yomi user who ran these bots last ('' before any run). */
  yomiUserId: string;
  /** Counts the changes to the file. */
  revision: number;
  bots: BotRecord[];
  /**
   * npcId → whom a bot of this computer last showed it to (`characterOwner`: the owner it was
   * paired, started or welcomed with, or had when it was taken over): never a chat user id itself.
   */
  characterOwners: Record<string, string>;
  /** When the channels' earlier credentials were first taken over. */
  migratedAt?: number;
};

export const MAX_BOTS = 20;
export const MAX_BOTS_PER_KIND = 10;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const hashOf = (account: string) => sha256(account).slice(0, 16);

export function registryPath(account: string, dir = configDir()): string {
  return join(dir, 'relay', `bots-${hashOf(account)}.json`);
}

const lockPath = (account: string, dir: string) =>
  join(dir, 'locks', `relay-registry-${hashOf(account)}.lock`);

const empty = (account: string): BotRegistryFile => ({
  version: 1,
  account,
  yomiUserId: '',
  revision: 0,
  bots: [],
  characterOwners: {},
});

function malformed(path: string): UsageError {
  return new UsageError(
    tr(
      `无法使用 ${path}：bot 列表的格式不对。确认后可以删除这个文件，下次运行会从保存的凭证重新生成。`,
      `Cannot use ${path}: the list of bots is not in the expected format. Once you have checked it, you can delete the file; the next run makes it again from the saved credentials.`,
      `No se puede usar ${path}: la lista de bots no tiene el formato esperado. Después de revisarla, puedes eliminar el archivo; la próxima ejecución la vuelve a crear a partir de las credenciales guardadas.`,
      `Não é possível usar ${path}: a lista de bots não está no formato esperado. Depois de conferir, você pode apagar o arquivo; a próxima execução a cria de novo a partir das credenciais salvas.`,
    ),
  );
}

const isText = (value: unknown): value is string => typeof value === 'string';

function wellFormed(value: unknown): value is BotRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<BotRecord>;
  const character = record.character;
  return (
    isText(record.key) &&
    isText(record.name) &&
    CHANNEL_KINDS.includes(record.kind as ChannelKind) &&
    isText(record.platformId) &&
    isText(record.scope) &&
    isText(record.secretName) &&
    isText(record.lockName) &&
    (character === null || (typeof character === 'object' && isText(character?.npcId)))
  );
}

function readRegistry(path: string, account: string): BotRegistryFile {
  const stored = readJsonFile<Partial<BotRegistryFile>>(path);
  if (!stored) return empty(account);
  if (
    stored.version !== 1 ||
    !Array.isArray(stored.bots) ||
    !stored.bots.every(wellFormed) ||
    typeof stored.revision !== 'number'
  )
    throw malformed(path);
  return {
    ...empty(account),
    ...stored,
    bots: stored.bots.map((record) => ({ ...record })),
    characterOwners: { ...stored.characterOwners },
  } as BotRegistryFile;
}

/**
 * A character already bound to another bot: a character goes with one bot only (one conversation
 * per character on the account, and its replies could not be told apart).
 */
export class DuplicateCharacter extends UsageError {
  constructor(
    readonly npcId: string,
    /** The name of the bot that has it. */
    readonly holder: string,
  ) {
    super(
      tr(
        `角色 ${npcId} 已经绑在 bot "${holder}" 上：一个角色只能绑一个 bot。要把它给别的 bot，先给 ${holder} 换一个角色：yomi relay --bot ${holder} --character ID`,
        `Character ${npcId} is already bound to the bot "${holder}": a character goes with one bot only. To give it to another bot, give ${holder} another character first: yomi relay --bot ${holder} --character ID`,
        `El personaje ${npcId} ya está vinculado al bot "${holder}": un personaje va con un solo bot. Para dárselo a otro bot, primero dale otro personaje a ${holder}: yomi relay --bot ${holder} --character ID`,
        `O personagem ${npcId} já está vinculado ao bot "${holder}": um personagem fica com um bot só. Para dá-lo a outro bot, primeiro dê outro personagem a ${holder}: yomi relay --bot ${holder} --character ID`,
      ),
    );
    this.name = 'DuplicateCharacter';
  }
}

/** The bot credentials name is registered already, as `record`. */
export function alreadyRegistered(record: BotRecord): string {
  const setup = channelSetup(record.kind);
  const renew = `${setup.command} --bot ${record.name} ${setup.credentialsFlag}`;
  const bind = `yomi relay --bot ${record.name} --character ID`;
  return tr(
    `这个 bot 已经登记在这台电脑上了，名字是 "${record.name}"。要重新设置它的凭证：${renew}；要给它换角色：${bind}`,
    `This bot is registered on this computer already, as "${record.name}". To set its credentials again: ${renew}; to give it another character: ${bind}`,
    `Este bot ya está registrado en este equipo, como "${record.name}". Para volver a configurar sus credenciales: ${renew}; para darle otro personaje: ${bind}`,
    `Este bot já está registrado neste computador, como "${record.name}". Para configurar as credenciais dele de novo: ${renew}; para dar outro personagem a ele: ${bind}`,
  );
}

/**
 * Whether stored credentials (`StoredBot`, read offline) are the registered bot's: by the scope
 * they name (the Telegram bot id, the QQ AppID, the WeChat scanner of a login of before the
 * registry), and for WeChat by its ClawBot id too, which a login signed in again for the bot
 * (`renew`) may change, scanner and all. A WeChat bot with a scope of its own (`bot:<key>`) is
 * named by its ClawBot id alone.
 */
export function sameBot(record: BotRecord, stored: StoredBot): boolean {
  if (record.kind === 'wechat' && record.platformId && stored.platformId === record.platformId)
    return true;
  if (record.scope.startsWith('bot:')) return !record.platformId;
  return stored.scope === record.scope;
}

function tooMany(): UsageError {
  return new UsageError(
    tr(
      `bot 太多了：这台电脑上最多登记 ${MAX_BOTS} 个。`,
      `Too many bots: at most ${MAX_BOTS} can be registered on this computer.`,
      `Demasiados bots: se pueden registrar como máximo ${MAX_BOTS} en este equipo.`,
      `Bots demais: no máximo ${MAX_BOTS} podem ser registrados neste computador.`,
    ),
  );
}

function tooManyOfKind(): UsageError {
  return new UsageError(
    tr(
      `bot 太多了：每个通道最多登记 ${MAX_BOTS_PER_KIND} 个。`,
      `Too many bots: at most ${MAX_BOTS_PER_KIND} per channel can be registered.`,
      `Demasiados bots: se pueden registrar como máximo ${MAX_BOTS_PER_KIND} por canal.`,
      `Bots demais: no máximo ${MAX_BOTS_PER_KIND} por canal podem ser registrados.`,
    ),
  );
}

function badName(name: string): UsageError {
  return new UsageError(
    tr(
      `bot 名字 "${name}" 不能用：要用小写字母、数字、- 或 _，最多 32 个字符，不能和别的 bot 重名。`,
      `The bot name "${name}" cannot be used: use lowercase letters, digits, - or _, at most 32 characters, unlike any other bot's.`,
      `El nombre de bot "${name}" no se puede usar: usa letras minúsculas, dígitos, - o _, como máximo 32 caracteres, distinto del de cualquier otro bot.`,
      `O nome de bot "${name}" não pode ser usado: use letras minúsculas, dígitos, - ou _, no máximo 32 caracteres, diferente do de qualquer outro bot.`,
    ),
  );
}

/** What a registry may not hold (a UsageError to throw): null when it is fine. */
function problem(file: BotRegistryFile): UsageError | null {
  if (file.bots.length > MAX_BOTS) return tooMany();
  for (const kind of CHANNEL_KINDS)
    if (file.bots.filter((record) => record.kind === kind).length > MAX_BOTS_PER_KIND)
      return tooManyOfKind();
  const names = new Set<string>();
  const characters = new Map<string, string>();
  const platforms = new Map<string, BotRecord>();
  for (const record of file.bots) {
    const platform = record.platformId && `${record.kind}:${record.platformId}`;
    const twin = platform ? platforms.get(platform) : undefined;
    if (twin) return new UsageError(alreadyRegistered(twin));
    if (platform) platforms.set(platform, record);
    if (!NAME.test(record.name) || names.has(record.name)) return badName(record.name);
    names.add(record.name);
    const npcId = record.character?.npcId;
    if (!npcId) continue;
    const other = characters.get(npcId);
    if (other !== undefined) return new DuplicateCharacter(npcId, other);
    characters.set(npcId, record.name);
  }
  return null;
}

/**
 * Why a bot of `kind` named `name` ('': its default name) could not be added to `registry` as it
 * is now, else null: asked before the platform is (a QR code scanned, a gateway session started),
 * and checked again under the registry's lock when the bot is kept.
 */
export function addProblem(
  registry: BotRegistry,
  kind: ChannelKind,
  name: string,
): UsageError | null {
  const bots = registry.list();
  if (name && (!NAME.test(name) || registry.find(name))) return badName(name);
  if (bots.length >= MAX_BOTS) return tooMany();
  if (bots.filter((record) => record.kind === kind).length >= MAX_BOTS_PER_KIND)
    return tooManyOfKind();
  return null;
}

/** The name a new bot gets: its Telegram username, `qq-<last 4 of the AppID>`, `wechat-<n>`. */
function defaultName(
  kind: ChannelKind,
  stored: StoredBot,
  handle: string,
  taken: ReadonlySet<string>,
): string {
  if (kind === 'wechat') {
    let number = 1;
    while (taken.has(`wechat-${number}`)) number += 1;
    return `wechat-${number}`;
  }
  let base = kind === 'telegram' ? handle.toLowerCase() : `qq-${stored.platformId.slice(-4)}`;
  if (!NAME.test(base)) base = kind;
  if (!taken.has(base)) return base;
  let number = 2;
  while (taken.has(`${base.slice(0, 29)}-${number}`)) number += 1;
  return `${base.slice(0, 29)}-${number}`;
}

/** The relay state of `scope` when there is one; never written here. */
function existingState(
  account: string,
  scope: string,
  kind: ChannelKind,
  dir: string,
): RelayState | null {
  const path = relayStatePath(account, scope, dir);
  return existsSync(path) ? new RelayState(path, scope, account, kind) : null;
}

type NewBot = {
  kind: ChannelKind;
  secretName: string;
  stored: StoredBot;
  /** `ChannelSetup.label` of the identity the platform gave, when it was asked. */
  label?: string;
  /** Telegram's username, when the platform was asked. */
  handle?: string;
};

/** A record for `bot`, from its state file when it has one (character, owner, username). */
function recordOf(
  bot: NewBot,
  state: RelayState | null,
  taken: ReadonlySet<string>,
  now: number,
  migrated: boolean,
): BotRecord {
  const data = state?.data;
  const handle = bot.handle ?? data?.botUsername ?? '';
  const character = data?.character ?? null;
  const record: BotRecord = {
    key: randomBytes(6).toString('hex'),
    name: defaultName(bot.kind, bot.stored, handle, taken),
    kind: bot.kind,
    character,
    platformId: bot.stored.platformId,
    ...(bot.kind === 'telegram' && handle ? { platformUser: handle } : {}),
    label: bot.label || (handle ? `@${handle}` : bot.stored.platformId),
    scope: bot.stored.scope,
    secretName: bot.secretName,
    lockName: bot.stored.lockName,
    // WeChat runs only with --experimental: given for every bot it ran before, and to add one.
    ...(bot.kind === 'wechat' ? { experimentalAcceptedAt: now } : {}),
    createdAt: now,
    boundAt: character ? now : 0,
    generation: 0,
    ...(migrated ? { migratedFrom: bot.kind } : {}),
  };
  const owner = data?.owner;
  if (owner && !state?.welcomeOwed)
    record.welcomeBaseline = { owner: ownerKey(owner.userId), npcId: character?.npcId ?? '' };
  return record;
}

/** `loser` was set to the character `winner` keeps: it is registered without one. */
function sharedCharacter(loser: BotRecord, winner: BotRecord, character: RelayCharacter): string {
  const name = character.name || character.npcId;
  return tr(
    `${loser.name} 和 ${winner.name} 都设成了角色 ${name}：一个角色只能跟一个 bot，登记在 ${winner.name} 名下。`,
    `${loser.name} and ${winner.name} were both set to the character ${name}: a character goes with one bot only, so it is registered to ${winner.name}.`,
    `${loser.name} y ${winner.name} tenían el mismo personaje, ${name}: un personaje va con un solo bot, así que queda registrado con ${winner.name}.`,
    `${loser.name} e ${winner.name} estavam com o mesmo personagem, ${name}: um personagem fica com um bot só, então ele fica registrado com ${winner.name}.`,
  );
}

export class BotRegistry {
  private constructor(
    readonly account: string,
    readonly path: string,
    private readonly dir: string,
    public data: BotRegistryFile,
  ) {}

  /** The registry as it is on disk (empty when there is none); a malformed one throws. */
  static open(account: string, dir = configDir()): BotRegistry {
    const path = registryPath(account, dir);
    return new BotRegistry(account, path, dir, readRegistry(path, account));
  }

  /** The bots, oldest first; only `kind`'s with it. */
  list(kind?: ChannelKind): BotRecord[] {
    return this.data.bots.filter((record) => !kind || record.kind === kind);
  }

  find(name: string): BotRecord | undefined {
    return this.data.bots.find((record) => record.name === name);
  }

  byCharacter(npcId: string): BotRecord | undefined {
    return this.data.bots.find((record) => record.character?.npcId === npcId);
  }

  byPlatform(kind: ChannelKind, platformId: string): BotRecord | undefined {
    return this.data.bots.find(
      (record) => record.kind === kind && platformId !== '' && record.platformId === platformId,
    );
  }

  /** The channel's bot whose secret is kept under `secretName` (the name each channel always used). */
  bySecret(kind: ChannelKind, secretName: string): BotRecord | undefined {
    return this.data.bots.find(
      (record) => record.kind === kind && record.secretName === secretName,
    );
  }

  /**
   * Changes the registry: `change` gets the file as it is on disk now (read again under the lock)
   * and returns false when it changed nothing (nothing is written). The result is checked
   * (names, platform ids, limits: a UsageError; characters: `DuplicateCharacter`), then `effects`
   * runs (what must be written with the change, still under the lock: a bot's secret and state),
   * then the file is written with the next revision. Whoever gave `effects` undoes them when this
   * throws.
   */
  commit(
    change: (file: BotRegistryFile) => boolean | void,
    effects?: (file: BotRegistryFile) => void,
  ): void {
    withFileLockSync(lockPath(this.account, this.dir), () => {
      const file = readRegistry(this.path, this.account);
      if (change(file) === false) {
        this.data = file;
        return;
      }
      const refusal = problem(file);
      if (refusal) throw refusal;
      effects?.(file);
      file.revision += 1;
      writeJsonFile(this.path, file);
      this.data = file;
    });
  }

  /**
   * Registers a new bot of `bot.kind` (design §1.2), as the record `effects` gets before the
   * registry is written, under its lock: its secret goes to `<the channel's secret name>#<key>`,
   * its state and lock are its platform id's (Telegram, QQ) or its own (WeChat: `bot:<key>`,
   * `bot-<key>`), its name is `name` or one made from the bot (`defaultName`). Refused, with
   * nothing written: a bot of the same platform id (`alreadyRegistered`), a name or character
   * another bot has, too many bots. Returns the record.
   */
  add(
    bot: Omit<NewBot, 'secretName'> & {
      name?: string;
      character?: RelayCharacter | null;
      experimentalAcceptedAt?: number;
    },
    effects?: (record: BotRecord) => void,
    now = Date.now(),
  ): BotRecord {
    let added: BotRecord | undefined;
    this.commit(
      (file) => {
        const twin = file.bots.find((record) => samePlatform(record, bot.kind, bot.stored));
        if (twin) throw new UsageError(alreadyRegistered(twin));
        const character = bot.character ?? null;
        const holder =
          character && file.bots.find((record) => record.character?.npcId === character.npcId);
        if (holder && character) throw new DuplicateCharacter(character.npcId, holder.name);
        const key = randomBytes(6).toString('hex');
        const own = bot.kind === 'wechat';
        const record = recordOf(
          {
            ...bot,
            secretName: `${channelSetup(bot.kind).secretName(this.account)}#${key}`,
            stored: {
              platformId: bot.stored.platformId,
              scope: own ? `bot:${key}` : bot.stored.scope,
              lockName: own ? `bot-${key}` : bot.stored.lockName,
            },
          },
          null,
          new Set(file.bots.map((item) => item.name)),
          now,
          false,
        );
        record.key = key;
        if (bot.name) record.name = bot.name;
        record.character = character;
        record.boundAt = character ? now : 0;
        if (bot.experimentalAcceptedAt) record.experimentalAcceptedAt = bot.experimentalAcceptedAt;
        file.bots = [...file.bots, record];
        added = record;
      },
      () => effects?.(added!),
    );
    return added!;
  }

  /**
   * New credentials for the bot `key` (design §1.2, renew), as `effects` writes them before the
   * registry, under its lock: they must be its own (`sameBot`; a WeChat login may name a new
   * ClawBot id, never another registered bot's). Its platform id, label and username follow them
   * and its `generation` moves on. Refused: credentials of another bot, a bot that is gone.
   * Returns the record.
   */
  renew(
    key: string,
    bot: Omit<NewBot, 'kind' | 'secretName'>,
    effects?: (record: BotRecord) => void,
  ): BotRecord {
    let renewed: BotRecord | undefined;
    this.commit(
      (file) => {
        const record = file.bots.find((item) => item.key === key);
        if (!record) throw new UsageError(gone());
        const twin = file.bots.find(
          (item) => item.key !== key && samePlatform(item, record.kind, bot.stored),
        );
        if (twin) throw new UsageError(alreadyRegistered(twin));
        if (record.kind !== 'wechat' && !sameBot(record, bot.stored))
          throw new UsageError(anotherBot(record));
        refresh(record, { ...bot, kind: record.kind, secretName: record.secretName });
        record.generation += 1;
        renewed = record;
      },
      () => effects?.(renewed!),
    );
    return renewed!;
  }

  /** Brings the bot's platform id, label and username up to date with what the platform said. */
  refresh(record: BotRecord, bot: Omit<NewBot, 'kind' | 'secretName'>): BotRecord {
    let updated = record;
    this.commit((file) => {
      const current = file.bots.find((item) => item.key === record.key);
      if (!current) return false;
      updated = current;
      return refresh(current, { ...bot, kind: current.kind, secretName: current.secretName });
    });
    return updated;
  }

  /**
   * The bot `key` talks as `character` from now on (`yomi relay --bot NAME --character ID`, or a
   * run's `--character` for a bot without one): its `boundAt` and `generation` move on. A
   * character another bot has is refused (`DuplicateCharacter`, checked again under the lock), and
   * so is a bot that is gone. Returns the record.
   */
  rebind(key: string, character: RelayCharacter, now = Date.now()): BotRecord {
    let updated: BotRecord | undefined;
    this.commit((file) => {
      const record = file.bots.find((item) => item.key === key);
      if (!record) throw new UsageError(gone());
      // Named before the record changes: the bot that has it, wherever it is in the file.
      const holder = file.bots.find(
        (other) => other.key !== key && other.character?.npcId === character.npcId,
      );
      if (holder) throw new DuplicateCharacter(character.npcId, holder.name);
      record.character = character;
      record.boundAt = now;
      record.generation += 1;
      updated = record;
    });
    return updated!;
  }

  /**
   * Whom `npcId` was shown to last (a `characterOwner`), as the file says now; undefined: nobody.
   * A registry that cannot be read says '?': someone, so the welcome shows nobody's conversation.
   */
  shownTo(npcId: string): string | undefined {
    try {
      this.commit(() => false);
    } catch {
      return '?';
    }
    return this.data.characterOwners[npcId];
  }

  /** `owner` (a `characterOwner`) was shown `npcId` last: paired, started or welcomed with it. */
  showedCharacter(npcId: string, owner: string) {
    if (this.data.characterOwners[npcId] === owner) return;
    this.commit((file) => {
      if (file.characterOwners[npcId] === owner) return false;
      file.characterOwners[npcId] = owner;
    });
  }

  /**
   * The bot's character is now `character` (null: none), for the owner `owner` (a
   * `characterOwner`, '' when none). Another bot's character is not taken: the bot is left
   * without one. The same character under a new name (or group) is only renamed.
   */
  bindCharacter(key: string, character: RelayCharacter | null, owner: string, now = Date.now()) {
    this.commit((file) => {
      const record = file.bots.find((item) => item.key === key);
      if (!record) return false;
      const held =
        character &&
        file.bots.some((item) => item.key !== key && item.character?.npcId === character.npcId);
      const next = held ? null : character;
      const same =
        record.character?.npcId === next?.npcId &&
        record.character?.name === next?.name &&
        record.character?.group === next?.group;
      const ownerChanged = Boolean(next && owner && file.characterOwners[next.npcId] !== owner);
      if (same && !ownerChanged) return false;
      if (!same) {
        const renamed = Boolean(next && record.character?.npcId === next.npcId);
        record.character = next;
        if (!renamed) record.boundAt = next ? now : 0;
      }
      if (next && owner) file.characterOwners[next.npcId] = owner;
    });
  }

  /** The Yomi user who runs the bots now. */
  bindAccount(userId: string) {
    if (this.data.yomiUserId === userId) return;
    this.commit((file) => {
      if (file.yomiUserId === userId) return false;
      file.yomiUserId = userId;
    });
  }

  /** Takes the bot `key` away (`--forget`); true when it was there. */
  remove(key: string): boolean {
    let removed = false;
    this.commit((file) => {
      const kept = file.bots.filter((record) => record.key !== key);
      removed = kept.length < file.bots.length;
      if (!removed) return false;
      file.bots = kept;
    });
    return removed;
  }
}

/** A bot changed while this command ran (removed or replaced by another one). */
function gone(): string {
  return tr(
    '这个 bot 刚刚被删除或换掉了：用 yomi relay --list 看看现在的 bot。',
    'This bot was just removed or replaced: see the bots now with yomi relay --list.',
    'Este bot se acaba de eliminar o reemplazar: mira los bots actuales con yomi relay --list.',
    'Este bot acabou de ser removido ou substituído: veja os bots atuais com yomi relay --list.',
  );
}

/** Credentials set again for `record` that are another bot's (design §1.2, renew). */
export function anotherBot(record: BotRecord): string {
  const setup = channelSetup(record.kind);
  const add = `${setup.command} ${setup.credentialsFlag} --character ID`;
  const forget = `yomi relay --forget --bot ${record.name}`;
  return tr(
    `这些凭证属于另一个 bot，不是 ${record.name}，没有保存。要把它作为新的 bot 加上：${add}；要先删掉 ${record.name}：${forget}`,
    `These credentials belong to another bot than ${record.name}, so they were not saved. To add it as a bot of its own: ${add}; to remove ${record.name} first: ${forget}`,
    `Estas credenciales son de otro bot, no de ${record.name}, así que no se guardaron. Para agregarlo como un bot propio: ${add}; para eliminar primero ${record.name}: ${forget}`,
    `Estas credenciais são de outro bot, não de ${record.name}, então não foram salvas. Para adicioná-lo como um bot próprio: ${add}; para remover ${record.name} primeiro: ${forget}`,
  );
}

/** `record` is the bot of `kind` whose platform id `stored` names. */
const samePlatform = (record: BotRecord, kind: ChannelKind, stored: StoredBot) =>
  record.kind === kind && stored.platformId !== '' && record.platformId === stored.platformId;

const sameNpc = (record: BotRecord, other: BotRecord) =>
  Boolean(record.character && record.character.npcId === other.character?.npcId);

/** Updates `record` from `bot` (the same bot); false when nothing changed. */
function refresh(record: BotRecord, bot: NewBot): boolean {
  let changed = false;
  // WeChat may give the same scanner's ClawBot a new id on a new login; the others never change it.
  const platformId = bot.stored.platformId;
  if (
    platformId &&
    record.platformId !== platformId &&
    (!record.platformId || bot.kind === 'wechat')
  ) {
    record.platformId = platformId;
    changed = true;
  }
  if (bot.label && record.label !== bot.label) {
    record.label = bot.label;
    changed = true;
  }
  if (bot.kind === 'telegram' && bot.handle && record.platformUser !== bot.handle) {
    record.platformUser = bot.handle;
    changed = true;
  }
  return changed;
}

export type MigrationInput = {
  account: string;
  store: Pick<CredentialStore, 'getSecret'>;
  dir?: string;
  /** Whether the channel's own background service (of before the registry) is installed. */
  installed?: (kind: ChannelKind) => boolean;
  now?: number;
};

/**
 * Takes over the bots the channels' credentials stored before the registry (design §4.3): every
 * channel's secret under its own name that no bot has yet becomes a bot, under the scope, lock and
 * secret name it always had, with the character, owner and username of its state file. Two of them
 * set to the same character: the one whose service is installed keeps it, else the one paired last,
 * else Telegram, QQ, WeChat in that order; a bot already registered keeps its own. Writes only the
 * registry (never a state file or the keychain), and only when there is something to take over.
 * Run before anything else a `yomi relay` does; returns the registry and what to warn about once.
 */
export function migrateRegistry(input: MigrationInput): {
  registry: BotRegistry;
  warnings: string[];
} {
  const { account, store } = input;
  const dir = input.dir ?? configDir();
  const registry = BotRegistry.open(account, dir);
  const waiting = () =>
    CHANNEL_KINDS.flatMap((kind) => {
      const setup = channelSetup(kind);
      const secretName = setup.secretName(account);
      if (registry.bySecret(kind, secretName)) return [];
      const secret = store.getSecret(secretName);
      const stored = secret ? setup.storedBot(secret) : null;
      // A bot registered since (added under its own secret) is not taken over a second time.
      if (stored && registry.list(kind).some((record) => samePlatform(record, kind, stored)))
        return [];
      return stored ? [{ kind, secretName, stored }] : [];
    });
  const found = waiting();
  if (!found.length) return { registry, warnings: [] };
  const warnings: string[] = [];
  const now = input.now ?? Date.now();
  registry.commit((file) => {
    warnings.length = 0;
    const taken = new Set(file.bots.map((record) => record.name));
    const added: { record: BotRecord; state: RelayState | null }[] = [];
    for (const bot of found) {
      if (
        file.bots.some((record) => record.kind === bot.kind && record.secretName === bot.secretName)
      )
        continue;
      const state = existingState(account, bot.stored.scope, bot.kind, dir);
      const record = recordOf(bot, state, taken, now, true);
      taken.add(record.name);
      added.push({ record, state });
    }
    if (!added.length) return false;
    // Who keeps a character two of them have: the installed service, the latest pairing, the order.
    const rank = (entry: (typeof added)[number]) => [
      input.installed?.(entry.record.kind) ? 0 : 1,
      -(entry.state?.data.owner?.pairedAt ?? 0),
      CHANNEL_KINDS.indexOf(entry.record.kind),
    ];
    const ordered = [...added].sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
    const holders = [...file.bots];
    for (const { record, state } of ordered) {
      const character = record.character;
      const holder = character && holders.find((item) => sameNpc(item, record));
      if (holder && character) {
        warnings.push(sharedCharacter(record, holder, character));
        record.character = null;
        record.boundAt = 0;
      }
      holders.push(record);
      const owner = state?.data.owner;
      if (record.character && owner)
        file.characterOwners[record.character.npcId] ??= characterOwner(record.kind, owner.userId);
      if (!file.yomiUserId && state?.data.yomiUserId) file.yomiUserId = state.data.yomiUserId;
    }
    file.bots = [...file.bots, ...added.map((entry) => entry.record)];
    file.migratedAt ??= now;
  });
  return { registry, warnings };
}
