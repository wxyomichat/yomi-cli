import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Just enough raster work for generated media, in plain JavaScript (no native modules): read a
 * JPEG or PNG, crop it around the centre to an aspect ratio, scale it, and write a JPEG. The app
 * prepares pictures the same way: a cover is 720×1440 (1:2), an avatar 512×512, a video's first
 * frame 720×1280 (9:16), all JPEG at quality 92. WebP and other formats are refused.
 */

export class RasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RasterError';
  }
}

export type Raster = { width: number; height: number; data: Uint8Array };

/** The largest picture decoded (pixels): 8192×8192, as the upload rules allow. */
const MAX_PIXELS = 8192 * 8192;

export function sniffMime(bytes: Uint8Array): string {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (
    bytes.length > 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return '';
}

/**
 * A PNG's size comes from its header: one over the pixel cap is refused before the decoder sizes
 * its buffers for it (a small file can declare a huge image).
 */
function checkPngHeader(bytes: Uint8Array) {
  if (bytes.length < 33 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR')
    throw new RasterError('不是 JPEG 或 PNG 图片');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new RasterError('图片太大');
}

/** RGBA pixels of a JPEG or PNG. */
export function decode(bytes: Uint8Array): Raster {
  const mime = sniffMime(bytes);
  if (mime === 'image/jpeg') {
    const image = jpeg.decode(Buffer.from(bytes), {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 1024,
    });
    return { width: image.width, height: image.height, data: image.data };
  }
  if (mime === 'image/png') {
    checkPngHeader(bytes);
    const image = PNG.sync.read(Buffer.from(bytes));
    if (image.width * image.height > MAX_PIXELS) throw new RasterError('图片太大');
    return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  }
  throw new RasterError(
    mime === 'image/webp' ? '暂不能处理 WebP 图片，请换成 JPEG 或 PNG' : '不是 JPEG 或 PNG 图片',
  );
}

/** The centred region with `ratio` = width / height. */
export function centreCrop(image: Raster, ratio: number): Raster {
  let width = image.width;
  let height = Math.round(width / ratio);
  if (height > image.height) {
    height = image.height;
    width = Math.round(height * ratio);
  }
  const left = Math.floor((image.width - width) / 2);
  const top = Math.floor((image.height - height) / 2);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** Scaled with an area average (no aliasing when shrinking), bilinear when growing. */
export function resize(image: Raster, width: number, height: number): Raster {
  if (image.width === width && image.height === height) return image;
  const data = new Uint8Array(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (scaleX >= 1 && scaleY >= 1) {
        const x0 = Math.floor(x * scaleX);
        const y0 = Math.floor(y * scaleY);
        const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * scaleX)));
        const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * scaleY)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = y0; sy < y1; sy++)
          for (let sx = x0; sx < x1; sx++) {
            const i = (sy * image.width + sx) * 4;
            r += image.data[i];
            g += image.data[i + 1];
            b += image.data[i + 2];
            a += image.data[i + 3];
          }
        const count = (x1 - x0) * (y1 - y0);
        data[out] = r / count;
        data[out + 1] = g / count;
        data[out + 2] = b / count;
        data[out + 3] = a / count;
      } else {
        const sx = Math.max(0, Math.min(image.width - 1, (x + 0.5) * scaleX - 0.5));
        const sy = Math.max(0, Math.min(image.height - 1, (y + 0.5) * scaleY - 0.5));
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(image.width - 1, x0 + 1);
        const y1 = Math.min(image.height - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        for (let c = 0; c < 4; c++) {
          const top =
            image.data[(y0 * image.width + x0) * 4 + c] * (1 - fx) +
            image.data[(y0 * image.width + x1) * 4 + c] * fx;
          const bottom =
            image.data[(y1 * image.width + x0) * 4 + c] * (1 - fx) +
            image.data[(y1 * image.width + x1) * 4 + c] * fx;
          data[out + c] = top * (1 - fy) + bottom * fy;
        }
      }
    }
  }
  return { width, height, data };
}

/** JPEG bytes; transparent pixels are laid on white (JPEG has no alpha). */
export function encodeJpeg(image: Raster, quality = 92): Buffer {
  const data = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    const alpha = image.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++)
      data[i * 4 + c] = Math.round(image.data[i * 4 + c] * alpha + 255 * (1 - alpha));
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width: image.width, height: image.height }, quality).data;
}

/** The app's preparations: the crop ratio and the output size. */
export const PREPARED = {
  cover: { ratio: 1 / 2, width: 720, height: 1440 },
  avatar: { ratio: 1, width: 512, height: 512 },
  videoFrame: { ratio: 9 / 16, width: 720, height: 1280 },
} as const;

/** A JPEG of `bytes` cropped and scaled for `use`. */
export function prepare(bytes: Uint8Array, use: keyof typeof PREPARED): Buffer {
  const target = PREPARED[use];
  return encodeJpeg(resize(centreCrop(decode(bytes), target.ratio), target.width, target.height));
}
