import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * A picture from disk, checked as the app checks it before upload: JPEG / PNG / WebP up to 20 MB
 * and 8192 px a side, and the shape the app crops to: the appearance 1:2 (720 × 1440 in the app),
 * the avatar 1:1 (512 × 512). The CLI does not crop or re-encode; it uploads the file as it is, so
 * crop it first.
 */

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_SIDE = 8192;
export const ASPECT = { cover: 0.5, avatar: 1 } as const;
export const RECOMMENDED = { cover: '720×1440', avatar: '512×512' } as const;

export type ImageKind = keyof typeof ASPECT;
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export type LocalImage = {
  path: string;
  bytes: Buffer;
  mime: ImageMime;
  width: number;
  height: number;
  sha256: string;
};

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

/** Width and height from the file header; null when the format is not one of the three. */
export function sniffImage(
  bytes: Buffer,
): { mime: ImageMime; width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (
        marker === 0xd8 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01 ||
        marker === 0xff
      ) {
        offset += marker === 0xff ? 1 : 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (frame)
        return {
          mime: 'image/jpeg',
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      offset += 2 + length;
    }
    return null;
  }
  if (
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X')
      return {
        mime: 'image/webp',
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    if (chunk === 'VP8 ')
      return {
        mime: 'image/webp',
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return {
        mime: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  }
  return null;
}

export function loadImage(path: string, kind: ImageKind): LocalImage {
  const label = kind === 'cover' ? '形象图 cover' : '头像 avatar';
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new ImageError(`${label}：找不到文件 ${path}`);
  }
  if (size > MAX_IMAGE_BYTES) throw new ImageError(`${label}：文件超过 20 MB`);
  const bytes = readFileSync(path);
  const info = sniffImage(bytes);
  if (!info) throw new ImageError(`${label}：只支持 JPEG、PNG、WebP（${path}）`);
  if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE)
    throw new ImageError(`${label}：尺寸不合法（${info.width}×${info.height}）`);
  const aspect = info.width / info.height;
  if (Math.abs(aspect - ASPECT[kind]) > 0.02)
    throw new ImageError(
      `${label}：比例要 ${kind === 'cover' ? '1:2（宽:高）' : '1:1'}，现在是 ${info.width}×${info.height}；` +
        `App 用 ${RECOMMENDED[kind]}，先裁好再用`,
    );
  return {
    path,
    bytes,
    mime: info.mime,
    width: info.width,
    height: info.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
