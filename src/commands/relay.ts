import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { describeEnvironment, isProduction, UsageError } from '../core/env.js';
import { configDir, ensurePrivateDir } from '../core/files.js';
import { tr, language } from '../core/i18n.js';
import { acquireProcessLock } from '../core/lock.js';
import { readSecret } from '../core/prompt.js';
import { paint, say, warn } from '../core/ui.js';
import { PairingCode } from '../relay/pairing.js';
import { Relay, RelayStopped } from '../relay/relay.js';
import {
  installService,
  type ServicePlan,
  servicePlan,
  uninstallService,
  runCommand,
} from '../relay/service.js';
import { forgetRelayStates, RelayState, relayStatePath } from '../relay/state.js';
import { BOT_TOKEN, TelegramBot, TelegramError } from '../relay/telegram.js';
import { type Context, requireSignIn } from './context.js';
import { confirmProduction } from './declaration.js';

/**
 * `yomi relay --telegram`: the setup around `Relay` — the bot token (typed without echo or piped
 * on stdin, kept in the keychain, never an argument or variable), the pairing code in this
 * terminal, one relay per bot (a lock file, and Telegram's own 409), the background service.
 */

export type RelayCommandOptions = {
  telegram: boolean;
  setToken: boolean;
  tokenStdin: boolean;
  pair: boolean;
  forget: boolean;
  characterId: string;
  maxSpend: number;
  allowFileStore: boolean;
  installService: boolean;
  uninstallService: boolean;
  serviceStatus: boolean;
  replyTimeoutMs: number;
  drafts: boolean;
  confirmProd: boolean;
  /** Start the local ceiling's running total over. */
  resetSpend: boolean;
};

/** Settings a background relay needs (never tokens); YOMI_CONFIG_DIR is always set. */
const SERVICE_ENVIRONMENT = [
  'YOMI_TEST_API_ORIGIN',
  'YOMI_TEST_WEB_ORIGIN',
  'YOMI_LANG',
  'LANG',
  'YOMI_API_ORIGIN',
  'YOMI_WEB_ORIGIN',
  'YOMI_CREDENTIAL_STORE',
  'YOMI_TELEGRAM_API_ORIGIN',
];

const tokenName = (context: Context) => `telegram-bot:${context.account}`;

function planFor(context: Context, options: RelayCommandOptions): ServicePlan {
  const script = realpathSync(process.argv[1] ?? '');
  const args = ['relay', '--telegram', '--env', context.env.name];
  if (context.env.lane) args.push('--lane', context.env.lane);
  if (options.allowFileStore) args.push('--allow-file-store');
  args.push('--max-spend', String(options.maxSpend));
  if (options.characterId) args.push('--character', options.characterId);
  if (!options.drafts) args.push('--no-drafts');
  // Confirmed when the service was installed; a service has nobody to ask.
  if (isProduction(context.env)) args.push('--confirm-prod');
  // The resolved directory, so the service finds the same pairing, lock and file store even when
  // XDG_CONFIG_HOME or HOME differ under launchd/systemd.
  const environment: Record<string, string> = { YOMI_CONFIG_DIR: configDir() };
  for (const key of SERVICE_ENVIRONMENT) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return servicePlan({
    account: context.account,
    node: process.execPath,
    script,
    args,
    environment,
    logDir: join(configDir(), 'logs'),
  });
}

async function askToken(context: Context, fromStdin: boolean): Promise<string> {
  const { io } = context;
  if (!fromStdin)
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '在 Telegram 的 @BotFather 里新建一个 bot（/newbot），把它给的 token 粘贴到这里（不会显示）。',
          'Create a bot with @BotFather in Telegram (/newbot) and paste the token it gives you here (it will not be shown).',
          'Crea un bot con @BotFather en Telegram (/newbot) y pega aquí el token que te dé (no se mostrará).',
          'Crie um bot com o @BotFather no Telegram (/newbot) e cole aqui o token que ele fornecer (ele não será exibido).',
        ),
      ),
    );
  const token = await readSecret(io, 'Bot token: ', { fromStdin });
  if (!BOT_TOKEN.test(token))
    throw new UsageError(
      tr(
        '这不像是 bot token（应为 123456789:AA… 的形式）',
        'This does not look like a bot token (it should look like 123456789:AA…)',
        'Esto no parece un token de bot (debería verse como 123456789:AA…)',
        'Isto não parece um token de bot (deveria ser como 123456789:AA…)',
      ),
    );
  return token;
}

