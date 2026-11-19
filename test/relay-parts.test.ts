import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readSecret } from '../src/core/prompt.js';
import type { Io } from '../src/core/ui.js';
import { ParagraphType } from '../src/im/models.js';
import { escapeHtml, renderReply } from '../src/relay/render.js';
import { ApiError } from '../src/core/api.js';
import { ChatRefusal, refusalOf } from '../src/chat/api.js';
import { PairingCode } from '../src/relay/pairing.js';
import { unknownOutcome } from '../src/relay/relay.js';
import { installService, servicePlan, uninstallService } from '../src/relay/service.js';
import { forgetRelayStates, RelayState, relayStatePath } from '../src/relay/state.js';
import { type BudgetStatus, relayTexts } from '../src/relay/texts.js';

const narration = (text: string) => ({
  type: ParagraphType.narration,
  text,
  npcId: '',
  npcName: '',
});
const line = (text: string, npcName = '', npcId = '') => ({
  type: ParagraphType.dialogue,
  text,
  npcId,
  npcName,
});

describe('rendering a reply for Telegram', () => {
  it('escapes text, italicises narration, names speakers only in group chats', () => {
    const single = renderReply([narration('她笑了 <b>'), line('你好 & 再见', '林夏')], {
      characterName: '林夏',
      group: false,
    });
    expect(single).toEqual(['<i>她笑了 &lt;b&gt;</i>\n\n你好 &amp; 再见']);
    const group = renderReply([line('早', '阿青', '1'), line('早安', '小白', '2')], {
      characterName: '雾港',
      group: true,
    });
    expect(group).toEqual(['<b>阿青</b>：早\n\n<b>小白</b>：早安']);
    expect(renderReply([line('  ')], { characterName: 'x', group: false })).toEqual([]);
    expect(escapeHtml('a<b>&')).toBe('a&lt;b&gt;&amp;');
  });

  it('splits long replies under the limit without breaking escapes', () => {
    const long = '字'.repeat(250) + ' ' + '<'.repeat(250);
    const messages = renderReply(
      [line(long), line('end')],
      { characterName: 'x', group: false },
      300,
    );
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      const visible = message.replace(/<\/?[bi]>/g, '').replace(/&lt;|&gt;|&amp;/g, '.');
      expect(visible.length).toBeLessThanOrEqual(300);
      expect(message).not.toMatch(/&(?!lt;|gt;|amp;)/);
    }
    expect(messages.join('')).toContain('end');
  });
});

describe('the background service', () => {
  const base = {
    account: 'test',
    node: '/opt/node/bin/node',
    script: '/Users/me/yomi cli/dist/cli.js',
    args: ['relay', '--telegram', '--env', 'test'],
    environment: { YOMI_LANG: 'zh-Hans', YOMI_CONFIG_DIR: '/Users/me/.config/yomi-cli' },
    logDir: '/Users/me/.config/yomi-cli/logs',
  };

  it('writes a LaunchAgent in the gui domain, kept alive only after a failure', () => {
    const plan = servicePlan({ ...base, platform: 'darwin', home: '/Users/me', uid: 501 });
    expect(plan.path).toBe('/Users/me/Library/LaunchAgents/io.yomichat.yomi-cli.relay.test.plist');
    expect(plan.content).toContain('<string>/Users/me/yomi cli/dist/cli.js</string>');
    expect(plan.content).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plan.install).toEqual([['launchctl', 'bootstrap', 'gui/501', plan.path]]);
    expect(plan.content).not.toMatch(/token/i);
  });

  it('writes a systemd user unit with quoted, escaped words', () => {
    const plan = servicePlan({
      ...base,
      environment: { NOTE: '100% $HOME' },
      platform: 'linux',
      home: '/home/me',
      uid: 1000,
    });
    expect(plan.path).toBe('/home/me/.config/systemd/user/yomi-relay-test.service');
    expect(plan.content).toContain(
      'ExecStart="/opt/node/bin/node" "/Users/me/yomi cli/dist/cli.js" "relay" "--telegram" "--env" "test"',
    );
    // systemd does not expand variables in Environment=, only in ExecStart.
    expect(plan.content).toContain('Environment="NOTE=100%% $HOME"');
    expect(plan.content).toContain('Restart=on-failure');
  });

  it('installs and removes through the runner, leaving the directory mode alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'yomi-home-'));
    const plan = servicePlan({ ...base, platform: 'darwin', home, uid: 501 });
    const ran: string[] = [];
    const run = (command: string, args: string[]) => {
      ran.push([command, ...args].join(' '));
      return { status: 0, output: '' };
    };
    installService(plan, run);
    expect(readFileSync(plan.path, 'utf8')).toBe(plan.content);
    expect(statSync(plan.path).mode & 0o777).toBe(0o644);
    expect(ran).toEqual([
      `launchctl bootout gui/501/${plan.label}`,
      `launchctl bootstrap gui/501 ${plan.path}`,
    ]);
    expect(uninstallService(plan, run)).toBe(true);
    expect(() => statSync(plan.path)).toThrow();
    expect(() =>
      installService(plan, (command, args) => ({
        status: command === 'launchctl' && args[0] === 'bootstrap' ? 5 : 0,
        output: 'Bootstrap failed: 5: Input/output error',
      })),
    ).toThrow(/Bootstrap failed/);
  });
});

