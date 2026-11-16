// The writing half of the connection codec (thrift.ts); keep in step with the service protocol.
import type { ImContent, ImMessage, ImParagraph } from './models.js';
import type { AsideEvent, ChatLineChanged, StreamEvent } from './thrift.js';

/**
 * A TBinaryProtocol writer: the client never sends Thrift, so this writes fixtures for tests and
 * the mock server's pushes (`src/mock/`).
 */
export class ThriftWriter {
  private bytes: number[] = [];
  private push(view: (data: DataView) => void, size: number) {
    const buffer = new DataView(new ArrayBuffer(size));
    view(buffer);
    for (let index = 0; index < size; index++) this.bytes.push(buffer.getUint8(index));
  }
  field(type: number, id: number) {
    this.bytes.push(type);
    this.push((data) => data.setInt16(0, id), 2);
    return this;
  }
  i32(id: number, value: number) {
    this.field(8, id);
    this.push((data) => data.setInt32(0, value), 4);
    return this;
  }
  i64(id: number, value: string | number | bigint) {
    this.field(10, id);
    this.push((data) => data.setBigInt64(0, BigInt(value)), 8);
    return this;
  }
  bool(id: number, value: boolean) {
    this.field(2, id);
    this.bytes.push(value ? 1 : 0);
    return this;
  }
  string(id: number, value: string) {
    this.field(11, id);
    return this.raw(value);
  }
  raw(value: string) {
    const encoded = new TextEncoder().encode(value);
    this.push((data) => data.setInt32(0, encoded.length), 4);
    for (const byte of encoded) this.bytes.push(byte);
    return this;
  }
  begin(id: number) {
    return this.field(12, id);
  }
  /** A list of `count` structs; write each struct's fields then `stop()`. */
  list(id: number, count: number) {
    this.field(15, id);
    this.bytes.push(12);
    this.push((data) => data.setInt32(0, count), 4);
    return this;
  }
  stop() {
    this.bytes.push(0);
    return this;
  }
  get data() {
    return new Uint8Array(this.bytes);
  }
}

function writeParagraphs(w: ThriftWriter, id: number, paragraphs: ImParagraph[]) {
  w.list(id, paragraphs.length);
  for (const paragraph of paragraphs) {
    w.i32(1, paragraph.type).string(2, paragraph.text);
    if (paragraph.npcId) w.i64(3, paragraph.npcId);
    if (paragraph.npcName) w.string(4, paragraph.npcName);
    w.stop();
  }
}

function writeContent(w: ThriftWriter, content: ImContent) {
  w.begin(3);
  if (content.text) w.string(1, content.text);
  if (content.images.length) {
    w.list(2, content.images.length);
    for (const image of content.images) {
      if (image.url) w.string(1, image.url);
      if (image.assetId) w.i64(2, image.assetId);
      if (image.thumbnailUrl) w.string(3, image.thumbnailUrl);
      if (image.width) w.i32(4, image.width);
      if (image.height) w.i32(5, image.height);
      w.stop();
    }
  }
  if (content.paragraphs.length) writeParagraphs(w, 5, content.paragraphs);
  w.stop();
}

function writeMessage(w: ThriftWriter, message: ImMessage) {
  w.begin(8).i64(1, message.mid);
  if (message.parentMid) w.i64(2, message.parentMid);
  writeContent(w, message.content);
  w.i64(5, message.timestamp).i32(6, message.senderType).i32(7, message.semantic);
  if (message.sourceMid) w.i64(8, message.sourceMid);
  w.stop();
}

/**
 * `StreamEvent` in Thrift binary. `chunkThinking` is the chunk's
 * `thinking_content` (4), which the client never reads: fixtures use it to prove that.
 */
export function encodeStreamEvent(event: StreamEvent & { chunkThinking?: string }): Uint8Array {
  const w = new ThriftWriter();
  w.i32(1, event.type).i64(2, event.entityId).i32(3, event.entityType);
  if (event.streamId) w.string(4, event.streamId);
  if (event.seq) w.i64(5, event.seq);
  if (event.chunk) {
    w.begin(7).i64(1, event.chunk.mid).string(2, event.chunk.text);
    if (event.chunkThinking) w.string(4, event.chunkThinking);
    if (event.chunk.parentMid) w.i64(5, event.chunk.parentMid);
    if (event.chunk.paragraphs) writeParagraphs(w, 6, event.chunk.paragraphs);
    w.stop();
  }
  if (event.message) writeMessage(w, event.message);
  if (event.error) w.begin(10).string(1, event.error.code).string(2, event.error.message).stop();
  if (event.cid) w.i64(11, event.cid);
  // Normal (1) is what an absent purpose means; only another one is written.
  if (event.purpose !== undefined && event.purpose !== 1) w.i32(12, event.purpose);
  return w.stop().data;
}

/** `AsideEvent` in Thrift binary. */
export function encodeAsideEvent(event: AsideEvent): Uint8Array {
  const w = new ThriftWriter();
  w.string(1, event.asideId).i64(2, event.entityId).i32(3, event.entityType);
  if (event.cid) w.i64(4, event.cid);
  if (event.anchorMid) w.i64(5, event.anchorMid);
  w.begin(6).string(1, event.aside.scene).i32(2, event.aside.style);
  w.list(3, event.aside.texts.length);
  for (const link of event.aside.texts) {
    w.string(1, link.text);
    if (link.schema) w.string(2, link.schema);
    w.stop();
  }
  w.stop();
  if (event.createdAt) w.i64(7, event.createdAt);
  return w.stop().data;
}

/**
 * `ChatLineProgressEvent` in Thrift binary, for the mock server's pushes. Its
 * snapshot (4) is left out: the client never reads it.
 */
export function encodeChatLineChanged(
  event: ChatLineChanged & { entityType?: number; createdAt?: number },
): Uint8Array {
  const w = new ThriftWriter().i64(1, event.cid).i64(2, event.entityId);
  w.i32(3, event.entityType ?? 1);
  if (event.createdAt) w.i64(5, event.createdAt);
  return w.stop().data;
}
