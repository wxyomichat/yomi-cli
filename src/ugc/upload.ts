import type { Gateway } from '../core/api.js';
import { idOf } from '../core/json.js';
import type { LocalState } from '../core/state.js';
import { call, putObject, UgcFailure, wireIds } from './api.js';
import type { LocalImage } from './imageFile.js';

/**
 * A picture's upload and review, as the app prepares one: `npc/create_ugc_image_upload`
 * (purpose, MIME, byte length; the request ID from the receipt of the bytes' hash and purpose, so
 * a retry is the same upload), the PUT to the presigned URL, then `npc/review_ugc_image`. Only
 * PASSED with an https image URL can be submitted. The same bytes again reuse the upload and only
 * ask for the review again.
 */

export const Review = { unknown: 0, passed: 1, rejected: 2 } as const;

export type UploadPurpose = 'cover' | 'avatar' | 'reference';

export type ImageReceipt = { uploadId: string; status: number; url: string; reason: string };

function readUpload(value: unknown, purpose: UploadPurpose): ImageReceipt {
  const upload = (value ?? {}) as Record<string, unknown>;
  const id = idOf(upload.upload_id);
  if (!id || id === '0' || upload.purpose !== purpose)
    throw new UgcFailure('PROTOCOL', '服务端没有确认这次图片上传');
  const status = Number(upload.review_status);
  const url = typeof upload.image_url === 'string' ? upload.image_url : '';
  if (
    status === Review.passed &&
    !url.startsWith('https://') &&
    !url.startsWith('http://127.0.0.1')
  )
    throw new UgcFailure('PROTOCOL', '图片审核通过但没有地址');
  return {
    uploadId: id,
    status: [Review.unknown, Review.passed, Review.rejected].includes(status as 0)
      ? status
      : Review.unknown,
    url: status === Review.passed ? url : '',
    reason: typeof upload.reason_code === 'string' ? upload.reason_code : '',
  };
}

export class ImageRejected extends UgcFailure {
  constructor(label: string, reason: string) {
    super('IMAGE_REJECTED', `${label}没有通过审核${reason ? `（${reason}）` : ''}，请换一张`);
  }
}

export async function prepareImage(
  gateway: Gateway,
  state: LocalState,
  image: LocalImage,
  purpose: UploadPurpose,
  label: string,
  fetcher: typeof fetch = fetch,
): Promise<ImageReceipt> {
  const remembered = state.upload(image.sha256, purpose);
  if (remembered?.status === Review.passed && remembered.url)
    return {
      uploadId: remembered.uploadId,
      status: remembered.status,
      url: remembered.url,
      reason: '',
    };
  let current: ImageReceipt;
  if (remembered) current = { ...remembered, reason: '' };
  else {
    const body = { purpose, mime_type: image.mime, size_bytes: image.bytes.length };
    const key = `image:${image.sha256}:${purpose}`;
    const result = await call(
      gateway,
      'npc/create_ugc_image_upload',
      wireIds({ ...body, client_request_id: state.receipt('create_ugc_image_upload', key, body) }),
    );
    current = readUpload(result.upload, purpose);
    const url = typeof result.upload_url === 'string' ? result.upload_url : '';
    if (url) await putObject(url, image.bytes, image.mime, fetcher);
    state.setUpload(image.sha256, purpose, { ...current, at: Date.now() });
  }
  if (current.status === Review.rejected) throw new ImageRejected(label, current.reason);
  if (current.status !== Review.passed) {
    const result = await call(
      gateway,
      'npc/review_ugc_image',
      wireIds({ upload_id: current.uploadId }),
    );
    current = readUpload(result.upload, purpose);
    state.setUpload(image.sha256, purpose, { ...current, at: Date.now() });
  }
  if (current.status === Review.rejected) throw new ImageRejected(label, current.reason);
  if (current.status !== Review.passed || !current.url)
    throw new UgcFailure('REVIEW_PENDING', `${label}的审核还没有结果，请稍后重试`);
  return current;
}
