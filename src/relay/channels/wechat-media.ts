import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { OutgoingFile } from './types.js';
import type { WechatApi, WechatItem } from './wechat-api.js';

/**
 * Pictures for WeChat ClawBot (design §10.4), the way the plugin uploads them: a fresh 16-byte
 * key, the file encrypted with AES-128-ECB and PKCS#7 padding, `getuploadurl` told the plain and
 * the encrypted sizes and the plain MD5, the ciphertext POSTed to the CDN, and the CDN's
 * `x-encrypted-param` named in an image message with the key (base64 of its hex). The key never
 * reaches a log; it lives as long as the upload.
 */

/** AES-128-ECB with PKCS#7 padding (Node's default padding). */
export function encryptAesEcb(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

export function decryptAesEcb(cipher: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

/** The ciphertext's size: PKCS#7 always adds 1 to 16 bytes. */
export const aesEcbPaddedSize = (size: number) => (Math.floor(size / 16) + 1) * 16;

/** A picture on the CDN, ready to be named in a message. */
export type UploadedImage = {
  /** The CDN's `x-encrypted-param` for it. */
  encryptQueryParam: string;
  /** The AES key as 32 hex characters. */
  aesKeyHex: string;
  /** The encrypted size (the image item's `mid_size`). */
  cipherSize: number;
};

/**
 * Encrypts and uploads `file` for `toUserId`. `getuploadurl` and the CDN both go to hosts the
 * API checked; the CDN is tried up to three times (a 4xx ends it).
 */
export async function uploadImage(
  api: WechatApi,
  toUserId: string,
  file: OutgoingFile,
  signal?: AbortSignal,
): Promise<UploadedImage> {
  const key = randomBytes(16);
  const filekey = randomBytes(16).toString('hex');
  const ciphertext = encryptAesEcb(file.bytes, key);
  const answer = await api.getUploadUrl(
    {
      filekey,
      media_type: 1,
      to_user_id: toUserId,
      rawsize: file.bytes.length,
      rawfilemd5: createHash('md5').update(file.bytes).digest('hex'),
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: key.toString('hex'),
    },
    signal,
  );
  const url = api.uploadUrl(answer, filekey);
  const encryptQueryParam = await api.uploadToCdn(url, ciphertext, signal);
  return { encryptQueryParam, aesKeyHex: key.toString('hex'), cipherSize: ciphertext.length };
}

/** The `item_list` entry of an uploaded picture, as the plugin writes it. */
export function imageItem(image: UploadedImage): WechatItem {
  return {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: image.encryptQueryParam,
        aes_key: Buffer.from(image.aesKeyHex, 'utf8').toString('base64'),
        encrypt_type: 1,
      },
      mid_size: image.cipherSize,
    },
  };
}
