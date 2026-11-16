// Mirrors the Yomi clients' conversation models; keep in step with the service protocol.
import {
  count,
  i64,
  id,
  image,
  integer,
  type Json,
  list,
  object,
  optionalId,
  optionalObject,
  text,
} from '../core/json.js';

/**
 * Conversation wire models (the service's `conversation_base` types), as the Yomi clients read
 * them: IDs as decimal strings, every Thrift field optional (missing reads as empty / zero).
 */

/** `SenderType`. */
export const SenderType = { unknown: 0, user: 1, assistant: 2, system: 3 } as const;

/**
 * `MessageSemantic`; `aside` (2) is the client's own kind for a pushed system
 * note (`AsideEvent`), which history never returns.
 */
export const Semantic = { dialogueTurn: 0, generatedAsset: 1, aside: 2 } as const;

/** `ParagraphType`. */
export const ParagraphType = { narration: 1, dialogue: 2 } as const;

/** NPC conversations are `EntityType.WorldView` (1); 2 is an internal story scope. */
export const NPC_ENTITY_TYPE = 1;

/** The NPC opening line the client shows; the server keeps no such message. */
export const PROLOGUE_MID = '-1';

export type ImImage = {
  url: string;
  assetId: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  /** Unix ms after which the signed links stop opening; 0 when stable. */
  accessExpiresAtMs: number;
  /** A user upload (`user_image/create_upload`). */
  objectKey: string;
};

export type ImParagraph = {
  type: number;
  text: string;
  /** The speaking NPC (dialogue only); '' for narration. */
  npcId: string;
  npcName: string;
};

export type ImAsideLink = { text: string; schema: string };

/** `AsideInfo`: a system note in the chat ("Memory updated, view now."). */
export type ImAside = {
  scene: string;
  /** 1 text, 2 card. */
  style: number;
  texts: ImAsideLink[];
  title: string;
  iconUrl: string;
  buttons: ImAsideLink[];
};

export type ImContent = {
  text: string;
  images: ImImage[];
  /** Ordered model paragraphs; `text` is their plain projection. */
  paragraphs: ImParagraph[];
  audio: { url: string; durationMs: number } | null;
  aside: ImAside | null;
};

/** `RoamingMessage`. Reply versions share `parentMid`. */
export type ImMessage = {
  mid: string;
  senderType: number;
  parentMid: string;
  content: ImContent;
  /** Unix ms. */
  timestamp: number;
  semantic: number;
  /** A generated image's source text message. */
  sourceMid: string;
};

/** `MessageCursor`: exclusive, (timestamp, mid). */
export type ImCursor = { timestamp: number; mid: string };

export const AsideScene = { memoryUpdated: 'memory_updated' } as const;

export function emptyContent(patch: Partial<ImContent> = {}): ImContent {
  return { text: '', images: [], paragraphs: [], audio: null, aside: null, ...patch };
}

// ---------------------------------------------------------------------------------------------
// JSON (Gateway HTTP)

/** An https media link, or '' (a link the contract does not allow is treated as missing). */
export function mediaURL(value: unknown): string {
  try {
    return image(value);
  } catch {
    return '';
  }
}

export function parseImage(value: unknown): ImImage {
  const raw = object(value);
  return {
    url: mediaURL(raw.url),
    assetId: optionalId(raw.asset_id),
    thumbnailUrl: mediaURL(raw.thumbnail_url),
    width: count(raw.width),
    height: count(raw.height),
    accessExpiresAtMs: count(raw.access_expires_at_ms),
    objectKey: text(raw.object_key),
  };
}

export function parseParagraph(value: unknown): ImParagraph {
  const raw = object(value);
  return {
    type: count(raw.type),
    text: text(raw.text),
    npcId: optionalId(raw.npc_id),
    npcName: text(raw.npc_name),
  };
}

