// Mirrors the Yomi clients' connection codec; keep in step with the service protocol.
import {
  emptyContent,
  type ImAside,
  type ImAsideLink,
  type ImContent,
  type ImImage,
  type ImMessage,
  type ImParagraph,
  SenderType,
} from './models.js';

/**
 * A TBinaryProtocol reader for the connection's business payloads: the conversation stream
 * (`StreamEvent`) and asides (`AsideEvent`) are Thrift binary. Unknown fields
 * are skipped; a known field of the wrong type fails.
 */
export class ThriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThriftError';
  }
}

export type ThriftValue =
  | { type: 'bool'; value: boolean }
  | { type: 'byte'; value: number }
  | { type: 'double'; value: number }
  | { type: 'i16'; value: number }
  | { type: 'i32'; value: number }
  | { type: 'i64'; value: bigint }
  | { type: 'binary'; value: Uint8Array }
  | { type: 'struct'; value: Fields }
  | { type: 'list'; value: ThriftValue[] }
  | { type: 'map'; value: Array<[ThriftValue, ThriftValue]> };

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_DEPTH = 32;

/** One struct's fields; a repeated id keeps the last value, as generated code does. */
export class Fields {
  constructor(private readonly entries: Array<[number, ThriftValue]> = []) {}
  add(id: number, value: ThriftValue) {
    this.entries.push([id, value]);
  }
  get(id: number): ThriftValue | undefined {
    for (let index = this.entries.length - 1; index >= 0; index--)
      if (this.entries[index][0] === id) return this.entries[index][1];
    return undefined;
  }
  private typed<T extends ThriftValue['type']>(id: number, type: T) {
    const value = this.get(id);
    if (value === undefined) return undefined;
    if (value.type !== type) throw new ThriftError(`field ${id} is not ${type}`);
    return value as Extract<ThriftValue, { type: T }>;
  }
  bool(id: number) {
    return this.typed(id, 'bool')?.value;
  }
  i32(id: number) {
    return this.typed(id, 'i32')?.value;
  }
  /** An i64 as decimal digits. */
  i64(id: number) {
    return this.typed(id, 'i64')?.value.toString();
  }
  /** An i64 that must fit a JS number (times, sequence numbers). */
  i64Number(id: number) {
    const value = this.typed(id, 'i64')?.value;
    if (value === undefined) return undefined;
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw new ThriftError(`field ${id} is out of range`);
    return Number(value);
  }
  string(id: number) {
    const value = this.typed(id, 'binary')?.value;
    if (value === undefined) return undefined;
    try {
      return utf8.decode(value);
    } catch {
      throw new ThriftError(`field ${id} is not utf-8`);
    }
  }
  struct(id: number) {
    return this.typed(id, 'struct')?.value;
  }
  structs(id: number): Fields[] | undefined {
    const value = this.typed(id, 'list')?.value;
    if (value === undefined) return undefined;
    return value.map((item) => {
      if (item.type !== 'struct') throw new ThriftError(`field ${id} is not list<struct>`);
      return item.value;
    });
  }
}

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get done() {
    return this.offset === this.bytes.length;
  }
  private take(count: number): Uint8Array {
    if (count < 0 || this.offset + count > this.bytes.length) throw new ThriftError('truncated');
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }
  private byte() {
    return this.take(1)[0];
  }
  private view(count: number) {
    const slice = this.take(count);
    return new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  }
  /** Sizes are i32 and never more than what is left. */
  private size() {
    const value = this.view(4).getInt32(0);
    if (value < 0 || value > this.bytes.length - this.offset) throw new ThriftError('invalid size');
    return value;
  }
  struct(depth: number): Fields {
    if (depth >= MAX_DEPTH) throw new ThriftError('nesting too deep');
    const fields = new Fields();
    for (;;) {
      const type = this.byte();
      if (type === 0) return fields;
      const id = this.view(2).getInt16(0);
      fields.add(id, this.value(type, depth));
    }
  }
  value(type: number, depth: number): ThriftValue {
    switch (type) {
      case 2:
        return { type: 'bool', value: this.byte() !== 0 };
      case 3:
        return { type: 'byte', value: this.view(1).getInt8(0) };
      case 4:
        return { type: 'double', value: this.view(8).getFloat64(0) };
      case 6:
        return { type: 'i16', value: this.view(2).getInt16(0) };
      case 8:
        return { type: 'i32', value: this.view(4).getInt32(0) };
      case 10:
        return { type: 'i64', value: this.view(8).getBigInt64(0) };
      case 11:
        return { type: 'binary', value: this.take(this.size()) };
      case 12:
        return { type: 'struct', value: this.struct(depth + 1) };
      case 13: {
        const keyType = this.byte();
        const valueType = this.byte();
        const count = this.size();
        const entries: Array<[ThriftValue, ThriftValue]> = [];
        for (let index = 0; index < count; index++)
          entries.push([this.value(keyType, depth + 1), this.value(valueType, depth + 1)]);
        return { type: 'map', value: entries };
      }
      case 14:
      case 15: {
        const element = this.byte();
        const count = this.size();
        const items: ThriftValue[] = [];
        for (let index = 0; index < count; index++) items.push(this.value(element, depth + 1));
        return { type: 'list', value: items };
      }
      default:
        throw new ThriftError(`unknown wire type ${type}`);
    }
  }
}

