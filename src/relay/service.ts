import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { tr } from '../core/i18n.js';
import type { ChannelKind } from './channels/types.js';

/**
 * `yomi relay --install-service`: keep the relay running for this user, as a launchd
 * LaunchAgent (macOS, `gui/<uid>` domain, so it can read the login keychain while the user is
 * logged in) or a systemd user unit (Linux; Secret Service needs the user's session bus, so the
 * relay stops cleanly when the keyring is locked instead of falling back to a file).
 * The unit holds no secrets: the relay reads its tokens from the keychain when it starts.
 * One unit per Yomi account and environment runs every bot (`hub`: `…relay.hub-<env>`,
 * `yomi-relay-hub-<env>.service`). The units of before it, one per channel (Telegram's
 * `…relay.<env>`, `yomi-relay-<env>.service`; QQ `…relay.qq-<env>`, WeChat `…relay.wechat-<env>`),
 * are still named here, so that `yomi relay` finds them running and removes them.
 * While the bots change (added, signed in again, bound, removed), `yomi relay` stops a running
 * service and starts it again afterwards (`servicePid`, `pauseService`, `resumeService`); what an
 * installed unit runs with is read back from it (`installedArgs`), so that the command that installs
 * it again can keep its spending cap.
 */

/** Which relay a unit runs: every bot (`hub`), or one channel's (a unit of before the hub). */
export type ServiceUnit = ChannelKind | 'hub';

/** Relay names as unit files write them (ASCII); the hub's is none. */
const SERVICE_NAMES: Record<ServiceUnit, string> = {
  hub: '',
  telegram: 'Telegram ',
  qq: 'QQ ',
  wechat: 'WeChat ',
};

export type ServiceOptions = {
  /** `test`, `prod` or `<env>@<origin>` (accountKey): one service per environment. */
  account: string;
  /** Which unit: the hub's, or a channel's of before it (Telegram's when absent). */
  channel?: ServiceUnit;
  /** Absolute paths: the Node binary and the CLI entry. */
  node: string;
  script: string;
  /** Arguments after the script: `relay --env prod …`. */
  args: string[];
  /** Plain settings the relay needs (never tokens): YOMI_CONFIG_DIR, YOMI_LANG, LANG. */
  environment: Record<string, string>;
  logDir: string;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
};

export type ServicePlan = {
  platform: 'darwin' | 'linux';
  label: string;
  path: string;
  content: string;
  /** Where the relay's output goes (`logs/relay-<name>.log`). */
  log: string;
  /** Commands run in order; a failing one in `install` stops the install. */
  install: string[][];
  /** Run before `install` and on uninstall; failures are ignored (not loaded yet). */
  stop: string[][];
  /** Stops the running service and leaves it installed (`pauseService`). */
  pause: string[];
  /** Starts the installed service again (`resumeService`). */
  resume: string[];
  /** Asks for the running service's process (`servicePid`). */
  pid: string[];
};

function suffix(account: string): string {
  const plain = account
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return plain.slice(0, 40) || 'default';
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One quoted systemd word: `\\` and `"` escaped, `%` doubled (specifiers apply everywhere). In
 * ExecStart `$` is doubled too, since systemd expands variables there; `Environment=` does not
 * expand them, so a `$` stays as it is.
 */
function systemdWord(word: string, expandsVariables: boolean): string {
  let escaped = word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (expandsVariables) escaped = escaped.replace(/\$/g, '$$$$');
  return '"' + escaped + '"';
}

export function servicePlan(options: ServiceOptions): ServicePlan {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const uid = options.uid ?? userInfo().uid;
  const channel = options.channel ?? 'telegram';
  const name =
    channel === 'telegram' ? suffix(options.account) : `${channel}-${suffix(options.account)}`;
  const log = join(options.logDir, `relay-${name}.log`);
  if (platform === 'darwin') {
    const label = `io.yomichat.yomi-cli.relay.${name}`;
    const path = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const argv = [options.node, options.script, ...options.args];
    const environment = Object.entries(options.environment)
      .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
      .join('\n');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argv.map((word) => `      <string>${xml(word)}</string>`).join('\n')}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
  </dict>
</plist>
`;
    const domain = `gui/${uid}`;
    return {
      platform: 'darwin',
      label,
      path,
      content,
      log,
      stop: [['launchctl', 'bootout', `${domain}/${label}`]],
      install: [['launchctl', 'bootstrap', domain, path]],
      pause: ['launchctl', 'bootout', `${domain}/${label}`],
      resume: ['launchctl', 'bootstrap', domain, path],
      pid: ['launchctl', 'print', `${domain}/${label}`],
    };
  }
  if (platform === 'linux') {
    const unit = `yomi-relay-${name}.service`;
    const path = join(home, '.config', 'systemd', 'user', unit);
    const environment = Object.entries(options.environment)
      .map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`, false)}`)
      .join('\n');
    const content = `[Unit]