export function parseContent(value: unknown): ImContent {
  const raw = optionalObject(value);
  const audio = raw.audio ? object(raw.audio) : null;
  return {
    text: text(raw.text),
    images: list(raw.images).map(parseImage),
    paragraphs: list(raw.paragraphs).map(parseParagraph),
    audio: audio ? { url: mediaURL(audio.url), durationMs: count(audio.duration_ms) } : null,
    aside: null,
  };
}

export function parseMessage(value: unknown): ImMessage {
  const raw = object(value);
  return {
    mid: id(raw.mid),
    senderType: count(raw.sender_type),
    parentMid: optionalId(raw.parent_mid),
    content: parseContent(raw.content),
    timestamp: integer(raw.timestamp),
    semantic: count(raw.semantic),
    sourceMid: optionalId(raw.source_mid),
  };
}

export function parseCursor(value: unknown): ImCursor | null {
  if (value === undefined || value === null) return null;
  const raw = object(value);
  const mid = optionalId(raw.mid);
  if (!mid) return null;
  return { timestamp: count(raw.timestamp), mid };
}

/** `Paragraph` as JSON for `rewrite_message`. */
export function paragraphJSON(paragraph: ImParagraph): Json {
  const result: Json = { type: paragraph.type, text: paragraph.text };
  if (paragraph.type === ParagraphType.dialogue && paragraph.npcId) {
    result.npc_id = i64(paragraph.npcId);
    if (paragraph.npcName) result.npc_name = paragraph.npcName;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Message helpers

export function compareMid(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ordered by (timestamp, mid), as history is. */
export function compareMessages(a: ImMessage, b: ImMessage): number {
  return a.timestamp - b.timestamp || compareMid(a.mid, b.mid);
}

export const isPrologue = (message: ImMessage) => message.mid === PROLOGUE_MID;
export const isAside = (message: ImMessage) => message.semantic === Semantic.aside;
export const isDialogueTurn = (message: ImMessage) => message.semantic === Semantic.dialogueTurn;
export const isFromUser = (message: ImMessage) => message.senderType === SenderType.user;

/** Reply-version group: an assistant text turn's positive `parentMid`; '' otherwise. */
export function replyGroup(message: ImMessage): string {
  if (message.senderType !== SenderType.assistant || message.semantic !== Semantic.dialogueTurn)
    return '';
  return message.parentMid && message.parentMid !== '0' ? message.parentMid : '';
}

/** A shown piece of a message: narration, a character's line, or a type this client lacks. */
export type DisplayBlock = {
  id: string;
  kind: 'narration' | 'dialogue' | 'unsupported';
  text: string;
  /** The speaking NPC; '' for the room's character or narration. */
  speakerId: string;
};

/**
 * As the app shows a message: one block per non-empty paragraph, id `<mid>.<index>` (the index
 * is the paragraph's position, which `generate_audio` takes); null without paragraphs.
 */
export function displayBlocks(content: ImContent, mid: string): DisplayBlock[] | null {
  if (content.paragraphs.length === 0) return null;
  const blocks: DisplayBlock[] = [];
  content.paragraphs.forEach((paragraph, index) => {
    if (!paragraph.text) return;
    const kind =
      paragraph.type === ParagraphType.narration
        ? 'narration'
        : paragraph.type === ParagraphType.dialogue
          ? 'dialogue'
          : 'unsupported';
    blocks.push({ id: `${mid}.${index}`, kind, text: paragraph.text, speakerId: paragraph.npcId });
  });
  return blocks;
}

/** An aside's parts as shown: Latin parts sent back to back get a space between them. */
export function asideTexts(aside: ImAside): string[] {
  const result: string[] = [];
  for (const link of aside.texts) {
    const value = link.text;
    const last = result.length ? result[result.length - 1].slice(-1) : '';
    const first = value.charAt(0);
    if (last && /[\x21-\x7e]/.test(last) && /^[A-Za-z0-9]$/.test(first)) result.push(' ' + value);
    else result.push(value);
  }
  return result;
}

export function asidePlainText(aside: ImAside): string {
  return asideTexts(aside).join('');
}