/** One top-level struct that must take the whole payload. */
export function readStruct(bytes: Uint8Array): Fields {
  const reader = new Reader(bytes);
  const fields = reader.struct(0);
  if (!reader.done) throw new ThriftError('trailing bytes');
  return fields;
}

// ---------------------------------------------------------------------------------------------
// StreamEvent

/** `StreamEventType`. */
export const StreamEventType = {
  unknown: 0,
  messageChunk: 1,
  messageCompleted: 2,
  error: 3,
  /** An independently committed message (a generated image); not part of a text stream. */
  messagePersisted: 4,
} as const;

/** `StreamMessageChunk`: a cumulative snapshot, never history. */
export type StreamChunk = {
  mid: string;
  text: string;
  parentMid: string;
  /** Reviewed cumulative paragraphs; null when the server sent none. */
  paragraphs: ImParagraph[] | null;
};

export type StreamEvent = {
  type: number;
  entityId: string;
  entityType: number;
  /** '' for MessagePersisted. */
  streamId: string;
  /** From 1 within a stream; 0 for MessagePersisted. */
  seq: number;
  chunk: StreamChunk | null;
  /** The final persisted message, or the committed message of MessagePersisted. */
  message: ImMessage | null;
  error: { code: string; message: string } | null;
  /** Required for MessagePersisted. */
  cid: string;
  /** `ConversationPurpose`: absent is Normal (1); UgcPreview (2) belongs to the preview only. */
  purpose?: number;
};

/** `ConversationPurpose`. */
export const ConversationPurpose = { unknown: 0, normal: 1, ugcPreview: 2 } as const;

function paragraphs(list: Fields[] | undefined): ImParagraph[] | null {
  if (!list) return null;
  return list.map((f) => ({
    type: f.i32(1) ?? 0,
    text: f.string(2) ?? '',
    npcId: positive(f.i64(3)),
    npcName: f.string(4) ?? '',
  }));
}

function positive(value: string | undefined): string {
  return value && value !== '0' && !value.startsWith('-') ? value : '';
}

function https(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : '';
  } catch {
    return '';
  }
}

function content(f: Fields | undefined): ImContent {
  if (!f) return emptyContent();
  const images: ImImage[] = (f.structs(2) ?? []).map((image) => ({
    url: https(image.string(1)),
    assetId: positive(image.i64(2)),
    thumbnailUrl: https(image.string(3)),
    width: image.i32(4) ?? 0,
    height: image.i32(5) ?? 0,
    accessExpiresAtMs: image.i64Number(6) ?? 0,
    objectKey: image.string(7) ?? '',
  }));
  const audio = f.struct(3);
  return emptyContent({
    text: f.string(1) ?? '',
    images,
    paragraphs: paragraphs(f.structs(5)) ?? [],
    audio: audio ? { url: https(audio.string(1)), durationMs: audio.i64Number(2) ?? 0 } : null,
  });
}

/** Decodes a `YomiConversationStream` payload. */
export function decodeStreamEvent(bytes: Uint8Array): StreamEvent {
  const f = readStruct(bytes);
  const type = f.i32(1);
  const entityId = f.i64(2);
  const entityType = f.i32(3);
  if (type === undefined || entityId === undefined || entityType === undefined)
    throw new ThriftError('StreamEvent missing identity fields');
  const persisted = type === StreamEventType.messagePersisted;
  const streamId = f.string(4);
  const seq = f.i64Number(5);
  if (!persisted && (streamId === undefined || seq === undefined))
    throw new ThriftError('StreamEvent missing stream_id/event_seq');
  const event: StreamEvent = {
    type,
    entityId,
    entityType,
    streamId: streamId ?? '',
    seq: seq ?? 0,
    chunk: null,
    message: null,
    error: null,
    cid: positive(f.i64(11)),
    purpose: f.i32(12) ?? ConversationPurpose.normal,
  };
  const chunk = f.struct(7);
  if (chunk) {
    const mid = chunk.i64(1);
    if (mid === undefined) throw new ThriftError('chunk.mid missing');
    event.chunk = {
      mid,
      text: chunk.string(2) ?? '',
      parentMid: positive(chunk.i64(5)),
      paragraphs: paragraphs(chunk.structs(6)),
    };
  }
  const message = f.struct(8);
  if (message) {
    const mid = message.i64(1);
    const timestamp = message.i64Number(5);
    if (mid === undefined || timestamp === undefined)
      throw new ThriftError('message.mid/timestamp missing');
    event.message = {
      mid,
      parentMid: positive(message.i64(2)),
      content: content(message.struct(3)),
      timestamp,
      senderType: message.i32(6) ?? SenderType.assistant,
      semantic: message.i32(7) ?? 0,
      sourceMid: positive(message.i64(8)),
    };
  }
  const error = f.struct(10);
  if (error) event.error = { code: error.string(1) ?? '', message: error.string(2) ?? '' };
  return event;
}