async function verifiedBot(token: string) {
  const bot = new TelegramBot(token, { apiOrigin: process.env.YOMI_TELEGRAM_API_ORIGIN });
  try {
    const me = await bot.getMe();
    return { bot, me };
  } catch (error) {
    if (error instanceof TelegramError && error.unauthorized)
      throw new UsageError(
        tr(
          'Telegram 不认这个 token：确认是 BotFather 给的、没有在 /revoke 后失效。',
          'Telegram does not accept this token: check that it came from BotFather and was not invalidated with /revoke.',
          'Telegram no acepta este token: comprueba que venga de BotFather y que no se haya invalidado con /revoke.',
          'O Telegram não aceita este token: verifique se ele veio do BotFather e se não foi invalidado com /revoke.',
        ),
      );
    throw error;
  }
}

function printPairing(context: Context, code: PairingCode, username: string) {
  const { io } = context;
  say(io);
  say(
    io,
    tr(
      `在 Telegram 里打开 @${username}，发送：`,
      `Open @${username} in Telegram and send:`,
      `Abre @${username} en Telegram y envía:`,
      `Abra @${username} no Telegram e envie:`,
    ),
  );
  say(io, `  ${paint(io, 'bold', `/start ${code.code}`)}`);
  say(
    io,
    tr(
      `或直接打开：${code.link(username)}`,
      `Or open: ${code.link(username)}`,
      `O abre: ${code.link(username)}`,
      `Ou abra: ${code.link(username)}`,
    ),
  );
  say(
    io,
    paint(
      io,
      'dim',
      tr(
        '配对码 15 分钟内有效、只能用一次，只显示在这个终端里：不要发给别人。',
        'The pairing code is valid for 15 minutes, works once and is shown only in this terminal: do not send it to anyone.',
        'El código de vinculación es válido durante 15 minutos, funciona una sola vez y solo se muestra en esta terminal: no se lo envíes a nadie.',
        'O código de pareamento vale por 15 minutos, funciona uma única vez e só aparece neste terminal: não o envie para ninguém.',
      ),
    ),
  );
  say(io);
}

