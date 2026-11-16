import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { configDir, readJsonFile, writeJsonFile } from './files.js';
import { withFileLockSync } from './lock.js';

/**
 * What the CLI remembers per account and environment, in `state/<scope>.json` (0600), as the web
 * keeps its records in IndexedDB scoped to mode, lane and account: request
 * receipts (a retried request keeps its `client_request_id`), image uploads by content, local
 * drafts with their server draft and preview counter, and finished submissions. No tokens.
 */

export type UploadRecord = { uploadId: string; status: number; url: string; at: number };
export type DraftRecord = {
  /** `draft_` + 32 hex: the local identity, as the app makes it. */
  draftId: string;
  serverDraftId: string;
  mutationRevision: string;
  previewNpcId: string;
  /** The last preview counter taken (decimal), see `nextPreviewId`. */
  previewCounter: string;
};
export type SubmissionRecord = {
  npcId: string;
  version: string;
  reviewState: number;
  at: number;
  /** The frozen request (method + body) while its answer is unknown. */
  pending?: { method: string; body: string; requestId: string } | null;
};

type StateFile = {
  version: 1;
  /** Records a feature keeps for itself (generation batches, video tasks…), by kind and key. */
  records?: Record<string, Record<string, unknown>>;
  uploads: Record<string, UploadRecord>;
  requests: Record<string, string>;
  drafts: Record<string, DraftRecord>;
  submissions: Record<string, SubmissionRecord>;
};

const empty = (): StateFile => ({
  version: 1,
  uploads: {},
  requests: {},
  drafts: {},
  submissions: {},
});

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Records kept per kind; old finished ones go first, and only far beyond any real use. */
const RECORDS_PER_KIND = 2000;

export class LocalState {
  readonly path: string;

  constructor(scope: string, userId: string, dir = configDir()) {
    const name = sha256(scope).slice(0, 16) + '-' + userId.replace(/[^0-9]/g, '');
    this.path = join(dir, 'state', name + '.json');
  }

  /**
   * The file as it is now. Every read goes to the disk: another `yomi` process (a relay, a second
   * terminal) may have written since, and a stale copy written back would erase its records.
   */
  private read(): StateFile {
    const stored = readJsonFile<StateFile>(this.path);
    return stored && stored.version === 1 ? { ...empty(), ...stored } : empty();
  }

  /** One change under the state file's lock: read the latest file, change it, write it back. */
  private mutate<T>(change: (data: StateFile) => T): T {
    return withFileLockSync(`${this.path}.lock`, () => {
      const data = this.read();
      const result = change(data);
      writeJsonFile(this.path, data);
      return result;
    });
  }

  /** A stable request ID for `method` + `key` + the body's digest. */
  receipt(method: string, key: string, body: unknown): string {
    const name = `${method}:${key}:${sha256(JSON.stringify(body))}`;
    const existing = this.read().requests[name];
    if (existing) return existing;
    return this.mutate((data) => (data.requests[name] ??= randomUUID()));
  }

  /** Forgets a receipt, so the next identical request is a new one (a refused request). */
  dropReceipt(method: string, key: string, body: unknown) {
    this.mutate((data) => {
      delete data.requests[`${method}:${key}:${sha256(JSON.stringify(body))}`];
    });
  }

  upload(hash: string, purpose: string): UploadRecord | null {
    return this.read().uploads[`${hash}:${purpose}`] ?? null;
  }

  setUpload(hash: string, purpose: string, record: UploadRecord) {
    this.mutate((data) => {
      data.uploads[`${hash}:${purpose}`] = record;
    });
  }

  /** The local draft of a character file (by its path), created on first use. */
  draft(source: string): DraftRecord {
    const key = source || 'flags';
    const existing = this.read().drafts[key];
    if (existing) return existing;
    return this.mutate(
      (data) =>
        (data.drafts[key] ??= {
          draftId: 'draft_' + randomBytes(16).toString('hex'),
          serverDraftId: '',
          mutationRevision: '0',
          previewNpcId: '',
          previewCounter: '0',
        }),
    );
  }