const isPositive = (value: string) => /^[1-9][0-9]*$/.test(value);

/**
 * The app's checks on a stream event: a chunk carries only a chunk, a completion only its message,
 * an error its error (and maybe the message kept so far); MessagePersisted needs a cid.
 */
export function validateStreamEvent(event: StreamEvent) {
  const fail = () => {
    throw new ThriftError('invalid stream event');
  };
  if (!isPositive(event.entityId)) fail();
  if (event.type === StreamEventType.messagePersisted) {
    if (
      !event.cid ||
      !event.message ||
      !isPositive(event.message.mid) ||
      event.chunk ||
      event.error
    )
      fail();
    return;
  }
  if (!event.streamId || event.seq <= 0) fail();
  switch (event.type) {
    case StreamEventType.messageChunk:
      if (!event.chunk || !isPositive(event.chunk.mid) || event.message || event.error) fail();
      break;
    case StreamEventType.messageCompleted:
      if (!event.message || !isPositive(event.message.mid) || event.chunk || event.error) fail();
      break;
    case StreamEventType.error:
      if (!event.error || event.chunk) fail();
      break;
    default:
      fail();
  }
}

// ---------------------------------------------------------------------------------------------
// AsideEvent

export type AsideEvent = {
  asideId: string;
  entityId: string;
  entityType: number;
  cid: string;
  /** The reply it follows (shown below it). */
  anchorMid: string;
  aside: ImAside;
  /** Unix ms; 0 when absent. */
  createdAt: number;
};

/** Decodes a `YomiConversationAside` payload. */
export function decodeAsideEvent(bytes: Uint8Array): AsideEvent {
  const f = readStruct(bytes);
  const asideId = f.string(1);
  const entityId = f.i64(2);
  const entityType = f.i32(3);
  if (!asideId || entityId === undefined || entityType === undefined)
    throw new ThriftError('AsideEvent missing aside_id or entity');
  const a = f.struct(6);
  if (!a) throw new ThriftError('AsideEvent missing aside');
  const links = (id: number): ImAsideLink[] =>
    (a.structs(id) ?? []).map((link) => ({
      text: link.string(1) ?? '',
      schema: link.string(2) ?? '',
    }));
  let created = f.i64Number(7) ?? 0;
  // Server times are milliseconds; an older second-based value is scaled.
  if (created > 0 && created < 100_000_000_000) created *= 1000;
  return {
    asideId,
    entityId,
    entityType,
    cid: positive(f.i64(4)),
    anchorMid: positive(f.i64(5)),
    aside: {
      scene: a.string(1) ?? '',
      style: a.i32(2) ?? 1,
      texts: links(3),
      title: a.string(4) ?? '',
      iconUrl: https(a.string(5)),
      buttons: links(6),
    },
    createdAt: created,
  };
}

/**
 * The aside's local message id: stable for its `aside_id`, negative (no server mid), never the
 * opening line's -1 (the app hashes it the same way, with SHA-256; any stable hash does).
 */
export function asideLocalMid(asideId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(asideId)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(48, hash * 0x100000001b3n);
  }
  return (-(hash + 2n)).toString();
}

// ---------------------------------------------------------------------------------------------
// ChatLineProgressEvent

/** A group chat's story events changed: a signal to read them again. */
export type ChatLineChanged = { cid: string; entityId: string };

/**
 * Decodes a `YomiChatLineProgress` payload as the app does: cid and entity_id positive,
 * entity_type 1, else it fails. The snapshot (4) and created_at (5) are not read: like the app,
 * the client reads the progress again instead of trusting a pushed one.
 */
export function decodeChatLineChanged(bytes: Uint8Array): ChatLineChanged {
  const f = readStruct(bytes);
  const cid = f.i64(1) ?? '';
  const entityId = f.i64(2) ?? '';
  if (!isPositive(cid) || !isPositive(entityId) || f.i32(3) !== 1)
    throw new ThriftError('invalid chat line scope');
  return { cid, entityId };
}
