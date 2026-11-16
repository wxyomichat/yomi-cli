import { networkInterfaces } from 'node:os';

import {
  BusinessType,
  Command,
  decodeLoginSuccess,
  decodePacket,
  encodePacket,
  type Packet,
} from './packet.js';
import {
  type AsideEvent,
  type ChatLineChanged,
  ConversationPurpose,
  decodeAsideEvent,
  decodeChatLineChanged,
  decodeStreamEvent,
  type StreamEvent,
  validateStreamEvent,
} from './thrift.js';

/**
 * The long connection, a lean port of the Yomi web client's: `LoginSuccess` must name this
 * session, a `Ping` packet every `hb_interval` seconds, an ACK for every business packet, each
 * `seq_id` delivered once (the last 1024 remembered, as the web), and reconnects with backoff. A
 * client chooses which business types it reads; everything else is acknowledged and dropped. The
 * preview (`PreviewConnection`) reads only its own stream (type 5, purpose UgcPreview) and gives
 * up after 6 tries; `yomi relay` reads ordinary chat (types 1 and 4) and never gives up,
 * reconnecting at once after the machine wakes.
 */

export type ImEvent =
  | { kind: 'stream'; event: StreamEvent }
  | { kind: 'aside'; event: AsideEvent }
  | { kind: 'chatLine'; event: ChatLineChanged };

export type ImListener = (event: ImEvent) => void;
export type ConnectionState = 'connecting' | 'connected' | 'retrying' | 'stopped';
export type SocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

export type ImConnectionOptions = {
  url: () => string;
  headers: () => Record<string, string>;
  userId: string;
  deviceId: string;
  /** Business types passed on (`BusinessType`). */
  businessTypes: readonly number[];
  /** Stream events must carry this purpose (`ConversationPurpose`); others are dropped. */
  purpose: number;
  /** Tries before giving up; default unlimited. */
  maxRetries?: number;
  maxBackoffMs?: number;
  createSocket?: SocketFactory;
  onState?: (state: ConnectionState) => void;
  /** After every (re)connect: the place to read what was missed (`poll_message`). */
  onConnected?: () => void;
  /**
   * Long-running clients: reconnect at once after the machine slept (the clock jumped) or the
   * network changed (another address: the old socket may be half-open and never close).
   */
  watchWake?: boolean;
  /** The network's addresses (tests replace it). */
  networkFingerprint?: () => string;
};

const OPEN_DEADLINE_MS = 20_000;

/** The machine's external addresses, sorted: changes when Wi-Fi, VPN or cable changes. */
export function networkFingerprint(): string {
  try {
    return Object.values(networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal)
      .map((address) => address!.address)
      .sort()
      .join(',');
  } catch {
    return '';
  }
}
const SEEN_LIMIT = 1024;
const WAKE_TICK_MS = 5_000;
/** A tick this late means the process (the machine) was asleep. */
const WAKE_GAP_MS = 20_000;

export class ImConnection {
  private socket: WebSocket | null = null;
  private listeners = new Set<ImListener>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private retries = 0;
  private stopped = false;
  private generation = 0;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private readyWaiters: (() => void)[] = [];
  state: ConnectionState = 'connecting';
  /** Why the last packet was dropped (diagnostics; payloads are never kept). */
  lastDropped = '';
  /** Reconnects so far (diagnostics). */
  reconnects = 0;

  constructor(private readonly options: ImConnectionOptions) {}

