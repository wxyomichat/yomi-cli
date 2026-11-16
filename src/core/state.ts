import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { configDir, readJsonFile, writeJsonFile } from './files.js';

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

export class LocalState {
  private data: StateFile;
  readonly path: string;

  constructor(scope: string, userId: string, dir = configDir()) {
    const name = sha256(scope).slice(0, 16) + '-' + userId.replace(/[^0-9]/g, '');
    this.path = join(dir, 'state', name + '.json');
    const stored = readJsonFile<StateFile>(this.path);
    this.data = stored && stored.version === 1 ? { ...empty(), ...stored } : empty();
  }

  private save() {
    writeJsonFile(this.path, this.data);
  }

  /** A stable request ID for `method` + `key` + the body's digest. */
  receipt(method: string, key: string, body: unknown): string {
    const name = `${method}:${key}:${sha256(JSON.stringify(body))}`;
    const existing = this.data.requests[name];
    if (existing) return existing;
    const id = randomUUID();
    this.data.requests[name] = id;
    this.save();
    return id;
  }

  /** Forgets a receipt, so the next identical request is a new one (a refused request). */
  dropReceipt(method: string, key: string, body: unknown) {
    delete this.data.requests[`${method}:${key}:${sha256(JSON.stringify(body))}`];
    this.save();
  }

  upload(hash: string, purpose: string): UploadRecord | null {
    return this.data.uploads[`${hash}:${purpose}`] ?? null;
  }

  setUpload(hash: string, purpose: string, record: UploadRecord) {
    this.data.uploads[`${hash}:${purpose}`] = record;
    this.save();
  }

  /** The local draft of a character file (by its path), created on first use. */
  draft(source: string): DraftRecord {
    const key = source || 'flags';
    let record = this.data.drafts[key];
    if (!record) {
      record = {
        draftId: 'draft_' + randomBytes(16).toString('hex'),
        serverDraftId: '',
        mutationRevision: '0',
        previewNpcId: '',
        previewCounter: '0',
      };
      this.data.drafts[key] = record;
      this.save();
    }
    return record;
  }

  updateDraft(source: string, patch: Partial<DraftRecord>) {
    const key = source || 'flags';
    this.data.drafts[key] = { ...this.draft(source), ...patch };
    this.save();
  }

  /** Starts a fresh local draft for `source` (new server draft and free messages on next preview). */
  resetDraft(source: string) {
    delete this.data.drafts[source || 'flags'];
    this.save();
  }

  /**
   * The ordered preview entry ID, as the Yomi web client makes it:
   * `pv2_<first 32 hex of SHA-256(draftId)>_<counter>_<32 hex>`, the counter saved before it is
   * used. It starts from the clock (`max(saved + 1, now)`), so a lost state still counts above
   * what the server has seen.
   */
  nextPreviewId(source: string, now = Date.now()): string {
    const record = this.draft(source);
    const saved = BigInt(record.previewCounter || '0');
    const counter = saved + 1n > BigInt(now) ? saved + 1n : BigInt(now);
    this.updateDraft(source, { previewCounter: counter.toString() });
    const stream = sha256(record.draftId).slice(0, 32);
    return `pv2_${stream}_${counter.toString()}_${randomBytes(16).toString('hex')}`;
  }

  submission(key: string): SubmissionRecord | null {
    return this.data.submissions[key] ?? null;
  }

  setSubmission(key: string, record: SubmissionRecord | null) {
    if (record) this.data.submissions[key] = record;
    else delete this.data.submissions[key];
    this.save();
  }
}
