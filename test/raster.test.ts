import { describe, expect, it } from 'vitest';

import {
  centreCrop,
  decode,
  encodeJpeg,
  prepare,
  PREPARED,
  type Raster,
  RasterError,
  resize,
  sniffMime,
} from '../src/gen/raster.js';
import { solidPngBytes } from '../src/mock/gen/png.js';
import { solidPng } from './helpers/png.js';

/**
 * The raster helpers that turn a generated picture into the app's cover (1:2, 720×1440), avatar
 * (1:1, 512×512) and video frame (9:16, 720×1280) JPEGs, in plain JavaScript.
 */

/** A picture whose every pixel says where it came from: red = x, green = y. */
function coordinates(width: number, height: number): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  return { width, height, data };
}

const pixel = (image: Raster, x: number, y: number) =>
  Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));

/** RIFF…WEBP: recognised as WebP, never decoded. */
function webp(): Buffer {
  const body = Buffer.concat([Buffer.from('WEBPVP8 ', 'ascii'), Buffer.alloc(32, 1)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, body]);
}

describe('raster', () => {
  it('recognises JPEG, PNG and WebP by their bytes', () => {
    expect(sniffMime(solidPngBytes(4, 4, [1, 2, 3]))).toBe('image/png');
    expect(sniffMime(encodeJpeg(coordinates(8, 8)))).toBe('image/jpeg');
    expect(sniffMime(webp())).toBe('image/webp');
    expect(sniffMime(Buffer.from('GIF89a........'))).toBe('');
    expect(sniffMime(new Uint8Array(0))).toBe('');
  });

  it('decodes PNG (RGB and RGBA) and JPEG into RGBA pixels', () => {
    const rgb = decode(solidPng(6, 3, [10, 20, 30]));
    expect([rgb.width, rgb.height, rgb.data.length]).toEqual([6, 3, 6 * 3 * 4]);
    expect(pixel(rgb, 5, 2)).toEqual([10, 20, 30, 255]);
    const rgba = decode(solidPngBytes(5, 7, [200, 100, 50]));
    expect([rgba.width, rgba.height]).toEqual([5, 7]);
    expect(pixel(rgba, 0, 0)).toEqual([200, 100, 50, 255]);
    const solid: Raster = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) };
    for (let i = 0; i < 16 * 16; i++) solid.data.set([40, 120, 220, 255], i * 4);
    const jpeg = decode(encodeJpeg(solid));
    expect([jpeg.width, jpeg.height]).toEqual([16, 16]);
    const [r, g, b, a] = pixel(jpeg, 8, 8);
    expect(Math.abs(r - 40)).toBeLessThan(6);
    expect(Math.abs(g - 120)).toBeLessThan(6);
    expect(Math.abs(b - 220)).toBeLessThan(6);
    expect(a).toBe(255);
  });

  it('refuses WebP and anything that is not JPEG or PNG', () => {
    expect(() => decode(webp())).toThrow(RasterError);
    expect(() => decode(webp())).toThrow(/WebP/);
    expect(() => decode(Buffer.from('not a picture at all'))).toThrow(RasterError);
    expect(() => decode(Buffer.from('not a picture at all'))).toThrow(/JPEG 或 PNG/);
    expect(() => prepare(webp(), 'cover')).toThrow(RasterError);
    expect(() => prepare(webp(), 'avatar')).toThrow(/WebP/);
  });

  it('refuses a PNG whose header declares too many pixels, before decoding it', () => {
    // A tiny file can declare a huge picture: the header alone decides.
    const png = Buffer.from(solidPngBytes(4, 4, [10, 20, 30]));
    png.writeUInt32BE(100_000, 16);
    png.writeUInt32BE(100_000, 20);
    expect(() => decode(png)).toThrow(RasterError);
    expect(() => decode(png)).toThrow('图片太大');
    expect(() => decode(png.subarray(0, 20))).toThrow(/JPEG 或 PNG/);
  });

  it('crops around the centre to the asked ratio', () => {
    // Wider than 1:2: the full height, the middle columns.
    const cover = centreCrop(coordinates(100, 100), 1 / 2);
    expect([cover.width, cover.height]).toEqual([50, 100]);
    expect(pixel(cover, 0, 0).slice(0, 2)).toEqual([25, 0]);
    expect(pixel(cover, 49, 99).slice(0, 2)).toEqual([74, 99]);
    // Taller than 1:1: the full width, the middle rows.
    const avatar = centreCrop(coordinates(60, 100), 1);
    expect([avatar.width, avatar.height]).toEqual([60, 60]);
    expect(pixel(avatar, 0, 0).slice(0, 2)).toEqual([0, 20]);
    expect(pixel(avatar, 59, 59).slice(0, 2)).toEqual([59, 79]);
    // A 9:16 portrait into 1:2: the full height is too tall, so the full height and fewer columns.
    const portrait = centreCrop(coordinates(90, 160), 1 / 2);
    expect([portrait.width, portrait.height]).toEqual([80, 160]);
    expect(pixel(portrait, 0, 0).slice(0, 2)).toEqual([5, 0]);
    // Odd sizes: the extra row or column falls on the far side.
    const odd = centreCrop(coordinates(101, 251), 1 / 2);
    expect([odd.width, odd.height]).toEqual([101, 202]);
    expect(pixel(odd, 0, 0).slice(0, 2)).toEqual([0, 24]);
    // Already the ratio: unchanged.
    const same = centreCrop(coordinates(40, 80), 1 / 2);
    expect([same.width, same.height]).toEqual([40, 80]);
    expect(pixel(same, 39, 79).slice(0, 2)).toEqual([39, 79]);
    // 16:9 into 9:16.
    const frame = centreCrop(coordinates(160, 90), 9 / 16);
    expect([frame.width, frame.height]).toEqual([51, 90]);
  });

  it('shrinks by averaging areas and grows smoothly', () => {
    const checker: Raster = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) };
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const value = (x + y) % 2 ? 200 : 0;
        checker.data.set([value, value, value, 255], (y * 4 + x) * 4);
      }
    const half = resize(checker, 2, 2);
    expect([half.width, half.height]).toEqual([2, 2]);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) expect(pixel(half, x, y)).toEqual([100, 100, 100, 255]);
    const grown = resize(coordinates(2, 2), 8, 8);
    expect([grown.width, grown.height]).toEqual([8, 8]);
    expect(pixel(grown, 0, 0).slice(0, 2)).toEqual([0, 0]);
    expect(pixel(grown, 7, 7).slice(0, 2)).toEqual([1, 1]);
    const same = coordinates(3, 3);
    expect(resize(same, 3, 3)).toBe(same);
  });

  it('lays transparency on white in JPEG', () => {
    const clear: Raster = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) };
    const decoded = decode(encodeJpeg(clear));
    const [r, g, b] = pixel(decoded, 4, 4);
    expect(Math.min(r, g, b)).toBeGreaterThan(245);
  });

  it('prepares the app sizes as JPEG', () => {
    expect(PREPARED.cover).toMatchObject({ ratio: 0.5, width: 720, height: 1440 });
    expect(PREPARED.avatar).toMatchObject({ ratio: 1, width: 512, height: 512 });
    expect(PREPARED.videoFrame).toMatchObject({ ratio: 9 / 16, width: 720, height: 1280 });
    const source = solidPngBytes(180, 320, [30, 160, 90]);
    for (const [use, width, height] of [
      ['cover', 720, 1440],
      ['avatar', 512, 512],
      ['videoFrame', 720, 1280],
    ] as const) {
      const bytes = prepare(source, use);
      expect(sniffMime(bytes)).toBe('image/jpeg');
      const result = decode(bytes);
      expect([result.width, result.height]).toEqual([width, height]);
      const [r, g, b] = pixel(result, Math.floor(width / 2), Math.floor(height / 2));
      expect(Math.abs(r - 30)).toBeLessThan(8);
      expect(Math.abs(g - 160)).toBeLessThan(8);
      expect(Math.abs(b - 90)).toBeLessThan(8);
    }
    // A JPEG source too, larger than the target (shrunk).
    const large: Raster = { width: 1600, height: 1600, data: new Uint8Array(1600 * 1600 * 4) };
    large.data.fill(128);
    const avatar = decode(prepare(encodeJpeg(large), 'avatar'));
    expect([avatar.width, avatar.height]).toEqual([512, 512]);
  });
});