  on(listener: ImListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start() {
    this.stopped = false;
    if (this.options.watchWake && !this.wakeTimer) {
      this.lastTick = Date.now();
      const fingerprint = this.options.networkFingerprint ?? networkFingerprint;
      let network = fingerprint();
      this.wakeTimer = setInterval(() => {
        const now = Date.now();
        const gap = now - this.lastTick;
        this.lastTick = now;
        const current = fingerprint();
        const moved = current !== network;
        network = current;
        if (gap > WAKE_GAP_MS || moved) this.reconnectNow();
      }, WAKE_TICK_MS);
      this.wakeTimer.unref?.();
    }
    this.connect();
  }

  /** Resolves once connected, or after `timeoutMs` (false). */
  ready(timeoutMs: number): Promise<boolean> {
    if (this.state === 'connected') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Drops the current socket and connects again without waiting (wake, network back). */
  reconnectNow() {
    if (this.stopped) return;
    this.retries = 0;
    this.reconnects += 1;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = null;
    this.teardown();
    this.setState('stopped');
  }

  /**
   * A packet read another way (`poll_message`'s backlog): the same de-duplication and dispatch as
   * a pushed one, without an ACK.
   */
  ingest(packet: Packet) {
    this.dispatch(packet);
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.options.onState?.(state);
    if (state === 'connected') {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      waiters.forEach((waiter) => waiter());
    }
  }

  private teardown() {
    this.generation += 1;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.deadline) clearTimeout(this.deadline);
    this.heartbeat = this.retryTimer = this.deadline = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  private connect() {
    this.teardown();
    if (this.stopped) return;
    const attempt = this.generation;
    const create: SocketFactory =
      this.options.createSocket ??
      ((url, headers) => new WebSocket(url, { headers } as unknown as string[]));
    let socket: WebSocket;
    try {
      socket = create(this.options.url(), this.options.headers());
    } catch {
      this.failed(attempt);
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setState('connecting');
    this.deadline = setTimeout(() => this.failed(attempt), OPEN_DEADLINE_MS);
    // As the web: open is connected; `LoginSuccess`, when it comes, must name this session.
    socket.onopen = () => {
      if (attempt !== this.generation) return;
      if (this.deadline) clearTimeout(this.deadline);
      this.deadline = null;
      this.startHeartbeat(30);
      this.setState('connected');
      this.options.onConnected?.();
    };
    socket.onmessage = (event) => {
      if (attempt !== this.generation) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        this.receive(new Uint8Array(event.data), attempt);
      } catch {
        this.failed(attempt);
      }
    };
    socket.onclose = () => this.failed(attempt);
    socket.onerror = () => this.failed(attempt);
  }

  private startHeartbeat(seconds: number) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      try {
        this.socket?.send(encodePacket({ command: Command.ping }));
      } catch {
        // The close handler reconnects.
      }
    }, seconds * 1000);
    this.heartbeat.unref?.();
  }

  private receive(bytes: Uint8Array, attempt: number) {
    const packet = decodePacket(bytes);
    if (packet.command === Command.loginSuccess) {
      const login = decodeLoginSuccess(packet.payload);
      if (login.userId !== this.options.userId || login.deviceId !== this.options.deviceId)
        throw new Error('LoginSuccess for another account');
      this.retries = 0;
      this.startHeartbeat(login.heartbeatSeconds);
      return;
    }
    if (packet.command !== Command.business && packet.command !== Command.businessStreaming) return;
    if (attempt === this.generation && this.socket)
      this.socket.send(encodePacket({ command: Command.ack, sid: packet.sid }));
    this.dispatch(packet);
  }

  /** True the first time a sequence id is seen; the last `SEEN_LIMIT` are remembered. */
  private firstSight(sequenceId: string): boolean {
    if (sequenceId === '0') return true;
    if (this.seen.has(sequenceId)) return false;
    this.seen.add(sequenceId);
    this.seenOrder.push(sequenceId);
    if (this.seenOrder.length > SEEN_LIMIT) this.seen.delete(this.seenOrder.shift() as string);
    return true;
  }

  private dispatch(packet: Packet) {
    if (!this.firstSight(packet.sequenceId)) return;
    if (!this.options.businessTypes.includes(packet.businessType)) return;
    let event: ImEvent;
    try {
      if (
        packet.businessType === BusinessType.conversationStream ||
        packet.businessType === BusinessType.ugcPreviewStream
      ) {
        const stream = decodeStreamEvent(packet.payload);
        validateStreamEvent(stream);
        if ((stream.purpose ?? ConversationPurpose.normal) !== this.options.purpose) {
          this.lastDropped = 'purpose';
          return;
        }
        event = { kind: 'stream', event: stream };
      } else if (packet.businessType === BusinessType.conversationAside)
        event = { kind: 'aside', event: decodeAsideEvent(packet.payload) };
      else if (packet.businessType === BusinessType.chatLineProgress)
        event = { kind: 'chatLine', event: decodeChatLineChanged(packet.payload) };
      else return;
    } catch (error) {
      this.lastDropped = error instanceof Error ? error.message : 'invalid payload';
      return;
    }
    this.listeners.forEach((listener) => listener(event));
  }

  private failed(attempt: number) {
    if (attempt !== this.generation || this.stopped) return;
    this.teardown();
    const limit = this.options.maxRetries ?? Infinity;
    if (this.retries >= limit) {
      this.setState('stopped');
      return;
    }
    const delay = Math.min(
      this.options.maxBackoffMs ?? 60_000,
      1000 * 2 ** Math.min(this.retries, 16),
    );
    this.retries += 1;
    this.reconnects += 1;
    this.setState('retrying');
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
  }
}

export type PreviewStreamListener = (event: StreamEvent) => void;

export type PreviewConnectionOptions = Omit<
  ImConnectionOptions,
  'businessTypes' | 'purpose' | 'maxRetries' | 'watchWake'
>;

/** The creator's preview chat: its own stream only, 6 tries at most. */
export class PreviewConnection extends ImConnection {
  constructor(options: PreviewConnectionOptions) {
    super({
      ...options,
      businessTypes: [BusinessType.ugcPreviewStream],
      purpose: ConversationPurpose.ugcPreview,
      maxRetries: 6,
    });
  }

  subscribe(listener: PreviewStreamListener) {
    return this.on((event) => {
      if (event.kind === 'stream') listener(event.event);
    });
  }
}