describe('reading a secret', () => {
  const io = (stdin: PassThrough, interactive: boolean): Io => ({
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    interactive,
    colour: false,
  });

  it('takes the first line of a piped stdin', async () => {
    const stdin = new PassThrough();
    const pending = readSecret(io(stdin, false), '', { fromStdin: true });
    stdin.write('123456:ABC-def\nignored\n');
    await expect(pending).resolves.toBe('123456:ABC-def');
  });

  it('types without echo on a terminal, with backspace', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        this.isRaw = mode;
        return this;
      },
    });
    const terminal = io(stdin, true);
    let echoed = '';
    terminal.stdout.on('data', (chunk: Buffer) => (echoed += chunk.toString()));
    const pending = readSecret(terminal, 'Token: ', { fromStdin: false });
    stdin.write('12x\u007f3:ab\r');
    await expect(pending).resolves.toBe('123:ab');
    expect(echoed).not.toContain('123');
    expect(stdin.isRaw).toBe(false);
  });

  it('refuses without a terminal unless asked to read stdin', async () => {
    await expect(
      readSecret(io(new PassThrough(), false), '', { fromStdin: false }),
    ).rejects.toThrow(/--token-stdin/);
  });
});

describe('pairing', () => {
  it("counts wrong tries per sender, so a stranger cannot use up the owner's code", () => {
    const code = new PairingCode();
    for (let attempt = 0; attempt < 5; attempt++) expect(code.check('ZZZZZZZZ', 666)).toBe('wrong');
    expect(code.check('ZZZZZZZZ', 666)).toBe('ignored');
    expect(code.check(code.code, 666)).toBe('ignored');
    expect(code.check(code.display.toLowerCase(), 42)).toBe('ok');
  });

  it('expires', () => {
    const code = new PairingCode(0, 1000);
    expect(code.check(code.code, 1, 2000)).toBe('expired');
  });
});

