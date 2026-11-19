import { pollMessages } from '../../chat/api.js';
import { type Gateway, NotSignedIn } from '../../core/api.js';
import { tr } from '../../core/i18n.js';
import { ImConnection, type SocketFactory } from '../../im/connection.js';
import { BusinessType, Command } from '../../im/packet.js';
import { type AsideEvent, ConversationPurpose, type StreamEvent } from '../../im/thrift.js';
import type { SessionGate } from './session.js';

/**
 * The one long connection of a Yomi sign-in, whatever bots relay through it: ordinary chat
 * (streams and asides), one device id, never giving up, reconnecting at once after the machine
 * wakes. On every connect what arrived while no socket was open is read (`poll_message`) and
 * passed on in order; after a reconnect each bot then reads back a reply that still did not come.
 *
 * Every event goes to every subscriber: each bot keeps only its own (its reply's `stream_id`, its
 * character, its image task). One subscriber that throws is its own failure; the others still get
 * the event. A sign-out (`SessionGate`) closes the connection and a sign-in back opens it again.
 */

export interface FeedSubscriber {
  stream(event: StreamEvent): void;
  aside(event: AsideEvent): void;
  /** Reconnected, and what came meanwhile passed on: a reply still missing is read back. */
  reconnected(): Promise<void> | void;
  /** What one of the calls above threw. */
  failed(error: unknown): void;
}

export type ImFeedOptions = {
  log: (line: string) => void;
  createSocket?: SocketFactory;
  /** What reading the missed packets threw outside any subscriber. */
  onError?: (error: unknown) => void;
};

export class ImFeed {
  private connection: ImConnection | null = null;
  private readonly subscribers = new Set<FeedSubscriber>();
  private readonly leaveSession: () => void;

  constructor(
    private readonly gateway: Gateway,
    private readonly session: SessionGate,
    private readonly options: ImFeedOptions,
  ) {
    // Subscribed first: the connection closes before any bot is told of a sign-out, and is open
    // again before any is told the sign-in came back.
    this.leaveSession = session.subscribe({
      signedOut: () => this.stop(),
      resumed: () => this.start(),
      otherAccount: () => undefined,
      failed: (error) => this.options.onError?.(error),
    });
  }

  /** The returned function unsubscribes. */
  subscribe(subscriber: FeedSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Connects (again); nothing without a sign-in. */
  start() {
    const credential = this.gateway.credential;
    if (!credential) return;
    this.connection?.stop();
    const connection = new ImConnection({
      url: () => {
        if (this.gateway.reloadCredential() === 'otherAccount') this.session.otherAccount();
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
        this.drain(connection).catch((error) => this.options.onError?.(error));
      },
      onState: (state) => {
        if (state === 'retrying' && connection.reconnects % 10 === 1)
          this.options.log(
            tr(
              'Yomi 长连接断开，正在重连',
              'Yomi connection dropped, reconnecting',
              'Se cortó la conexión con Yomi, reconectando',
              'A conexão com o Yomi caiu, reconectando',
            ),
          );
      },
    });
    connection.on((event) => {
      if (event.kind !== 'stream' && event.kind !== 'aside') return;
      for (const subscriber of [...this.subscribers]) {
        try {
          if (event.kind === 'stream') subscriber.stream(event.event);
          else subscriber.aside(event.event);
        } catch (error) {
          subscriber.failed(error);
        }
      }
    });
    this.connection = connection;
    connection.start();
  }

  stop() {
    this.connection?.stop();
  }

  /** Stops, and no longer follows the sign-in. */
  close() {
    this.stop();
    this.leaveSession();
  }

  /** What arrived while no socket was open (`poll_message`), then a missed reply from history. */
  private async drain(connection: ImConnection) {
    for (let page = 0; page < 10; page++) {
      let result;
      try {
        result = await pollMessages(this.gateway, 50);
      } catch (error) {
        if (error instanceof NotSignedIn) await this.session.report();
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
    if (connection.reconnects === 0) return;
    await Promise.all(
      [...this.subscribers].map(async (subscriber) => {
        try {
          await subscriber.reconnected();
        } catch (error) {
          subscriber.failed(error);
        }
      }),
    );
  }
}
