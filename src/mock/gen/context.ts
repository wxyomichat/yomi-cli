import type { Json } from '../../core/json.js';
import type { StreamEvent } from '../../im/thrift.js';

/**
 * What the mock's generation routes (character images, character video, chat images, persona
 * avatars) get from the mock gateway, so each lives in its own module: the shared state, the
 * answer helpers, presigned uploads (`/blob/<key>`, recorded with their method and headers) and
 * downloadable results (`/media/<key>`), pushes on the conversation stream, timers that `close()`
 * clears, and a store per module for whatever else it keeps.
 */

export type MockSession = { authToken: string; refreshToken: string; deviceId: string };

export type MockRoute = (body: Json, user: MockSession | null) => unknown;
export type MockRoutes = Record<string, MockRoute>;

/** An upload received at `/blob/<key>` (a PUT, or a form POST). */
export type MockBlob = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  contentType: string;
  bytes: Buffer;
  /** Form fields of a multipart POST (the file is `bytes`). */
  fields: Record<string, string>;
};

export type MockGenContext = {
  /** The account's gems (shared with chat and preview). */
  gems(): number;
  setGems(value: number): void;
  ok(data?: Json): Json;
  fail(code: number, message: string, extra?: Json): Json;
  /** A fresh 19-digit id. */
  nextId(): string;
  /** The mock's origin, e.g. http://127.0.0.1:1234. */
  origin(): string;
  /** A presigned-style upload address; what arrives is kept in `blobs`. */
  blobUrl(key: string): string;
  blobs: Map<string, MockBlob>;
  /** Serves `bytes` at `/media/<key>` and returns its address. */
  serveMedia(key: string, bytes: Buffer, mime: string): string;
  /** The published character with this id, or null. */
  character(npcId: string): { npcId: string; name: string } | null;
  /** The ordinary chat with a character (created on first use). */
  chat(npcId: string): { cid: string; npcId: string; messages: Json[] };
  /** Pushes a StreamEvent on the conversation stream (business type 1). */
  pushChat(event: StreamEvent): void;
  /** Runs `run` after `ms` (cleared by close()). */
  later(ms: number, run: () => void): void;
  /** Per-module state, by module name. */
  store: Record<string, unknown>;
};

export { solidPngBytes } from './png.js';