  updateDraft(source: string, patch: Partial<DraftRecord>) {
    const current = this.draft(source);
    const key = source || 'flags';
    this.mutate((data) => {
      data.drafts[key] = { ...current, ...data.drafts[key], ...patch };
    });
  }

  /** Starts a fresh local draft for `source` (new server draft and free messages on next preview). */
  resetDraft(source: string) {
    this.mutate((data) => {
      delete data.drafts[source || 'flags'];
    });
  }

  /**
   * The ordered preview entry ID, as the Yomi web client makes it:
   * `pv2_<first 32 hex of SHA-256(draftId)>_<counter>_<32 hex>`, the counter saved before it is
   * used. It starts from the clock (`max(saved + 1, now)`), so a lost state still counts above
   * what the server has seen.
   */
  nextPreviewId(source: string, now = Date.now()): string {
    const record = this.draft(source);
    const key = source || 'flags';
    const counter = this.mutate((data) => {
      const draft = { ...record, ...data.drafts[key] };
      const saved = BigInt(draft.previewCounter || '0');
      const next = saved + 1n > BigInt(now) ? saved + 1n : BigInt(now);
      data.drafts[key] = { ...draft, previewCounter: next.toString() };
      return next;
    });
    const stream = sha256(record.draftId).slice(0, 32);
    return `pv2_${stream}_${counter.toString()}_${randomBytes(16).toString('hex')}`;
  }

  /** A record of `kind` (one feature's own bookkeeping), null when there is none. */
  record<T>(kind: string, key: string): T | null {
    return (this.read().records?.[kind]?.[key] as T | undefined) ?? null;
  }

  /**
   * Saves (or, with null, removes) a record of `kind`. Only the oldest go once a kind holds
   * 2000, so a request whose outcome is unknown is never dropped in practice.
   */
  setRecord<T>(kind: string, key: string, value: T | null) {
    this.mutate((data) => {
      const records = (data.records ??= {});
      const bucket = (records[kind] ??= {});
      delete bucket[key];
      if (value !== null) bucket[key] = value;
      const keys = Object.keys(bucket);
      for (const old of keys.slice(0, Math.max(0, keys.length - RECORDS_PER_KIND)))
        delete bucket[old];
    });
  }

  /**
   * Reads a record, changes it and saves it in one locked step, so a change made by another
   * process in between is never lost (null removes it). Returns what was saved.
   */
  updateRecord<T>(kind: string, key: string, change: (current: T | null) => T | null): T | null {
    return this.mutate((data) => {
      const bucket = ((data.records ??= {})[kind] ??= {});
      const next = change((bucket[key] as T | undefined) ?? null);
      delete bucket[key];
      if (next !== null) bucket[key] = next;
      const keys = Object.keys(bucket);
      for (const old of keys.slice(0, Math.max(0, keys.length - RECORDS_PER_KIND)))
        delete bucket[old];
      return next;
    });
  }

  /**
   * One process at a time: returns the record of `kind` that `find` picks, or saves the one `make`
   * builds, in one locked step. Two processes making the same request at once thus end up with one
   * record (and one request id) instead of two.
   */
  claimRecord<T>(
    kind: string,
    find: (records: [string, T][]) => [string, T] | null,
    make: () => [string, T],
  ): { key: string; value: T; existing: boolean } {
    return this.mutate((data) => {
      const bucket = ((data.records ??= {})[kind] ??= {});
      const found = find(Object.entries(bucket) as [string, T][]);
      if (found) return { key: found[0], value: found[1], existing: true };
      const [key, value] = make();
      bucket[key] = value;
      return { key, value, existing: false };
    });
  }

  /** Every record of `kind`, oldest first. */
  records<T>(kind: string): [string, T][] {
    return Object.entries(this.read().records?.[kind] ?? {}) as [string, T][];
  }

  submission(key: string): SubmissionRecord | null {
    return this.read().submissions[key] ?? null;
  }

  setSubmission(key: string, record: SubmissionRecord | null) {
    this.mutate((data) => {
      if (record) data.submissions[key] = record;
      else delete data.submissions[key];
    });
  }
}
