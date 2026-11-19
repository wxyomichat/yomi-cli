import { tr } from '../../core/i18n.js';
import type { ChannelStore, OutgoingFile } from './types.js';

/**
 * What a channel could not send when it was said (QQ out of its reply window with active
 * messages refused, WeChat outside its window or paused), kept for the owner's next message, which
 * opens a context to deliver it in. In the channel's store under `queue`, as `{ text, at }`: a
 * picture is kept in memory only, and written as its fallback text (the "it is in the Yomi app"
 * line), so after a restart the owner still learns there was one. It carries no account: the
 * relay state drops the queue when another Yomi account signs in (`RelayState.bindAccount`).
 */

export type QueuedItem = {
  /** Plain text; for a picture, what is said when the picture itself is gone. */
  text: string;
  at: number;
  /** In memory only. */
  photo?: OutgoingFile & { caption: string };
};

type StoredItem = { text: string; at: number };

const STORE_KEY = 'queue';

export type QueueOptions = {
  /** Items kept at most; beyond it the oldest go (20). */
  max?: number;
  /** Older items are not delivered (24 h). */
  maxAgeMs?: number;
  /** Pictures kept in memory at most; another one is kept as its fallback text only (3). */
  maxPhotos?: number;
};

export class OutOfContextQueue {
  private readonly max: number;
  private readonly maxAgeMs: number;
  private readonly maxPhotos: number;
  /** The pictures of queued items, matched to the stored items by time and text. */
  private photos: (StoredItem & { photo: OutgoingFile & { caption: string } })[] = [];

  constructor(
    private readonly store: ChannelStore,
    private readonly log: (line: string) => void,
    options: QueueOptions = {},
  ) {
    this.max = options.max ?? 20;
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.maxPhotos = options.maxPhotos ?? 3;
  }

  get size(): number {
    return this.stored().length;
  }

  /**
   * Keeps an item for later. A text equal to the last one is dropped (a notice said twice while
   * the owner was away), but never a picture: every picture has the same fallback text. Beyond
   * `max` the oldest goes.
   */
  push(item: QueuedItem): void {
    const items = this.stored();
    const last = items.at(-1);
    if (!item.photo && last && last.text === item.text && !this.photoOf(last, new Set())) return;
    const kept: StoredItem = { text: item.text, at: item.at };
    items.push(kept);
    if (item.photo && this.photos.length < this.maxPhotos)
      this.photos.push({ ...kept, photo: item.photo });
    let dropped = 0;
    while (items.length > this.max) {
      items.shift();
      dropped += 1;
    }
    if (dropped)
      this.log(
        tr(
          `离线消息太多，丢掉了最早的 ${dropped} 条`,
          `Too many messages waiting for the owner: dropped the oldest ${dropped}`,
          `Demasiados mensajes esperando al dueño: se descartaron los ${dropped} más antiguos`,
          `Mensagens demais esperando o dono: as ${dropped} mais antigas foram descartadas`,
        ),
      );
    this.save(items);
  }

  /** Everything still fresh, oldest first, with the pictures this process still has; then empty. */
  drain(now = Date.now()): QueuedItem[] {
    const items = this.stored();
    const used = new Set<number>();
    const fresh: QueuedItem[] = [];
    let stale = 0;
    for (const item of items) {
      const photo = this.photoOf(item, used);
      if (item.at < now - this.maxAgeMs) {
        stale += 1;
        continue;
      }
      fresh.push(photo ? { ...item, photo } : { ...item });
    }
    if (stale)
      this.log(
        tr(
          `有 ${stale} 条离线消息超过一天，没有再发`,
          `${stale} messages waiting for the owner were over a day old and were not sent`,
          `${stale} mensajes que esperaban al dueño tenían más de un día y no se enviaron`,
          `${stale} mensagens esperando o dono tinham mais de um dia e não foram enviadas`,
        ),
      );
    this.photos = [];
    if (items.length) this.save([]);
    return fresh;
  }

  /** The stored items; pictures whose item is gone (dropped, or the queue cleared) are let go. */
  private stored(): StoredItem[] {
    const value = this.store.get<StoredItem[]>(STORE_KEY);
    const items = Array.isArray(value)
      ? value
          .filter((item) => item && typeof item.text === 'string' && typeof item.at === 'number')
          .map((item) => ({ text: item.text, at: item.at }))
      : [];
    const used = new Set<number>();
    for (const item of items) this.photoOf(item, used);
    this.photos = this.photos.filter((_photo, index) => used.has(index));
    return items;
  }

  /** The first picture not yet `used` that belongs to `item`; marks it used. */
  private photoOf(item: StoredItem, used: Set<number>) {
    const index = this.photos.findIndex(
      (photo, at) => !used.has(at) && photo.at === item.at && photo.text === item.text,
    );
    if (index < 0) return undefined;
    used.add(index);
    return this.photos[index].photo;
  }

  private save(items: StoredItem[]) {
    this.store.set(STORE_KEY, items);
  }
}
