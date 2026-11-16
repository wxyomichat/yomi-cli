// Mirrors the Yomi clients' connection envelope; keep in step with the service protocol.
/**
 * The long connection's envelope (protobuf), as the Yomi clients read it. Only the envelope is
 * read here; business payloads stay bytes.
 */

/** `packet.Command`. */
export const Command = {
  unknown: 0,
  ack: 1,
  loginSuccess: 2,
  /** For clients that cannot send WebSocket ping frames (browsers). */
  ping: 3,
  business: 100,
  businessStreaming: 101,
  echo: 102,
} as const;

/** `BusinessType`, scoped to the app. */
export const BusinessType = {
  /** `StreamEvent`, Thrift binary. */
  conversationStream: 1,
  /** `AsideEvent`, Thrift binary; push only. */
  conversationAside: 4,
  /** A creator's preview chat (`StreamEvent` with purpose UgcPreview); never ordinary chat. */
  ugcPreviewStream: 5,
  /**
   * `ChatLineProgressEvent`, Thrift binary; push only: a group chat's story
   * events changed (`YomiChatLineProgress`).
   */
  chatLineProgress: 7,
} as const;

export type Packet = {
  command: number;
  businessType: number;
  traceId: string;
  sid: number;
  /** Unix ms. */
  sentAt: number;
  userId: string;
  deviceId: string;
  /** i64 as decimal digits; '0' when absent. */
  sequenceId: string;
  payload: Uint8Array;
};

export class PacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketError';
  }
}

export function packet(fields: Partial<Packet>): Packet {
  return {
    command: 0,
    businessType: 0,
    traceId: '',
    sid: 0,
    sentAt: 0,
    userId: '',
    deviceId: '',
    sequenceId: '0',
    payload: new Uint8Array(),
    ...fields,
  };
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Protobuf bytes of a packet; zero and empty fields are left out, as proto3 writes them. */
export function encodePacket(value: Partial<Packet>): Uint8Array {
  const p = packet(value);
  const out: number[] = [];
  const varint = (input: bigint) => {
    let remaining = BigInt.asUintN(64, input);
    while (remaining >= 128n) {
      out.push(Number(remaining & 0x7fn) | 0x80);
      remaining >>= 7n;
    }
    out.push(Number(remaining));
  };
  const integer = (field: number, input: bigint) => {
    if (input === 0n) return;
    varint(BigInt(field << 3));
    varint(input);
  };
  const bytes = (field: number, input: Uint8Array) => {
    if (input.length === 0) return;
    varint(BigInt((field << 3) | 2));
    varint(BigInt(input.length));
    for (const byte of input) out.push(byte);
  };
  integer(1, BigInt(p.command));
  integer(2, BigInt(p.businessType));
  bytes(3, utf8.encode(p.traceId));
  integer(4, BigInt(p.sid >>> 0));
  integer(5, BigInt(Math.trunc(p.sentAt)));
  bytes(6, utf8.encode(p.userId));
  bytes(7, utf8.encode(p.deviceId));
  integer(8, BigInt(p.sequenceId || '0'));
  bytes(100, p.payload);
  return new Uint8Array(out);
}

/** Reads a packet; unknown fields are skipped, a malformed one throws `PacketError`. */
export function decodePacket(data: Uint8Array): Packet {
  const result = packet({});
  let offset = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      if (offset >= data.length) throw new PacketError('truncated varint');
      const byte = data[offset++];
      if (shift === 63n && byte > 1) throw new PacketError('varint overflow');
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new PacketError('varint overflow');
  };
  const take = (length: bigint): Uint8Array => {
    if (length > BigInt(data.length - offset)) throw new PacketError('truncated field');
    const end = offset + Number(length);
    const slice = data.slice(offset, end);
    offset = end;
    return slice;
  };
  const text = (bytes: Uint8Array) => {
    try {
      return fromUtf8.decode(bytes);
    } catch {
      throw new PacketError('invalid utf-8');
    }
  };
  while (offset < data.length) {
    const tag = varint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field <= 0 || field > 0x1fffffff) throw new PacketError('invalid field');
    switch (wire) {
      case 0: {
        const value = varint();
        if (field === 1) result.command = Number(BigInt.asUintN(53, value));
        else if (field === 2) result.businessType = Number(BigInt.asIntN(32, value));
        else if (field === 4) result.sid = Number(BigInt.asUintN(32, value));
        else if (field === 5) result.sentAt = Number(BigInt.asIntN(64, value));
        else if (field === 8) result.sequenceId = BigInt.asIntN(64, value).toString();
        break;
      }
      case 2: {
        const value = take(varint());
        if (field === 3) result.traceId = text(value);
        else if (field === 6) result.userId = text(value);
        else if (field === 7) result.deviceId = text(value);
        else if (field === 100) result.payload = value;
        break;
      }
      case 1:
        take(8n);
        break;
      case 5:
        take(4n);
        break;
      default:
        throw new PacketError('unsupported wire type');
    }
  }
  return result;
}

/** `LoginSuccess` payload (JSON). */
export type LoginSuccess = {
  connectionId: string;
  userId: string;
  deviceId: string;
  heartbeatSeconds: number;
};

export function decodeLoginSuccess(payload: Uint8Array): LoginSuccess {
  const raw = JSON.parse(text(payload)) as Record<string, unknown>;
  const field = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const interval = typeof raw.hb_interval === 'number' ? raw.hb_interval : 30;
  return {
    connectionId: field('conn_id'),
    userId: field('user_id'),
    deviceId: field('device_id'),
    heartbeatSeconds: Math.min(Math.max(interval, 5), 30),
  };
}

function text(bytes: Uint8Array): string {
  return fromUtf8.decode(bytes);
}

/** Standard base64 to bytes (the HTTP fallback's `payload`). */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
