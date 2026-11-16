import { ApiError, type Gateway, NotSignedIn } from '../core/api.js';
import { loopbackHttpAllowed } from '../core/env.js';
import { tr } from '../core/i18n.js';
import { i64, type Json, object, optionalObject } from '../core/json.js';

/**
 * Create's Gateway calls as the app makes them: IDs as bare i64 on the NPC and preview routes, a
 * refusal as `UgcFailure` with the route's `ugc_error` / `voice_error`, else the `base_resp` code
 * as a string.
 */

export class UgcFailure extends Error {
  constructor(
    public readonly code: string,
    message = '',
    public readonly body: Json | null = null,
  ) {
    super(message || code);
    this.name = 'UgcFailure';
  }
}

const NUMERIC_IDS = new Set([
  'group_chat_id',
  'source_group_chat_id',
  'preview_group_chat_id',
  'npc_id',
  'source_npc_id',
  'author_id',
  'expected_version',
  'version',
  'upload_id',
  'asset_id',
  'preview_npc_id',
  'preview_cid',
  'draft_id',
  'cid',
]);

/** Writes the i64 fields of an NPC / preview body as bare numbers. */
export function wireIds(value: unknown, path: string[] = []): unknown {
  if (path.slice(-3).join('.') === 'content.features.draft_id') return value;
  if (Array.isArray(value)) return value.map((item) => wireIds(item, path));
  if (value && typeof value === 'object' && !(value instanceof Buffer)) {
    if (value.constructor?.name === 'I64') return value;
    const result: Json = {};
    for (const [key, item] of Object.entries(value)) result[key] = wireIds(item, [...path, key]);
    return result;
  }
  const key = path[path.length - 1] ?? '';
  const list = key === 'tag_ids' || key === 'characters';
  if ((NUMERIC_IDS.has(key) || list) && value !== undefined && value !== null) {
    const digits = String(value);
    if (!/^[1-9][0-9]{0,18}$/.test(digits) || BigInt(digits) > 9223372036854775807n)
      throw new UgcFailure(
        'INVALID_ARGUMENT',
        tr(
          `${key} 不是合法 ID：${digits}`,
          `${key} isn't a valid ID: ${digits}`,
          `${key} no es un ID válido: ${digits}`,
          `${key} não é um ID válido: ${digits}`,
        ),
      );
    return i64(digits);
  }
  return value;
}

function failureOf(error: unknown): unknown {
  if (error instanceof NotSignedIn || error instanceof UgcFailure) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (error instanceof ApiError) {
    const body = error.body;
    const named = body ? (body.ugc_error ?? body.voice_error) : undefined;
    const code =
      typeof named === 'string' && named
        ? named
        : error.code === ApiError.transport
          ? 'NETWORK'
          : String(error.code);
    return new UgcFailure(code, error.message, body);
  }
  return new UgcFailure('PROTOCOL', error instanceof Error ? error.message : '');
}

/** One Gateway call: the whole response, a named `ugc_error` turned into a failure. */
export async function call(
  gateway: Gateway,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Json> {
  let result: Json;
  try {
    result = await gateway.request(path, body, { signal, timeoutMs: 60_000 });
  } catch (error) {
    throw failureOf(error);
  }
  const named = result.ugc_error ?? result.voice_error;
  if (typeof named === 'string' && named) throw new UgcFailure(named, '', result);
  return result;
}

/** `wallet/get_wallet_page`: the live gem balance, web store type 3. */
export async function walletBalance(gateway: Gateway): Promise<number> {
  const result = await call(gateway, 'wallet/get_wallet_page', { store_type: 3 });
  const page = optionalObject(result.data ?? result);
  const total = optionalObject(page.balance).total_amount;
  const value = typeof total === 'number' ? total : Number(total);
  if (!Number.isFinite(value))
    throw new UgcFailure(
      'PROTOCOL',
      tr(
        '钱包回包没有余额',
        'The wallet response has no balance',
        'La respuesta de la billetera no tiene saldo',
        'A resposta da carteira não tem saldo',
      ),
    );
  return value;
}

/** A presigned PUT: no Gateway credentials, no redirects. */
export async function putObject(
  url: string,
  data: Buffer,
  mime: string,
  fetcher: typeof fetch = fetch,
  /** Headers the signature binds too (a private object: `x-oss-object-acl: private`). */
  extraHeaders: Record<string, string> = {},
) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !loopbackHttpAllowed(parsed))
    throw new UgcFailure(
      'PROTOCOL',
      tr(
        '上传地址不是 https',
        "The upload URL isn't https",
        'La URL de subida no es https',
        'A URL de envio não é https',
      ),
    );
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'PUT',
      headers: { ...extraHeaders, 'Content-Type': mime },
      body: data,
      redirect: 'error',
    });
  } catch {
    throw new UgcFailure(
      'UPLOAD_FAILED',
      tr(
        '图片上传失败',
        'Image upload failed',
        'Error al subir la imagen',
        'Falha no envio da imagem',
      ),
    );
  }
  if (response.status < 200 || response.status >= 300)
    throw new UgcFailure(
      'UPLOAD_FAILED',
      tr(
        `图片上传失败（HTTP ${response.status}）`,
        `Image upload failed (HTTP ${response.status})`,
        `Error al subir la imagen (HTTP ${response.status})`,
        `Falha no envio da imagem (HTTP ${response.status})`,
      ),
    );
}

/**
 * A presigned upload ticket that wants a form POST (`form_fields`): the fields sorted by name,
 * then the file last as `file`. No Gateway credentials, no redirects.
 */
export async function postForm(
  url: string,
  fields: Record<string, string>,
  data: Buffer,
  mime: string,
  fetcher: typeof fetch = fetch,
) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !loopbackHttpAllowed(parsed))
    throw new UgcFailure(
      'PROTOCOL',
      tr(
        '上传地址不是 https',
        "The upload URL isn't https",
        'La URL de subida no es https',
        'A URL de envio não é https',
      ),
    );
  const form = new FormData();
  for (const key of Object.keys(fields).sort()) form.append(key, fields[key]);
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), 'image');
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', body: form, redirect: 'error' });
  } catch {
    throw new UgcFailure(
      'UPLOAD_FAILED',
      tr(
        '图片上传失败',
        'Image upload failed',
        'Error al subir la imagen',
        'Falha no envio da imagem',
      ),
    );
  }
  if (response.status < 200 || response.status >= 300)
    throw new UgcFailure(
      'UPLOAD_FAILED',
      tr(
        `图片上传失败（HTTP ${response.status}）`,
        `Image upload failed (HTTP ${response.status})`,
        `Error al subir la imagen (HTTP ${response.status})`,
        `Falha no envio da imagem (HTTP ${response.status})`,
      ),
    );
}

export { object };
