import { release } from 'node:os';

import { language, languageFrom } from './i18n.js';
import { VERSION } from './version.js';

/** The app's id; the Gateway refuses a request without it. */
export const APP_ID = 50010;

/** `OSType.WEB`: the gateway accepts 1–3 only, and the CLI signs in as the web does. */
export const OS_WEB = 3;

/** The web's version code; the gateway gates features on it. */
export const VERSION_CODE = 1000000;

/**
 * The interface language the server writes its text in: `zh-Hans` or `en`, the CLI's own language
 * (`--lang`, `YOMI_LANG`, the system locale; see i18n.ts).
 */
export function currentLanguage(environ: NodeJS.ProcessEnv = process.env): string {
  const chosen = environ === process.env ? language() : languageFrom(environ);
  return chosen === 'zh' ? 'zh-Hans' : 'en';
}

/**
 * The common query every request carries, as the Yomi clients send it, with the CLI's own values:
 * `os` 3 like the web, `channel` and `brand` saying it is the CLI.
 */
export function deviceMetadata(idfv: string, environ: NodeJS.ProcessEnv = process.env) {
  const language = currentLanguage(environ);
  const region = /_([A-Z]{2})/.exec(environ.LANG ?? '')?.[1] ?? 'US';
  return {
    idfv,
    device_platform: 'web',
    os: String(OS_WEB),
    brand: 'yomi-cli',
    device_type: 'desktop',
    os_version:
      `yomi-cli/${VERSION} node/${process.versions.node} ${process.platform} ${release()}`.slice(
        0,
        120,
      ),
    resolution: '0*0',
    channel: 'cli',
    version_code: String(VERSION_CODE),
    version_name: VERSION,
    sys_language: language,
    sys_region: region,
    network_type: '',
    mcc_mnc: '',
  };
}
