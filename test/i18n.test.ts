import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { currentLanguage } from '../src/core/device.js';
import { language, languageFrom, parseLanguage, setLanguage, tr } from '../src/core/i18n.js';

/**
 * Everything the CLI prints exists in Chinese and English: a Chinese literal in the source is only
 * ever the first argument of `tr(zh, en)` (or a Chinese table such as the relay's `zh` texts), and
 * the English argument has no Chinese in it. The mock gateway (src/mock) stands for the server and
 * keeps its Chinese data.
 */

const CJK = /[㐀-鿿＀-￯　-〿]/;
const ROOT = fileURLToPath(new URL('../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'mock' ? [] : files(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Literals in Chinese tables: the relay's `zh` texts and commands, the declaration's Chinese. */
function inChineseTable(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      /^(zh|ZH|.*_ZH)$/.test(at.name.text)
    )
      return true;
    if (ts.isPropertyAssignment(at) && ts.isIdentifier(at.name) && at.name.text === 'zh')
      return true;
  }
  return false;
}

/** Which argument of `tr(…)` the node is in: 0 Chinese, 1 English, 2 Spanish, 3 Portuguese. */
function trArgument(node: ts.Node): number | null {
  for (let at: ts.Node = node; at.parent; at = at.parent) {
    const parent = at.parent;
    if (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'tr'
    ) {
      const index = parent.arguments.indexOf(at as ts.Expression);
      if (index >= 0) return index;
    }
  }
  return null;
}

function problems(): string[] {
  const found: string[] = [];
  for (const file of files(ROOT)) {
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
        ts.isTemplateTail(node) ||
        ts.isRegularExpressionLiteral(node);
      if (literal && CJK.test(node.getText())) {
        const where = trArgument(node);
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        // matching what the server sends (not printed): marked on the line
        const marked = source.text.split('\n')[line].includes('i18n-ignore');
        if ((where !== null && where > 0) || (where === null && !inChineseTable(node) && !marked)) {
          found.push(`${relative(ROOT, file)}:${line + 1} ${node.getText().slice(0, 70)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // every call carries all four languages
    const arity = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'tr' &&
        node.arguments.length !== 4
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${relative(ROOT, file)}:${line + 1} tr() with ${node.arguments.length} texts`);
      }
      ts.forEachChild(node, arity);
    };
    arity(source);
  }
  return found;
}

describe('the CLI in two languages', () => {
  afterEach(() => setLanguage(null));

  it('picks the language from --lang, YOMI_LANG, then the system locale; zh… is Chinese, the rest English', () => {
    expect(parseLanguage('zh_CN.UTF-8')).toBe('zh');
    expect(parseLanguage('zh-Hant')).toBe('zh');
    expect(parseLanguage('en_US.UTF-8')).toBe('en');
    expect(parseLanguage('ja_JP.UTF-8')).toBe('en');
    expect(parseLanguage('C')).toBeNull();
    expect(languageFrom({ YOMI_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(languageFrom({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(languageFrom({ LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(languageFrom({ LANG: 'zh_TW.UTF-8' })).toBe('zh');
    setLanguage('en');
    expect(language()).toBe('en');
    expect(tr('中文', 'English', 'Español', 'Português')).toBe('English');
    expect(currentLanguage()).toBe('en');
    setLanguage('zh');
    expect(tr('中文', 'English', 'Español', 'Português')).toBe('中文');
    expect(currentLanguage()).toBe('zh-Hans');
    expect(parseLanguage('es_MX.UTF-8')).toBe('es');
    expect(parseLanguage('pt_BR.UTF-8')).toBe('pt');
    expect(parseLanguage('pt-PT')).toBe('pt');
    setLanguage('es');
    expect(tr('中文', 'English', 'Español', 'Português')).toBe('Español');
    // the server writes in Chinese or English only
    expect(currentLanguage()).toBe('en');
    setLanguage('pt');
    expect(tr('中文', 'English', 'Español', 'Português')).toBe('Português');
  });

  it('has no Chinese outside tr(), every tr() in four languages, and no Chinese in the others', () => {
    expect(problems()).toEqual([]);
  });
});