describe('the relay state', () => {
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-relay-state-'));
    const path = relayStatePath('test', '7000000001', dir);
    return { dir, path, state: new RelayState(path, '7000000001', 'test') };
  };
  const paid = { mode: 'paid' as const, budget: 50, spent: 10, setAt: 1 };

  it('starts the budget over for another Yomi account or a new pairing', () => {
    const { state } = fresh();
    state.bindAccount('7300000000000000101');
    state.update({
      billing: paid,
      billingPause: 'budget',
      replies: [[1, '9']],
      owner: { userId: 1, chatId: 1, name: 'a', language: '', pairedAt: 1 },
    });
    expect(state.bindAccount('7300000000000000101')).toBe(false);
    expect(state.data.billing).toEqual(paid);
    expect(state.bindAccount('7300000000000000999')).toBe(true);
    // No budget: Yomi charges by its normal rules until the new owner sets one.
    expect(state.data.billing.mode).toBe('open');
    expect(state.data.billingPause).toBe('');
    expect(state.data.replies).toEqual([]);
    state.update({ billing: paid, replies: [[2, '8']] });
    state.resetOwner();
    expect(state.data.owner).toBeNull();
    expect(state.data.billing.mode).toBe('open');
    expect(state.data.replies).toEqual([]);
  });

  it("keeps the local ceiling's running total until this computer changes it", () => {
    const { state } = fresh();
    state.useAllowance(100, false);
    state.update({ allowance: { ...state.data.allowance, spent: 60 } });
    state.useAllowance(100, false);
    expect(state.data.allowance.spent).toBe(60);
    state.useAllowance(100, true);
    expect(state.data.allowance.spent).toBe(0);
    state.update({ allowance: { ...state.data.allowance, spent: 30 } });
    state.useAllowance(80, false);
    expect(state.data.allowance).toMatchObject({ maxSpend: 80, spent: 0 });
    // Taking the ceiling away is this computer's decision too: the total starts over, once.
    state.update({ allowance: { ...state.data.allowance, spent: 20, unmeasured: 2 } });
    state.useAllowance(null, false);
    expect(state.data.allowance).toMatchObject({ maxSpend: null, spent: 0, unmeasured: 0 });
    state.update({ allowance: { ...state.data.allowance, spent: 15 } });
    state.useAllowance(null, false);
    expect(state.data.allowance).toMatchObject({ maxSpend: null, spent: 15 });
  });

  it('reads a file from before budgets were optional: only the default nobody chose opens up', () => {
    const { path, state } = fresh();
    state.save();
    const read = (stored: object) => {
      writeFileSync(path, JSON.stringify({ version: 1, botId: '7000000001', ...stored }));
      return new RelayState(path, '7000000001', 'test').data;
    };
    // The old default (free-only, never set): no budget now. A pause stays for the relay to
    // weigh against its --max-spend (an old service's 0 keeps it).
    const old = read({
      billing: { mode: 'free', budget: 0, spent: 0, setAt: 0 },
      allowance: { maxSpend: 0, spent: 5, since: 9 },
      billingPause: 'freeCharged',
    });
    expect(old.billing.mode).toBe('open');
    expect(old.billingPause).toBe('freeCharged');
    expect(old.allowance).toEqual({ maxSpend: 0, spent: 5, since: 9, unmeasured: 0 });
    // An explicit /budget off stays free-only; a budget stays a budget, with its pause.
    expect(read({ billing: { mode: 'free', budget: 0, spent: 0, setAt: 7 } }).billing.mode).toBe(
      'free',
    );
    const kept = read({ billing: paid, billingPause: 'budget' });
    expect(kept.billing).toEqual(paid);
    expect(kept.billingPause).toBe('budget');
    // No billing at all reads as no budget; a fresh state has no local ceiling.
    expect(read({}).billing.mode).toBe('open');
    expect(fresh().state.data.allowance).toEqual({
      maxSpend: null,
      spent: 0,
      since: 0,
      unmeasured: 0,
    });
  });

  it("reads an older file: only money pauses carry over; --forget removes this environment's files", () => {
    const { dir, path, state } = fresh();
    state.save();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, botId: '7000000001', paused: 'signedOut', billing: paid }),
    );
    expect(new RelayState(path, '7000000001', 'test').data.billingPause).toBe('');
    writeFileSync(path, JSON.stringify({ version: 1, botId: '7000000001', paused: 'budget' }));
    expect(new RelayState(path, '7000000001', 'test').data.billingPause).toBe('budget');
    const other = new RelayState(relayStatePath('prod', '7000000002', dir), '7000000002', 'prod');
    other.save();
    expect(forgetRelayStates('test', dir)).toBe(1);
    expect(forgetRelayStates('prod', dir)).toBe(1);
  });
});

describe('send outcomes', () => {
  it('names a refusal whatever the HTTP status, and a 429 is not an unknown outcome', () => {
    const named = refusalOf(
      new ApiError(-1, 'HTTP 503', { relay_error: 'CHANNEL_DISABLED' }, 'x', 503),
    );
    expect(named).toBeInstanceOf(ChatRefusal);
    expect((named as ChatRefusal).kind).toBe('disabled');
    const limited = refusalOf(new ApiError(-1, 'HTTP 429', null, 'x', 429));
    expect((limited as ChatRefusal).kind).toBe('rateLimited');
    expect(unknownOutcome(new ApiError(-1, '网络请求失败', null, 'x', 0))).toBe(true);
    expect(unknownOutcome(new ApiError(-1, 'HTTP 502', null, 'x', 502))).toBe(true);
    expect(unknownOutcome(new ApiError(-1, 'HTTP 400', null, 'x', 400))).toBe(false);
    expect(unknownOutcome(new ApiError(1504011011, 'gems', null, 'x', 0))).toBe(false);
  });
});

describe('the money status texts', () => {
  const status = (unmeasured: number): BudgetStatus => ({
    mode: 'open',
    freeOnly: false,
    budget: 0,
    spent: 0,
    total: 12,
    ceiling: null,
    ceilingLeft: Infinity,
    unmeasured,
  });

  it('counts one unmeasured send in the singular and more in the plural', () => {
    const cases: [string, string, string][] = [
      [
        'en',
        'The cost of 1 send could not be measured',
        'The cost of 2 sends could not be measured',
      ],
      ['es', 'No se pudo medir el costo de 1 envío,', 'No se pudo medir el costo de 2 envíos,'],
      [
        'pt',
        'Não foi possível medir o custo de 1 envio,',
        'Não foi possível medir o custo de 2 envios,',
      ],
      ['zh', '另有 1 次发送的花费没能量出', '另有 2 次发送的花费没能量出'],
    ];
    for (const [language, one, two] of cases) {
      const texts = relayTexts(language);
      expect(texts.budgetLine(status(1))).toContain(one);
      expect(texts.budgetLine(status(2))).toContain(two);
      expect(texts.budgetLine(status(0))).not.toMatch(/measured|medir|另有/);
    }
  });
});
