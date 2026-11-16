/**
 * The CLI's language: Chinese or English, for everything it prints and what the relay says in
 * Telegram. Chosen once per run, in this order:
 *
 * 1. `--lang zh|en` on the command line (`setLanguage`);
 * 2. `YOMI_LANG`;
 * 3. the system locale: `LC_ALL`, then `LC_MESSAGES`, then `LANG`, then the locale the JavaScript
 *    runtime reports.
 *
 * A value starting with `zh` (zh, zh_CN.UTF-8, zh-Hans, zh-TW…) means Chinese; anything else,
 * including none at all, means English. The same choice goes to the server as `sys_language`.
 */

export type Language = 'zh' | 'en';

let forced: Language | null = null;

/** `zh…` is Chinese, anything else English; null when the value says nothing. */
export function parseLanguage(value: string | undefined | null): Language | null {
  const raw = (value ?? '').trim();
  if (!raw || raw === 'C' || raw === 'POSIX') return null;
  return /^zh/i.test(raw) ? 'zh' : 'en';
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

/** The text in the CLI's language: `tr('中文', 'English')`. */
export function tr(zh: string, en: string): string {
  return language() === 'zh' ? zh : en;
}
