/**
 * Where the CLI talks to. Production is the default; its addresses are the only ones built in.
 * A test environment is set up by the people who run one: `--env test` (or `YOMI_ENV=test`)
 * with `YOMI_TEST_API_ORIGIN` and `YOMI_TEST_WEB_ORIGIN`. A lane (`--lane <name>`) adds the
 * `Lane` header to every request and the long connection; lanes exist on a test environment only.
 * `YOMI_API_ORIGIN` / `YOMI_WEB_ORIGIN` point any run at another gateway or web build (the mock
 * server, a local web build); such a run is never treated as production.
 *
 * Actions that create or spend in production ask for a typed `prod` (or `--confirm-prod`).
 */

import { tr } from './i18n.js';

export type EnvName = 'test' | 'prod';

export type Environment = {
  name: EnvName;
  apiOrigin: string;
  webOrigin: string;
  lane: string;
  /** True when an origin was overridden (mock, local web). */
  custom: boolean;
};

export const PRODUCTION = {
  apiOrigin: 'https://api.yomichat.io',
  webOrigin: 'https://www.yomichat.io',
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const LANE = /^[a-z][a-z0-9_-]{0,63}$/;

/** `http(s)://host[:port]` without a path; loopback may be plain http. */
export function normalizeOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(
      tr(
        `${label} 不是合法地址：${value}`,
        `${label} is not a valid address: ${value}`,
        `${label} no es una dirección válida: ${value}`,
        `${label} não é um endereço válido: ${value}`,
      ),
    );
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new UsageError(
      tr(
        `${label} 必须是 https（本机 127.0.0.1 可用 http）：${value}`,
        `${label} must be https (http is allowed for 127.0.0.1 on this machine): ${value}`,
        `${label} debe ser https (se permite http para 127.0.0.1 en este equipo): ${value}`,
        `${label} deve ser https (http é permitido para 127.0.0.1 nesta máquina): ${value}`,
      ),
    );
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== ''))
    throw new UsageError(
      tr(
        `${label} 只能是 origin（不带路径和账号）：${value}`,
        `${label} must be an origin only (no path or account): ${value}`,
        `${label} debe ser solo un origen (sin ruta ni cuenta): ${value}`,
        `${label} deve ser só uma origem (sem caminho nem conta): ${value}`,
      ),
    );
  return url.origin;
}

export function resolveEnvironment(
  options: { env?: string; lane?: string },
  environ: NodeJS.ProcessEnv = process.env,
): Environment {
  const name = (options.env ?? environ.YOMI_ENV ?? 'prod') as EnvName;
  if (name !== 'test' && name !== 'prod')
    throw new UsageError(
      tr(
        `--env 只能是 test 或 prod，收到：${String(name)}`,
        `--env must be test or prod, got: ${String(name)}`,
        `--env debe ser test o prod; se recibió: ${String(name)}`,
        `--env deve ser test ou prod; recebido: ${String(name)}`,
      ),
    );
  const lane = options.lane ?? environ.YOMI_LANE ?? '';
  if (lane && !LANE.test(lane))
    throw new UsageError(
      tr(
        `泳道名不合法：${lane}`,
        `Invalid lane name: ${lane}`,
        `Nombre de lane no válido: ${lane}`,
        `Nome de lane inválido: ${lane}`,
      ),
    );
  if (lane && name === 'prod')
    throw new UsageError(
      tr(
        '泳道只在测试环境（--env test）可用',
        'Lanes are only available in the test environment (--env test)',
        'Las lanes solo están disponibles en el entorno de pruebas (--env test)',
        'As lanes só estão disponíveis no ambiente de teste (--env test)',
      ),
    );
  const apiOverride = environ.YOMI_API_ORIGIN;
  const webOverride = environ.YOMI_WEB_ORIGIN;
  let base = PRODUCTION;
  if (name === 'test') {
    const api = environ.YOMI_TEST_API_ORIGIN;
    const web = environ.YOMI_TEST_WEB_ORIGIN;
    if ((!api && !apiOverride) || (!web && !webOverride))
      throw new UsageError(
        tr(
          '测试环境的地址需要自己配置：设置 YOMI_TEST_API_ORIGIN 和 YOMI_TEST_WEB_ORIGIN（或 YOMI_API_ORIGIN / YOMI_WEB_ORIGIN）',
          'The test environment has no built-in addresses: set YOMI_TEST_API_ORIGIN and YOMI_TEST_WEB_ORIGIN (or YOMI_API_ORIGIN / YOMI_WEB_ORIGIN)',
          'El entorno de pruebas no tiene direcciones integradas: configura YOMI_TEST_API_ORIGIN y YOMI_TEST_WEB_ORIGIN (o YOMI_API_ORIGIN / YOMI_WEB_ORIGIN)',
          'O ambiente de teste não tem endereços embutidos: defina YOMI_TEST_API_ORIGIN e YOMI_TEST_WEB_ORIGIN (ou YOMI_API_ORIGIN / YOMI_WEB_ORIGIN)',
        ),
      );
    base = {
      apiOrigin: api ? normalizeOrigin(api, 'YOMI_TEST_API_ORIGIN') : '',
      webOrigin: web ? normalizeOrigin(web, 'YOMI_TEST_WEB_ORIGIN') : '',
    };
  }
  return {
    name,
    apiOrigin: apiOverride ? normalizeOrigin(apiOverride, 'YOMI_API_ORIGIN') : base.apiOrigin,
    webOrigin: webOverride ? normalizeOrigin(webOverride, 'YOMI_WEB_ORIGIN') : base.webOrigin,
    lane,
    custom: Boolean(apiOverride || webOverride),
  };
}

/**
 * Whether plain http to this machine is acceptable: only while the CLI is pointed at a local test
 * server (`YOMI_API_ORIGIN` on 127.0.0.1 / localhost). Against the real service, uploads and
 * results are https.
 */
export function localTestServer(environ: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const url = new URL(environ.YOMI_API_ORIGIN ?? '');
    return ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** True for http on this machine while testing against a local server. */
export function loopbackHttpAllowed(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    localTestServer()
  );
}

/** The real production service (not a mock or local build pointed at with an override). */
export function isProduction(env: Environment): boolean {
  return env.name === 'prod' && !env.custom;
}

/** What the CLI prints about where it is talking to. */
export function describeEnvironment(env: Environment): string {
  const parts = [
    env.custom
      ? tr(
          `自定义地址（${env.name}）`,
          `custom address (${env.name})`,
          `dirección personalizada (${env.name})`,
          `endereço personalizado (${env.name})`,
        )
      : env.name === 'prod'
        ? tr('生产环境', 'production', 'producción', 'produção')
        : tr('测试环境 test', 'test environment', 'entorno de pruebas', 'ambiente de teste'),
  ];
  if (env.lane)
    parts.push(tr(`泳道 ${env.lane}`, `lane ${env.lane}`, `lane ${env.lane}`, `lane ${env.lane}`));
  if (env.custom) parts.push(`API ${env.apiOrigin}`);
  return parts.join(' · ');
}
