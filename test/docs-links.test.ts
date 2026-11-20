import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { main } from '../src/cli.js';
import { DOCS, docUrl } from '../src/core/docs.js';
import { memoryIo } from './helpers/io.js';

/**
 * What the CLI prints sends people to the docs by their web address: after `npm install -g` there
 * is no `docs/` where they run `yomi`, so a relative path would point nowhere.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** A `docs/….md` path that is not part of an address. */
const RELATIVE = /(^|[^/\w])docs\/[\w.-]+\.md/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'mock' ? [] : sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Literals (not comments) in the CLI's sources that name a doc by a relative path. */
function relativePaths(): string[] {
  const found: string[] = [];
  for (const file of sources(join(ROOT, 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      const literal =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node);
      if (literal && RELATIVE.test(node.getText())) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${relative(ROOT, file)}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

async function run(args: string[]) {
  const terminal = memoryIo();
  const code = await main(args, terminal.io);
  return { code, out: terminal.out };
}

describe('links to the docs', () => {
  it('are web addresses of docs that exist and that the package ships', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('docs');
    for (const name of DOCS) {
      expect(existsSync(join(ROOT, 'docs', name)), name).toBe(true);
      expect(pkg.files, name).not.toContain(`!docs/${name}`);
      expect(docUrl(name)).toBe(`https://github.com/wxyomichat/yomi-cli/blob/main/docs/${name}`);
    }
  });

  it('are never a path relative to where yomi runs', () => {
    expect(relativePaths()).toEqual([]);
  });

  it("are in relay's help, in every language", async () => {
    for (const lang of ['zh', 'en', 'es', 'pt']) {
      const help = await run(['--lang', lang, 'relay', '--help']);
      expect(help.code, lang).toBe(0);
      for (const name of ['relay.md', 'relay-qq.md', 'relay-wechat.md'] as const)
        expect(help.out, `${lang} ${name}`).toContain(`    ${docUrl(name)}\n`);
      expect(help.out, lang).not.toMatch(RELATIVE);
    }
  });
});
