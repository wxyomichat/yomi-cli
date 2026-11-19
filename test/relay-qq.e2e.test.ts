import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { memoryIo } from './helpers/io.js';

/**
 * `yomi relay --channel qq` while QQ is a stub (design step A5). Owned by the QQ work (§7.2): it
 * replaces this file with the channel's end-to-end tests against the mock QQ.
 */

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  const values = {
    YOMI_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'yomi-relay-qq-')),
    YOMI_CREDENTIAL_STORE: 'file',
    NO_COLOR: '1',
  };
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the QQ stub', () => {
  it('says QQ is not available yet, in each language, before the keychain and sign-in', async () => {
    const expected = {
      zh: 'QQ 通道还在开发中，暂时不能使用',
      en: 'The QQ channel is not available yet',
      es: 'El canal de QQ todavía no está disponible',
      pt: 'O canal do QQ ainda não está disponível',
    };
    for (const [lang, message] of Object.entries(expected))
      for (const args of [
        ['--channel', 'qq'],
        ['--channel', 'qq', '--set-app', '--token-stdin'],
        ['--channel', 'qq', '--pair', '--install-service'],
      ]) {
        // No --allow-file-store either: this comes first.
        const terminal = memoryIo();
        const code = await main(['relay', ...args, '--lang', lang], terminal.io);
        expect(code, `${lang} ${args.join(' ')}`).toBe(1);
        expect(terminal.err, `${lang} ${args.join(' ')}`).toContain(message);
        expect(terminal.err).not.toMatch(/Error:|at .*\.ts:/);
      }
  });
});
