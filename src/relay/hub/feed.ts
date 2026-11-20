import { pollMessages } from '../../chat/api.js';
import { type Gateway, NotSignedIn } from '../../core/api.js';
import { tr } from '../../core/i18n.js';
import { ImConnection, type SocketFactory } from '../../im/connection.js';
import { BusinessType, Command } from '../../im/packet.js';
import {
  type AsideEvent,
  ConversationPurpose,
  type StreamEvent,
  StreamEventType,
} from '../../im/thrift.js';
import { DuplicateCharacter } from '../registry.js';
import type { SessionGate } from './session.js';

/**
 * The one long connection of a Yomi sign-in, whatever bots relay through it: ordinary chat
 * (streams and asides), one device id, never giving up, reconnecting at once after the machine
 * wakes. On every connect what arrived while no socket was open is read (`poll_message`) and
 * passed on in order; after a reconnect each bot then reads back a reply that still did not come.
 *
 * Routing: a bot bound to a character subscribes with it (`FeedRoute`), and the events of that
 * character (its `entity_id`) go to that bot alone; a character goes with one bot only, so a
 * second bot routed to it is refused (`DuplicateCharacter`). A `MessagePersisted` of a
 * conversation an image task was asked in (`routeCid`) goes to that task's bot first, so a
 * picture still reaches the bot that asked for it. The events of any other character go to the
 * subscribers without a route (a relay on its own takes every event), and none of them is
 * dropped there: each such bot keeps only its own (its reply's `stream_id`, its character, its
 * image task). One subscriber that throws is its own failure; the others still get the event. A
 * sign-out (`SessionGate`) closes the connection and a sign-in back opens it again.
 */

export interface FeedSubscriber {
  stream(event: StreamEvent): void;
  aside(event: AsideEvent): void;
  /** Reconnected, and what came meanwhile passed on: a reply still missing is read back. */
  reconnected(): Promise<void> | void;
  /** What one of the calls above threw. */
  failed(error: unknown): void;
}

/** Which events a subscriber takes: its bot's character's, or (`npcId` null) none by character. */
export type FeedRoute = { bot: string; npcId: string | null };

export type ImFeedOptions = {
  log: (line: string) => void;
  createSocket?: SocketFactory;
  /** What reading the missed packets threw outside any subscriber. */
  onError?: (error: unknown) => void;
};

export class ImFeed {
  private connection: ImConnection | null = null;
  /** Every subscriber, with its route (null: every event no route claims). */
  private readonly subscribers = new Map<FeedSubscriber, FeedRoute | null>();
  /** Routed subscribers by character. */
  private readonly byNpc = new Map<string, { bot: string; subscriber: FeedSubscriber }>();
  /** An image task's conversation → the subscriber that asked for it. */
  private readonly byCid = new Map<string, FeedSubscriber>();
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

  /**
   * The returned function unsubscribes. With `route` only that bot's character's events come (and
   * its image tasks'); a character another subscriber is routed to already is refused
   * (`DuplicateCharacter`, naming that bot).
   */
  subscribe(subscriber: FeedSubscriber, route?: FeedRoute): () => void {
    const npcId = route?.npcId;
    if (npcId) {
      const holder = this.byNpc.get(npcId);
      if (holder && holder.subscriber !== subscriber)
        throw new DuplicateCharacter(npcId, holder.bot);
      this.byNpc.set(npcId, { bot: route.bot, subscriber });
    }
    this.subscribers.set(subscriber, route ?? null);
    return () => {
      this.subscribers.delete(subscriber);
      if (npcId && this.byNpc.get(npcId)?.subscriber === subscriber) this.byNpc.delete(npcId);
      for (const [cid, owner] of this.byCid) if (owner === subscriber) this.byCid.delete(cid);
    };
  }

  /**
   * The persisted messages of conversation `cid` go to `subscriber` first (an image it asked for
   * there), until the returned function lets go.
   */
  routeCid(cid: string, subscriber: FeedSubscriber): () => void {
    if (!cid) return () => undefined;
    this.byCid.set(cid, subscriber);
    return () => {
      if (this.byCid.get(cid) === subscriber) this.byCid.delete(cid);
    };
  }

  /** Who gets an event of character `npcId` (`cid`: a persisted message's conversation). */
  private targets(npcId: string, cid: string): FeedSubscriber[] {
    const byCid = cid ? this.byCid.get(cid) : undefined;
    if (byCid && this.subscribers.has(byCid)) return [byCid];
    const routed = this.byNpc.get(npcId);
    if (routed) return [routed.subscriber];
    return [...this.subscribers].filter(([, route]) => !route).map(([subscriber]) => subscriber);
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
      const persisted =
        event.kind === 'stream' && event.event.type === StreamEventType.messagePersisted;
      const targets = this.targets(event.event.entityId, persisted ? event.event.cid : '');
      for (const subscriber of targets) {
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
      [...this.subscribers.keys()].map(async (subscriber) => {
        try {
          await subscriber.reconnected();
        } catch (error) {
          subscriber.failed(error);
        }
      }),
    );
  }
}
