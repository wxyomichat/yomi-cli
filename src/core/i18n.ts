/**
 * The CLI's language: Chinese, English, Spanish or Portuguese, for everything it prints and what
 * the relay says in Telegram. Chosen once per run, in this order:
 *
 * 1. `--lang zh|en|es|pt` on the command line (`setLanguage`);
 * 2. `YOMI_LANG`;
 * 3. the system locale: `LC_ALL`, then `LC_MESSAGES`, then `LANG`, then the locale the JavaScript
 *    runtime reports.
 *
 * A value starting with `zh` (zh, zh_CN.UTF-8, zh-Hans, zh-TW…) means Chinese, `es` Spanish, `pt`
 * Portuguese (written for Brazil, read fine in Portugal); anything else, including none at all,
 * means English. The server writes its own text in Chinese or English only, so `sys_language` is
 * `zh-Hans` for Chinese and `en` for the rest (see device.ts).
 */

export type Language = 'zh' | 'en' | 'es' | 'pt';
export const LANGUAGES: readonly Language[] = ['zh', 'en', 'es', 'pt'];

let forced: Language | null = null;

/** `zh…` is Chinese, anything else English; null when the value says nothing. */
export function parseLanguage(value: string | undefined | null): Language | null {
  const raw = (value ?? '').trim();
  if (!raw || raw === 'C' || raw === 'POSIX') return null;
  if (/^zh/i.test(raw)) return 'zh';
  if (/^es/i.test(raw)) return 'es';
  if (/^pt/i.test(raw)) return 'pt';
  return 'en';
}

function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return '';
  }
}

/** The language for these settings, `--lang` aside. */
export function languageFrom(environ: NodeJS.ProcessEnv = process.env): Language {
  for (const value of [environ.YOMI_LANG, environ.LC_ALL, environ.LC_MESSAGES, environ.LANG]) {
    const language = parseLanguage(value);
    if (language) return language;
  }
  return parseLanguage(systemLocale()) ?? 'en';
}

/** `--lang`: overrides the environment for this run; null goes back to it. */
export function setLanguage(language: Language | null) {
  forced = language;
}

export function language(): Language {
  return forced ?? languageFrom();
}

/** The text in the CLI's language: `tr('中文', 'English', 'Español', 'Português')`. */
export function tr(zh: string, en: string, es: string, pt: string): string {
  switch (language()) {
    case 'zh':
      return zh;
    case 'es':
      return es;
    case 'pt':
      return pt;
    default:
      return en;
  }
}