Description=Yomi CLI ${SERVICE_NAMES[channel]}relay (${options.account})
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=${[options.node, options.script, ...options.args].map((word) => systemdWord(word, true)).join(' ')}
${environment}
Restart=on-failure
RestartSec=30
StandardOutput=append:${log.replace(/%/g, '%%')}
StandardError=append:${log.replace(/%/g, '%%')}

[Install]
WantedBy=default.target
`;
    return {
      platform: 'linux',
      label: unit,
      path,
      content,
      log,
      stop: [['systemctl', '--user', 'disable', '--now', unit]],
      install: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', unit],
      ],
      pause: ['systemctl', '--user', 'stop', unit],
      resume: ['systemctl', '--user', 'start', unit],
      pid: ['systemctl', '--user', 'show', '--property', 'MainPID', '--value', unit],
    };
  }
  throw new Error(
    tr(
      '后台服务只支持 macOS（launchd）和 Linux（systemd --user）',
      'The background service supports only macOS (launchd) and Linux (systemd --user)',
      'El servicio en segundo plano solo es compatible con macOS (launchd) y Linux (systemd --user)',
      'O serviço em segundo plano só funciona no macOS (launchd) e no Linux (systemd --user)',
    ),
  );
}

export type Runner = (command: string, args: string[]) => { status: number | null; output: string };

export const runCommand: Runner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  return {
    status: result.error ? null : result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
};

/**
 * Writes the unit (0644, through a temporary file) without touching the directory's own mode:
 * `~/Library/LaunchAgents` and `~/.config/systemd/user` belong to the system's conventions.
 * Loading it is `installService`'s.
 */
export function writeServiceUnit(plan: ServicePlan) {
  mkdirSync(dirname(plan.path), { recursive: true });
  const temporary = `${plan.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, plan.content, { mode: 0o644 });
  renameSync(temporary, plan.path);
}

/**
 * The command line of the unit installed at `plan.path` (node, script, then its arguments), read
 * back as `servicePlan` wrote it: what the service runs with when it starts again as it is. [] when
 * no unit is there or it names no command.
 */
export function installedArgs(plan: ServicePlan): string[] {
  let content: string;
  try {
    content = readFileSync(plan.path, 'utf8');
  } catch {
    return [];
  }
  if (plan.platform === 'darwin') {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1];
    return [...(array ?? '').matchAll(/<string>([\s\S]*?)<\/string>/g)].map(([, word]) =>
      word
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&'),
    );
  }
  const line = /^ExecStart=(.*)$/m.exec(content)?.[1] ?? '';
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, word]) =>
    word
      .replace(/\$\$/g, () => '$')
      .replace(/%%/g, '%')
      .replace(/\\(.)/g, (_, escaped: string) => escaped),
  );
}

/** Writes the unit and loads it; the first failing load command is reported. */
export function installService(plan: ServicePlan, run: Runner = runCommand) {
  for (const [command, ...args] of plan.stop) run(command, args);
  writeServiceUnit(plan);
  for (const [command, ...args] of plan.install) {
    const result = run(command, args);
    if (result.status !== 0)
      throw new Error(
        tr(
          `${command} ${args.join(' ')} 失败${result.output ? `：${result.output.slice(0, 300)}` : ''}`,
          `${command} ${args.join(' ')} failed${result.output ? `: ${result.output.slice(0, 300)}` : ''}`,
          `${command} ${args.join(' ')} falló${result.output ? `: ${result.output.slice(0, 300)}` : ''}`,
          `${command} ${args.join(' ')} falhou${result.output ? `: ${result.output.slice(0, 300)}` : ''}`,
        ),
      );
  }
}

/** Stops the service and removes the unit; true when there was one. */
export function uninstallService(plan: ServicePlan, run: Runner = runCommand): boolean {
  for (const [command, ...args] of plan.stop) run(command, args);
  const existed = existsSync(plan.path);
  rmSync(plan.path, { force: true });
  if (plan.platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
  return existed;
}

/** The process of the installed service while it runs; 0 when it does not run (or nobody says). */
export function servicePid(plan: ServicePlan, run: Runner = runCommand): number {
  if (!existsSync(plan.path)) return 0;
  const [command, ...args] = plan.pid;
  const result = run(command, args);
  if (result.status !== 0) return 0;
  // launchd: `pid = 1234` in its description; systemd: the bare MainPID (0 when stopped).
  const found =
    plan.platform === 'darwin' ? /\bpid = (\d+)/.exec(result.output)?.[1] : result.output;
  const pid = Number(found ?? 0);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * Stops the service while the bots change (`yomi relay` changes them with no relay running), and
 * leaves it installed for `resumeService`.
 */
export function pauseService(plan: ServicePlan, run: Runner = runCommand) {
  const [command, ...args] = plan.pause;
  run(command, args);
}

/** Starts the installed service again after `pauseService`; false when it could not. */
export function resumeService(plan: ServicePlan, run: Runner = runCommand): boolean {
  const [command, ...args] = plan.resume;
  return run(command, args).status === 0;
}
