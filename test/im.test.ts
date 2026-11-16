import { describe, expect, it } from 'vitest';

import { BusinessType, Command, decodePacket, encodePacket } from '../src/im/packet.js';
import {
  ConversationPurpose,
  decodeStreamEvent,
  StreamEventType,
  validateStreamEvent,
} from '../src/im/thrift.js';
import { encodeStreamEvent } from '../src/im/thriftWriter.js';
import { openingParagraphs } from '../src/mock/server.js';

describe('the long connection payloads', () => {
  it('round-trips a preview stream event through the packet and Thrift', () => {
    const event = {
      type: StreamEventType.messageChunk,
      entityId: '7300000000000000999',
      entityType: 1,
      streamId: 'st_1',
      seq: 1,
      chunk: { mid: '7300000000000001000', text: '她笑了', parentMid: '', paragraphs: null },
      message: null,
      error: null,
      cid: '7300000000000000777',
      purpose: ConversationPurpose.ugcPreview,
    };
    const bytes = encodePacket({
      command: Command.businessStreaming,
      businessType: BusinessType.ugcPreviewStream,
      sid: 3,
      sequenceId: '7300000000000000001',
      payload: encodeStreamEvent(event),
    });
    const packet = decodePacket(bytes);
    expect(packet).toMatchObject({
      command: 101,
      businessType: 5,
      sid: 3,
      sequenceId: '7300000000000000001',
    });
    const decoded = decodeStreamEvent(packet.payload);
    validateStreamEvent(decoded);
    expect(decoded).toMatchObject({
      type: 1,
      entityId: '7300000000000000999',
      streamId: 'st_1',
      cid: '7300000000000000777',
      purpose: 2,
      chunk: { mid: '7300000000000001000', text: '她笑了' },
    });
  });
});

describe('the mock opening', () => {
  it('splits quoted lines into dialogue', () => {
    expect(
      openingParagraphs('雨停了。"你来了。"她说。', '9', 'A').map((p) => [p.type, p.text]),
    ).toEqual([
      [1, '雨停了。'],
      [2, '你来了。'],
      [1, '她说。'],
    ]);
  });
});