export async function relay(context: Context, options: RelayCommandOptions) {
  const { io, store } = context;
  if (!options.telegram)
    throw new UsageError(
      tr(
        '目前只支持 Telegram：yomi relay --telegram',
        'Only Telegram is supported for now: yomi relay --telegram',
        'Por ahora solo se admite Telegram: yomi relay --telegram',
        'Por enquanto, só o Telegram é suportado: yomi relay --telegram',
      ),
    );
  // Taking things away works without a keychain too.
  if (options.uninstallService) {
    const plan = planFor(context, options);
    const removed = uninstallService(plan);
    say(
      io,
      removed
        ? tr(
            `已停止并删除后台服务（${plan.path}）`,
            `Stopped and removed the background service (${plan.path})`,
            `Se detuvo y se eliminó el servicio en segundo plano (${plan.path})`,
            `O serviço em segundo plano foi parado e removido (${plan.path})`,
          )
        : tr(
            '没有安装后台服务。',
            'No background service is installed.',
            'No hay ningún servicio en segundo plano instalado.',
            'Nenhum serviço em segundo plano está instalado.',
          ),
    );
    return;
  }
  if (options.serviceStatus) {
    const plan = planFor(context, options);
    if (!existsSync(plan.path))
      return void say(
        io,
        tr(
          '没有安装后台服务。',
          'No background service is installed.',
          'No hay ningún servicio en segundo plano instalado.',
          'Nenhum serviço em segundo plano está instalado.',
        ),
      );
    const [command, ...args] = plan.status;
    const result = runCommand(command, args);
    say(
      io,
      result.output ||
        tr(
          `${plan.label}：没有运行`,
          `${plan.label}: not running`,
          `${plan.label}: no está en ejecución`,
          `${plan.label}: não está em execução`,
        ),
    );
    return;
  }
  if (options.forget) {
    const token = store.getSecret(tokenName(context));
    if (token && BOT_TOKEN.test(token)) {
      const lock = acquireProcessLock(
        join(configDir(), 'locks', `relay-${token.split(':')[0]}.lock`),
      );
      if ('heldBy' in lock)
        throw new UsageError(
          tr(
            `relay 正在运行${lock.heldBy ? `（进程 ${lock.heldBy}）` : ''}：先停止它（Ctrl+C，或 --uninstall-service），再 --forget。`,
            `Relay is running${lock.heldBy ? ` (process ${lock.heldBy})` : ''}: stop it first (Ctrl+C, or --uninstall-service), then --forget.`,
            `El relay está en ejecución${lock.heldBy ? ` (proceso ${lock.heldBy})` : ''}: detenlo primero (Ctrl+C o --uninstall-service) y luego usa --forget.`,
            `O relay está em execução${lock.heldBy ? ` (processo ${lock.heldBy})` : ''}: pare-o primeiro (Ctrl+C ou --uninstall-service) e depois use --forget.`,
          ),
        );
      lock.release();
    }
    const plan = planFor(context, options);
    if (existsSync(plan.path)) {
      uninstallService(plan);
      say(
        io,
        tr(
          `已停止并删除后台服务（${plan.path}）`,
          `Stopped and removed the background service (${plan.path})`,
          `Se detuvo y se eliminó el servicio en segundo plano (${plan.path})`,
          `O serviço em segundo plano foi parado e removido (${plan.path})`,
        ),
      );
    }
    const states = forgetRelayStates(context.account);
    const removed = store.deleteSecret(tokenName(context));
    say(
      io,
      removed || states
        ? tr(
            `已删除本机保存的 bot token 和配对信息（${states} 份）。`,
            `Deleted the bot token and pairing info saved on this machine (${states} record(s)).`,
            `Se eliminaron el token del bot y los datos de vinculación guardados en este equipo (${states} registro(s)).`,
            `O token do bot e os dados de pareamento salvos nesta máquina foram excluídos (${states} registro(s)).`,
          )
        : tr(
            '本机没有保存 bot token 或配对信息。',
            'No bot token or pairing info is saved on this machine.',
            'No hay ningún token de bot ni datos de vinculación guardados en este equipo.',
            'Não há token de bot nem dados de pareamento salvos nesta máquina.',
          ),
    );
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '如果 token 可能泄露，请在 @BotFather 里用 /revoke 让它失效。',
          'If the token may have leaked, invalidate it with /revoke in @BotFather.',
          'Si el token pudo haberse filtrado, invalídalo con /revoke en @BotFather.',
          'Se o token pode ter vazado, invalide-o com /revoke no @BotFather.',
        ),
      ),
    );
    return;
  }

  if (store.kind === 'file' && !options.allowFileStore)
    throw new UsageError(
      tr(
        '这台机器没有可用的系统钥匙串，relay 默认不启动（bot token 和会话会以明文文件保存）。确认接受时加 --allow-file-store。',
        'This machine has no system keychain available, so relay does not start by default (the bot token and session would be saved in plain-text files). To accept that, add --allow-file-store.',
        'Este equipo no tiene un llavero del sistema disponible, así que relay no se inicia de forma predeterminada (el token del bot y la sesión se guardarían en archivos de texto sin cifrar). Para aceptarlo, agrega --allow-file-store.',
        'Esta máquina não tem um Keychain do sistema disponível, então o relay não inicia por padrão (o token do bot e a sessão seriam salvos em arquivos de texto sem criptografia). Para aceitar isso, adicione --allow-file-store.',
      ),
    );

  if (options.setToken) {
    const token = await askToken(context, options.tokenStdin);
    const { me } = await verifiedBot(token);
    store.setSecret(tokenName(context), token);
    say(
      io,
      tr(
        `已保存 @${me.username ?? me.first_name} 的 token（${store.kind === 'file' ? '本地文件 0600' : '系统钥匙串'}）。`,
        `Saved the token for @${me.username ?? me.first_name} (${store.kind === 'file' ? 'local file, mode 0600' : 'system keychain'}).`,
        `Se guardó el token de @${me.username ?? me.first_name} (${store.kind === 'file' ? 'archivo local, permisos 0600' : 'llavero del sistema'}).`,
        `Token de @${me.username ?? me.first_name} salvo (${store.kind === 'file' ? 'arquivo local, modo 0600' : 'Keychain do sistema'}).`,
      ),
    );
    say(
      io,
      tr(
        '接下来运行 yomi relay --telegram，在 Telegram 里完成配对。',
        'Next, run yomi relay --telegram and finish pairing in Telegram.',
        'A continuación, ejecuta yomi relay --telegram y completa la vinculación en Telegram.',
        'Em seguida, execute yomi relay --telegram e conclua o pareamento no Telegram.',
      ),
    );
    return;
  }

  const credential = requireSignIn(context);
  if (
    !(await confirmProduction(
      context,
      tr(
        '把 Telegram 私聊转给角色（会使用真实账号的免费额度和钻石）',
        "forward Telegram private chats to a character (uses the real account's free messages and gems)",
        'reenviar los chats privados de Telegram a un personaje (usa los mensajes gratis y las gemas de la cuenta real)',
        'encaminhar os chats privados do Telegram para um personagem (usa as mensagens grátis e as gemas da conta real)',
      ),
      options.confirmProd,
    ))
  )
    return;
  let token = store.getSecret(tokenName(context));
  if (!token) {
    if (!io.interactive && !options.tokenStdin) {
      // A service restarting would not fix this: say so and end without failing.
      warn(
        io,
        tr(
          '还没有设置 bot token：先运行 yomi relay --telegram --set-token',
          'No bot token set yet: run yomi relay --telegram --set-token first',
          'Todavía no hay un token de bot configurado: ejecuta primero yomi relay --telegram --set-token',
          'Ainda não há token de bot configurado: execute primeiro yomi relay --telegram --set-token',
        ),
      );
      return;
    }
    token = await askToken(context, options.tokenStdin);
    await verifiedBot(token);
    store.setSecret(tokenName(context), token);
  }
  let verified;
  try {
    verified = await verifiedBot(token);
  } catch (error) {
    if (!io.interactive && error instanceof UsageError) {
      warn(io, error.message);
      return;
    }
    throw error;
  }
  const { bot, me } = verified;
  const username = me.username ?? '';
  const state = new RelayState(relayStatePath(context.account, bot.id), bot.id, context.account);

  if (options.installService) {
    if (!state.data.owner)
      throw new UsageError(
        tr(
          '还没有配对：先在终端里运行一次 yomi relay --telegram 完成配对，再安装后台服务。',
          'Not paired yet: run yomi relay --telegram once in a terminal to pair, then install the background service.',
          'Todavía no está vinculado: ejecuta yomi relay --telegram una vez en una terminal para vincularlo y luego instala el servicio en segundo plano.',
          'Ainda não pareado: execute yomi relay --telegram uma vez em um terminal para parear e depois instale o serviço em segundo plano.',
        ),
      );
    const plan = planFor(context, options);
    if (/[\\/](_npx|\.npm|tmp|temp)[\\/]/i.test(plan.content))
      warn(
        io,
        tr(
          '当前 yomi 像是从临时目录运行的（npx 或缓存），后台服务可能在缓存清理后失效：建议全局安装后再装服务。',
          'This yomi seems to run from a temporary directory (npx or a cache), so the background service may break when the cache is cleaned: install yomi globally before installing the service.',
          'Este yomi parece ejecutarse desde un directorio temporal (npx o una caché), así que el servicio en segundo plano podría dejar de funcionar cuando se limpie la caché: instala yomi de forma global antes de instalar el servicio.',
          'Este yomi parece estar sendo executado de um diretório temporário (npx ou um cache), então o serviço em segundo plano pode parar de funcionar quando o cache for limpo: instale o yomi globalmente antes de instalar o serviço.',
        ),
      );
    ensurePrivateDir(join(configDir(), 'logs'));
    installService(plan);
    say(
      io,
      tr(
        `已安装并启动后台服务：${plan.path}`,
        `Installed and started the background service: ${plan.path}`,
        `Se instaló e inició el servicio en segundo plano: ${plan.path}`,
        `Serviço em segundo plano instalado e iniciado: ${plan.path}`,
      ),
    );
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          `日志：${join(configDir(), 'logs')}；停止并删除：yomi relay --telegram --uninstall-service`,
          `Logs: ${join(configDir(), 'logs')}; to stop and remove: yomi relay --telegram --uninstall-service`,
          `Registros: ${join(configDir(), 'logs')}; para detenerlo y eliminarlo: yomi relay --telegram --uninstall-service`,
          `Logs: ${join(configDir(), 'logs')}; para parar e remover: yomi relay --telegram --uninstall-service`,
        ),
      ),
    );
    if (plan.platform === 'linux')
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            '退出登录后也要运行：loginctl enable-linger（需要时）。',
            'To keep it running after you log out: loginctl enable-linger (if needed).',
            'Para que siga en ejecución después de cerrar sesión: loginctl enable-linger (si hace falta).',
            'Para mantê-lo em execução depois de sair da sessão: loginctl enable-linger (se necessário).',
          ),
        ),
      );
    return;
  }

  const lock = acquireProcessLock(join(configDir(), 'locks', `relay-${bot.id}.lock`));
  if ('heldBy' in lock)
    throw new UsageError(
      tr(
        `这个 bot 已经有一个 relay 在运行${lock.heldBy ? `（进程 ${lock.heldBy}）` : ''}。同一个 bot 只能运行一个。`,
        `A relay is already running for this bot${lock.heldBy ? ` (process ${lock.heldBy})` : ''}. Only one can run per bot.`,
        `Ya hay un relay en ejecución para este bot${lock.heldBy ? ` (proceso ${lock.heldBy})` : ''}. Solo puede ejecutarse uno por bot.`,
        `Já existe um relay em execução para este bot${lock.heldBy ? ` (processo ${lock.heldBy})` : ''}. Só é possível executar um por bot.`,
      ),
    );
  try {
    // Another person may pair now: their consent to spend starts over.
    if (options.pair) state.resetOwner();
    let pairing: PairingCode | null = null;
    if (!state.data.owner) {
      // The code is shown only to someone at this terminal, never in a service log.
      if (!io.interactive && !options.pair) {
        warn(
          io,
          tr(
            '还没有配对：请在终端里运行一次 yomi relay --telegram，按提示在 Telegram 里发送配对码。',
            'Not paired yet: run yomi relay --telegram once in a terminal and send the pairing code in Telegram as prompted.',
            'Todavía no está vinculado: ejecuta yomi relay --telegram una vez en una terminal y envía el código de vinculación en Telegram según las indicaciones.',
            'Ainda não pareado: execute yomi relay --telegram uma vez em um terminal e envie o código de pareamento no Telegram conforme indicado.',
          ),
        );
        return;
      }
      pairing = new PairingCode();
      printPairing(context, pairing, username);
    }
    say(
      io,
      tr(
        `relay 运行中：@${username} ⇄ Yomi ${credential.displayName || credential.userId}（${describeEnvironment(context.env)}）`,
        `Relay running: @${username} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
        `Relay en ejecución: @${username} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
        `Relay em execução: @${username} ⇄ Yomi ${credential.displayName || credential.userId} (${describeEnvironment(context.env)})`,
      ),
    );
    say(
      io,
      paint(
        io,
        'dim',
        (options.maxSpend
          ? tr(
              `本机允许 relay 最多花 ${options.maxSpend} 钻石（累计；--reset-spend 重新计算）。`,
              `Local spending cap: relay may spend up to ${options.maxSpend} gems in total on this machine (--reset-spend starts the count over). `,
              `Límite de gasto local: relay puede gastar hasta ${options.maxSpend} gemas en total en este equipo (--reset-spend reinicia el conteo). `,
              `Limite de gastos local: o relay pode gastar até ${options.maxSpend} gemas no total nesta máquina (--reset-spend zera a contagem). `,
            )
          : tr(
              '本机不允许 relay 花钻石（要允许，用 --max-spend <数量> 启动）。服务端支持「只用免费额度」之前，这样不会发出任何消息。',
              'Local spending cap: 0, so relay spends no gems (to allow spending, start with --max-spend <amount>). Until the server supports "free messages only", no messages are sent in this setup. ',
              'Límite de gasto local: 0, así que relay no gasta gemas (para permitir el gasto, inicia con --max-spend <cantidad>). Hasta que el servidor admita "solo mensajes gratis", con esta configuración no se envía ningún mensaje. ',
              'Limite de gastos local: 0, então o relay não gasta gemas (para permitir gastos, inicie com --max-spend <quantidade>). Até o servidor oferecer suporte a "só mensagens grátis", nenhuma mensagem é enviada nesta configuração. ',
            )) +
          tr(
            'Ctrl+C 停止。',
            'Press Ctrl+C to stop.',
            'Presiona Ctrl+C para detener.',
            'Pressione Ctrl+C para parar.',
          ),
      ),
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const engine = new Relay(context.gateway, bot, state, {
      maxSpend: options.maxSpend,
      resetSpend: options.resetSpend,
      characterId: options.characterId,
      pairing,
      onPairingCode: (code) => {
        say(
          io,
          paint(
            io,
            'yellow',
            tr(
              '配对码已过期，新的配对码：',
              'The pairing code expired. New pairing code:',
              'El código de vinculación expiró. Nuevo código de vinculación:',
              'O código de pareamento expirou. Novo código de pareamento:',
            ),
          ),
        );
        printPairing(context, code, username);
      },
      replyTimeoutMs: options.replyTimeoutMs,
      intervalMs: 1000,
      staleMs: 10 * 60 * 1000,
      pollTimeoutSeconds: 25,
      drafts: options.drafts,
      // what the relay says in Telegram: the CLI's own language (zh, en, es or pt)
      language: language(),
      log: (line) => io.stderr.write(`${new Date().toISOString()} ${line}\n`),
    });
    try {
      await engine.run(controller.signal);
    } catch (error) {
      // Conditions a restart cannot fix: say why and end without failing, so a service stays down.
      if (error instanceof RelayStopped) {
        warn(io, error.message);
        return;
      }
      throw error;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    say(io, tr('relay 已停止。', 'Relay stopped.', 'El relay se detuvo.', 'O relay parou.'));
  } finally {
    lock.release();
  }
}
