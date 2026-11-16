import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadImage, sniffImage } from '../src/ugc/imageFile.js';
import { loadSpecFile, SpecError, specFromObject, validateSpec } from '../src/ugc/spec.js';
import { countText } from '../src/ugc/text.js';
import { solidPng } from './helpers/png.js';

const valid = {
  name: '林夏',
  gender: 'female',
  description: 'desc',
  opening: '"hi"',
  voice: 'voice_warm_f',
  cover: '/tmp/cover.png',
  avatar: '/tmp/avatar.png',
};

describe('character files', () => {
  it('reads YAML with paths relative to the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-spec-'));
    const file = join(dir, 'c.yaml');
    writeFileSync(
      file,
      'name: A\ngender: 女\ndescription: d\nopening: o\nvoice: v\ncover: ./c.png\navatar: { upload_id: 12 }\nvisibility: 私密\n',
    );
    const spec = loadSpecFile(file);
    expect(spec.gender).toBe('female');
    expect(spec.visibility).toBe('private');
    expect(spec.cover).toEqual({ kind: 'file', path: join(dir, 'c.png') });
    expect(spec.avatar).toEqual({ kind: 'upload', uploadId: '12' });
    expect(validateSpec(spec)).toEqual([]);
  });

  it('refuses unknown keys and bad image references', () => {
    expect(() => specFromObject({ ...valid, nmae: 'x' })).toThrow(SpecError);
    expect(() => specFromObject({ ...valid, cover: 'https://x/y.png' })).toThrow(SpecError);
    expect(() => specFromObject({ ...valid, cover: { upload_id: 1, asset_id: 2 } })).toThrow(
      SpecError,
    );
  });

  it('checks the app rules: required fields, code point limits, voices, tags', () => {
    expect(validateSpec(specFromObject(valid))).toEqual([]);
    const empty = validateSpec(specFromObject({}));
    expect(empty.join('\n')).toMatch(
      /头像[\s\S]*形象图[\s\S]*名字[\s\S]*性别[\s\S]*简介[\s\S]*开场白[\s\S]*声音/,
    );
    // 50 emoji are 50 characters (code points), 51 are too many.
    expect(countText('😀'.repeat(50))).toBe(50);
    expect(validateSpec(specFromObject({ ...valid, name: '😀'.repeat(50) }))).toEqual([]);
    expect(validateSpec(specFromObject({ ...valid, name: '😀'.repeat(51) })).join()).toContain(
      '最多 50',
    );
    expect(
      validateSpec(specFromObject({ ...valid, author_note: 'x'.repeat(20_001) })).join(),
    ).toContain('20000');
    expect(validateSpec(specFromObject({ ...valid, tags: ['a', 'a'] })).join()).toContain(
      '标签不能重复',
    );
    expect(
      validateSpec(
        specFromObject({ ...valid, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }),
      ).join(),
    ).toContain('最多 10');
    const voices = {
      voices: [
        { id: 'a', weight: 0 },
        { id: 'b', weight: 0 },
      ],
      pitch: 2,
    };
    const problems = validateSpec(specFromObject({ ...valid, voice: voices })).join();
    expect(problems).toContain('权重要大于 0');
    expect(problems).toContain('0.5–1.5');
    const five = { voices: ['a', 'b', 'c', 'd', 'e'] };
    expect(validateSpec(specFromObject({ ...valid, voice: five })).join()).toContain('最多混合 4');
  });
});

describe('pictures', () => {
  it('reads the size from PNG, JPEG and WebP headers', () => {
    expect(sniffImage(solidPng(720, 1440, [0, 0, 0]))).toEqual({
      mime: 'image/png',
      width: 720,
      height: 1440,
    });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00,
      0x02, 0x00, 0x03,
    ]);
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 512, height: 512 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8X', 12, 'ascii');
    webp.writeUIntLE(719, 24, 3);
    webp.writeUIntLE(1439, 27, 3);
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', width: 720, height: 1440 });
    expect(sniffImage(Buffer.from('GIF89a........'))).toBeNull();
  });

  it('wants the app shapes: 1:2 appearance, 1:1 avatar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-img-'));
    writeFileSync(join(dir, 'cover.png'), solidPng(360, 720, [1, 1, 1]));
    writeFileSync(join(dir, 'square.png'), solidPng(100, 100, [1, 1, 1]));
    expect(loadImage(join(dir, 'cover.png'), 'cover')).toMatchObject({
      width: 360,
      height: 720,
      mime: 'image/png',
    });
    expect(loadImage(join(dir, 'square.png'), 'avatar').sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => loadImage(join(dir, 'square.png'), 'cover')).toThrow('1:2');
    expect(() => loadImage(join(dir, 'missing.png'), 'avatar')).toThrow('找不到文件');
  });
});
