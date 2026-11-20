import { UsageError } from '../../core/env.js';
import { tr } from '../../core/i18n.js';
import { terminalText } from '../../core/ui.js';
import { GUIDE_TIMINGS, GuideCancelled, type GuideUi } from '../guide/steps.js';
import { type QqApi, QqError } from './qq-api.js';
import { probeGatewayDetail } from './qq-gateway.js';

/**
 * QQ's part of `yomi relay --setup` (commands/relay-setup.ts): what to do on q.qq.com, step by
 * step and with QQ's own links (create the bot, copy its AppID and AppSecret, add it as a friend,
 * reset its AppSecret), the AppID and AppSecret typed and checked with QQ, and the one check of
 * the gateway that the bot receives private chats, within QQ's daily connections. The console's
 * names are QQ's Chinese ones in every language (`QQ_CONSOLE_ZH`), with a translation after them
 * outside Chinese: the console has no other language to point at.
 */

/** The names QQ's console shows (q.qq.com), as it shows them; translated beside them elsewhere. */
export const QQ_CONSOLE_ZH = {
  bots: '「机器人」',
  createOrManage: '「去创建或管理我的 QQ 机器人」',
  createBot: '「+ 创建机器人」',
  createButton: '「创建机器人」',
  aiService: '「设置 AI 服务」',
  manualBinding: '「手动绑定参数」',
  later: '「稍后连接」',
  scanToChat: '「扫码对话」',
  devSettings: '「开发设置」',
  credentials: '「APPID 接入凭证」',
  eventSubscription: '「事件订阅与回调地址」',
  websocket: '「当前以 WebSocket 方式接收事件推送」',
  ipWhitelist: '「服务器 IP 白名单」',
  friendScope: '「服务范围 → 好友（私聊） → 允许被其他 QQ 用户添加使用」',
  testAccounts: '「开发设置 → 开发体验号码设置」',
  addUser: '「+ 添加用户」',
  online: '「在线」',
  mars: '「该机器人去火星了」',
} as const;

const Z = QQ_CONSOLE_ZH;

/** QQ's official pages the guide points to. */
export const QQ_LINKS = {
  console: 'https://q.qq.com/#/apps',
  rules: 'https://bot.q.qq.com/wiki/business/',
  create: 'https://bot.q.qq.com/wiki/#_3-%E5%88%9B%E5%BB%BA%E6%9C%BA%E5%99%A8%E4%BA%BA',
  testAccounts:
    'https://bot.q.qq.com/wiki/#_8-3-%E5%86%85%E9%83%A8%E4%BD%93%E9%AA%8C%E5%8F%B7%E7%A0%81',
  ipWhitelist:
    'https://bot.q.qq.com/wiki/#_8-2-%E6%9C%8D%E5%8A%A1%E5%99%A8-ip-%E7%99%BD%E5%90%8D%E5%8D%95',
  faq: 'https://bot.q.qq.com/wiki/bot_FAQ/',
  restore: 'https://q.qq.com/qqbot/openclaw/',
} as const;

export type QqApp = { appId: string; secret: string };

/** How many times one run may ask QQ for a token with what was typed. */
export const TOKEN_CHECKS_MAX = 5;

/** Step 2: creating the bot on q.qq.com (or checking one that exists). */
export function createLines(): string[] {
  return [
    tr(
      '建议新建一个只给 relay 用的机器人。',
      'Best: create a new bot used only by relay.',
      'Lo mejor: crea un bot nuevo que use solo relay.',
      'O melhor: crie um bot novo usado só pelo relay.',
    ),
    tr(
      `1. 用你自己的 QQ 登录 QQ 开放平台：${QQ_LINKS.console}`,
      `1. Sign in to the QQ Open Platform with your own QQ: ${QQ_LINKS.console}`,
      `1. Inicia sesión en la QQ Open Platform con tu propia cuenta de QQ: ${QQ_LINKS.console}`,
      `1. Entre na QQ Open Platform com a sua própria conta do QQ: ${QQ_LINKS.console}`,
    ),
    tr(
      `2. 在${Z.bots}页点${Z.createOrManage}，再点${Z.createBot}。`,
      `2. On ${Z.bots} (Bots) click ${Z.createOrManage} (create or manage my QQ bots), then ${Z.createBot} (+ Create bot).`,
      `2. En ${Z.bots} (Bots), haz clic en ${Z.createOrManage} (crear o administrar mis bots de QQ) y luego en ${Z.createBot} (+ Crear bot).`,
      `2. Em ${Z.bots} (Bots), clique em ${Z.createOrManage} (criar ou gerenciar meus bots do QQ) e depois em ${Z.createBot} (+ Criar bot).`,
    ),
    tr(
      `3. 填头像、昵称和简介（以后都能改），点${Z.createButton}。不要冒用别人的名字或头像（运营规范：${QQ_LINKS.rules}）。认证过的个人最多可以建 5 个；平台要求认证时，按它的提示做。`,
      `3. Fill in the avatar, nickname and introduction (all can be changed later) and click ${Z.createButton} (Create bot). Don't use someone else's name or picture (operating rules: ${QQ_LINKS.rules}). A verified individual can create up to 5 bots; if the platform asks for verification, follow its steps.`,
      `3. Completa el avatar, el apodo y la presentación (todo se puede cambiar después) y haz clic en ${Z.createButton} (Crear bot). No uses el nombre ni la foto de otra persona (normas de uso: ${QQ_LINKS.rules}). Una persona verificada puede crear hasta 5 bots; si la plataforma pide una verificación, sigue sus pasos.`,
      `3. Preencha o avatar, o apelido e a apresentação (tudo pode ser mudado depois) e clique em ${Z.createButton} (Criar bot). Não use o nome nem a foto de outra pessoa (regras de uso: ${QQ_LINKS.rules}). Uma pessoa verificada pode criar até 5 bots; se a plataforma pedir uma verificação, siga as instruções dela.`,
    ),
    tr(
      `4. 创建后会进入${Z.aiService}页。不要在这页连接别的 AI 服务：同一个机器人接到两处，消息会被那边收走。下一步要从这页复制参数，先别离开。`,
      `4. You land on ${Z.aiService} (Set up AI service). Don't connect another AI service there: a bot connected in two places loses messages to the other one. Stay on this page; the next step copies from it.`,
      `4. Llegas a ${Z.aiService} (Configurar servicio de IA). No conectes otro servicio de IA ahí: si un bot está conectado en dos lugares, el otro se queda con los mensajes. Quédate en esta página; el siguiente paso copia datos de ella.`,
      `4. Você chega em ${Z.aiService} (Configurar serviço de IA). Não conecte outro serviço de IA ali: um bot conectado em dois lugares perde mensagens para o outro. Fique nesta página; o próximo passo copia dados dela.`,
    ),
    tr(
      `已经有机器人：打开它的${Z.devSettings}，确认三件事：`,
      `Already have a bot: open its ${Z.devSettings} (Development settings) and check three things:`,
      `Si ya tienes un bot: abre su ${Z.devSettings} (Configuración de desarrollo) y revisa tres cosas:`,
      `Se você já tem um bot: abra ${Z.devSettings} (Configurações de desenvolvimento) e confira três coisas:`,
    ),
    tr(
      '  · 它没有接别的 AI 服务或程序（之后查看或重置 AppSecret，那边也会失效）；',
      '  · it is not connected to another AI service or program (viewing or resetting the AppSecret later breaks that one);',
      '  · no está conectado a otro servicio de IA ni a otro programa (ver o restablecer el AppSecret después hace que deje de funcionar allí);',
      '  · ele não está conectado a outro serviço de IA nem a outro programa (ver ou redefinir o AppSecret depois faz o outro parar de funcionar);',
    ),
    tr(
      `  · ${Z.eventSubscription}写的是${Z.websocket}；`,
      `  · ${Z.eventSubscription} (Event subscription) says it receives events over WebSocket;`,
      `  · ${Z.eventSubscription} (Suscripción de eventos) dice que recibe los eventos por WebSocket;`,
      `  · ${Z.eventSubscription} (Assinatura de eventos) diz que recebe os eventos por WebSocket;`,
    ),
    tr(
      `  · ${Z.ipWhitelist}是空的（空表示不限制），或者里面有这台电脑现在的公网 IPv4（家里的 IP 会变）。`,
      `  · ${Z.ipWhitelist} (Server IP whitelist) is empty (no limit), or lists this computer's current public IPv4 (a home IP changes).`,
      `  · ${Z.ipWhitelist} (Lista blanca de IP del servidor) está vacía (sin límite), o incluye la IPv4 pública actual de este equipo (la IP de casa cambia).`,
      `  · ${Z.ipWhitelist} (Lista de permissões de IP do servidor) está vazia (sem limite), ou inclui o IPv4 público atual deste computador (o IP de casa muda).`,
    ),
    tr(
      `${Z.friendScope}保持关闭（默认就是关闭的），这样只有你能加它。`,
      `Keep ${Z.friendScope} (let other QQ users add it) off, as it is by default, so only you can add the bot.`,
      `Deja ${Z.friendScope} (permitir que otros usuarios de QQ lo agreguen) desactivado, como viene por defecto, para que solo tú puedas agregar el bot.`,
      `Deixe ${Z.friendScope} (permitir que outros usuários do QQ o adicionem) desativado, como vem por padrão, para que só você possa adicionar o bot.`,
    ),
    tr(
      `说明：${QQ_LINKS.create}`,
      `Guide: ${QQ_LINKS.create}`,
      `Guía: ${QQ_LINKS.create}`,
      `Guia: ${QQ_LINKS.create}`,
    ),
  ];
}

/** Step 3: where the AppID and AppSecret are, and what the AppSecret is. `appId`: known already. */
export function credentialsLines(appId: string): string[] {
  const where = appId
    ? tr(
        `AppID 用登记的 ${appId}，只需要 AppSecret：在这个机器人的${Z.devSettings} → ${Z.credentials}里查看或重置。`,
        `The AppID is the registered ${appId}; only the AppSecret is needed: view or reset it under ${Z.credentials} (AppID credentials) in the bot's ${Z.devSettings} (Development settings).`,
        `El AppID es el registrado, ${appId}; solo hace falta el AppSecret: míralo o restablécelo en ${Z.credentials} (Credenciales del AppID), dentro de ${Z.devSettings} (Configuración de desarrollo) del bot.`,
        `O AppID é o registrado, ${appId}; só falta o AppSecret: veja ou redefina em ${Z.credentials} (Credenciais do AppID), dentro de ${Z.devSettings} (Configurações de desenvolvimento) do bot.`,
      )
    : tr(
        `在${Z.aiService} → ${Z.manualBinding}里复制（已有的机器人在${Z.devSettings} → ${Z.credentials}里）。两项都复制好以后，回到那页点${Z.later}。`,
        `Copy them from ${Z.manualBinding} (Manual binding parameters) on ${Z.aiService} (an existing bot: ${Z.credentials} (AppID credentials) under ${Z.devSettings}). When both are copied, click ${Z.later} (Later) on that page.`,
        `Cópialos de ${Z.manualBinding} (Parámetros de vinculación manual) en ${Z.aiService} (un bot que ya existe: ${Z.credentials} (Credenciales del AppID), dentro de ${Z.devSettings}). Cuando tengas los dos, haz clic en ${Z.later} (Más tarde) en esa página.`,
        `Copie de ${Z.manualBinding} (Parâmetros de vinculação manual) em ${Z.aiService} (um bot que já existe: ${Z.credentials} (Credenciais do AppID), dentro de ${Z.devSettings}). Quando tiver os dois, clique em ${Z.later} (Mais tarde) nessa página.`,
      );
  return [
    where,
    tr(
      'AppSecret 相当于密码：只粘贴在下面的 AppSecret 提示里，输入时不显示，也不写进日志。QQ 的旧页面写明，再次查看 AppSecret 会强制重置它，新控制台可能也是这样：如果你又看了一次，就用新的那个。',
      "The AppSecret is a password: paste it only at the AppSecret prompt below. It is not shown as you type and never logged. QQ's older page says viewing the AppSecret again resets it, and the new console may do the same: if you viewed it again, use the new one.",
      'El AppSecret es una contraseña: pégalo solo en la solicitud del AppSecret de abajo. No se muestra al escribirlo y nunca se registra. La página antigua de QQ dice que ver el AppSecret otra vez lo restablece, y la consola nueva puede hacer lo mismo: si lo volviste a ver, usa el nuevo.',
      'O AppSecret é uma senha: cole-o só no pedido do AppSecret abaixo. Ele não aparece enquanto você digita e nunca vai para os logs. A página antiga do QQ diz que ver o AppSecret de novo o redefine, e o console novo pode fazer o mesmo: se você o viu de novo, use o novo.',
    ),
  ];
}

/**
 * Step 3's other way to the AppID and AppSecret, Tencent's QR connector (scan with QQ on the
 * phone, choose the bot): not in this version, so always 'manual' (they are typed).
 */
export async function scannedApp(): Promise<QqApp | 'manual'> {
  return 'manual';
}

/**
 * The AppID (unless `appId` is known: a bot set again) and the AppSecret, each asked again until it
 * looks right; nothing is asked of QQ. `previous`: an AppID that Enter keeps (after QQ refused the
 * pair).
 */
export async function askApp(ui: GuideUi, appId: string, previous = ''): Promise<QqApp> {
  let id = appId;
  let prompt = previous
    ? tr(
        `AppID（只显示数字；直接回车沿用 ${previous}）：`,
        `AppID (only digits are shown; Enter keeps ${previous}):`,
        `AppID (solo se muestran los dígitos; Enter mantiene ${previous}):`,
        `AppID (só os dígitos aparecem; Enter mantém ${previous}):`,
      )
    : tr(
        'AppID（只显示数字）：',
        'AppID (only digits are shown):',
        'AppID (solo se muestran los dígitos):',
        'AppID (só os dígitos aparecem):',
      );
  while (!id) {
    const typed = await ui.masked(prompt);
    if (!typed && previous) id = previous;
    else if (/^[0-9]{5,20}$/.test(typed)) id = typed;
    else
      prompt = tr(
        '这不像 QQ 机器人的 AppID（5 到 20 位数字）。再输一次：',
        "That doesn't look like a QQ bot AppID (5 to 20 digits). Try again:",
        'Eso no parece el AppID de un bot de QQ (de 5 a 20 dígitos). Inténtalo de nuevo:',
        'Isso não parece o AppID de um bot do QQ (de 5 a 20 dígitos). Tente de novo:',
      );
  }
  prompt = tr(
    'AppSecret（输入时不显示）：',
    'AppSecret (not shown as you type):',
    'AppSecret (no se muestra al escribirlo):',
    'AppSecret (não aparece enquanto você digita):',
  );
  for (;;) {
    const secret = await ui.hidden(prompt);
    if (/^[\x21-\x7e]{8,128}$/.test(secret)) return { appId: id, secret };
    prompt = tr(
      '这不像 AppSecret（8 到 128 个字母、数字或符号，不能有空格）。再输一次：',
      "That doesn't look like an AppSecret (8 to 128 letters, digits or symbols, no spaces). Try again:",
      'Eso no parece un AppSecret (de 8 a 128 letras, dígitos o símbolos, sin espacios). Inténtalo de nuevo:',
      'Isso não parece um AppSecret (de 8 a 128 letras, dígitos ou símbolos, sem espaços). Tente de novo:',
    );
  }
}

export const checkingText = () =>
  tr('正在向 QQ 核对……', 'Checking with QQ…', 'Verificando con QQ…', 'Verificando com o QQ…');

/** QQ accepted the AppID and AppSecret: the bot as QQ names it. */
export function acceptedText(name: string, appId: string): string {
  const shown = terminalText(name);
  return shown
    ? tr(
        `QQ 接受了：机器人「${shown}」（AppID ${appId}）`,
        `QQ accepted them: bot "${shown}" (AppID ${appId})`,
        `QQ los aceptó: bot "${shown}" (AppID ${appId})`,
        `O QQ aceitou: bot "${shown}" (AppID ${appId})`,
      )
    : tr(
        `QQ 接受了（AppID ${appId}）`,
        `QQ accepted them (AppID ${appId})`,
        `QQ los aceptó (AppID ${appId})`,
        `O QQ aceitou (AppID ${appId})`,
      );
}

/**
 * What QQ's refusal of a token means in the guide (design §3.1), never with what was typed:
 * `next` 'reenter' (the AppID and AppSecret again) or 'retry' (Enter asks again, q quits);
 * `failed`: said as a failure (✗), else as a wait.
 */
export function tokenProblem(error: unknown): {
  text: string;
  next: 'reenter' | 'retry';
  failed: boolean;
} {
  const code = error instanceof QqError ? error.code : 0;
  const reason = error instanceof QqError ? error.reason : 'transient';
  const status = error instanceof QqError ? error.status : 0;
  if (reason === 'unauthorized')
    return {
      text: tr(
        `QQ 不接受这对 AppID 和 AppSecret${code ? `（${code}）` : ''}。AppID 是${Z.credentials}里那串数字；复制 AppSecret 时别带空格；如果在控制台又看过 AppSecret，它可能已经被重置，请用新的。`,
        `QQ doesn't accept this AppID and AppSecret${code ? ` (${code})` : ''}. The AppID is the number under ${Z.credentials} (AppID credentials); copy the AppSecret without spaces; if you viewed the AppSecret again in the console, it may have been reset: use the new one.`,
        `QQ no acepta este AppID y este AppSecret${code ? ` (${code})` : ''}. El AppID es el número de ${Z.credentials} (Credenciales del AppID); copia el AppSecret sin espacios; si volviste a ver el AppSecret en la consola, puede que se haya restablecido: usa el nuevo.`,
        `O QQ não aceita este AppID e este AppSecret${code ? ` (${code})` : ''}. O AppID é o número em ${Z.credentials} (Credenciais do AppID); copie o AppSecret sem espaços; se você viu o AppSecret de novo no console, ele pode ter sido redefinido: use o novo.`,
      ),
      next: 'reenter',
      failed: true,
    };
  if (reason === 'gone')
    return {
      text: tr(
        `QQ 说没有这个机器人，或者它已被封禁、删除（${code}）。核对 AppID；删除后 7 天内可以在 ${QQ_LINKS.restore} 恢复。`,
        `QQ says there is no such bot, or it was banned or deleted (${code}). Check the AppID; a deleted bot can be restored within 7 days at ${QQ_LINKS.restore}.`,
        `QQ dice que ese bot no existe, o que fue bloqueado o eliminado (${code}). Revisa el AppID; un bot eliminado se puede restaurar en un plazo de 7 días en ${QQ_LINKS.restore}.`,
        `O QQ diz que esse bot não existe, ou que foi bloqueado ou excluído (${code}). Confira o AppID; um bot excluído pode ser restaurado em até 7 dias em ${QQ_LINKS.restore}.`,
      ),
      next: 'reenter',
      failed: true,
    };
  if (reason === 'rateLimited')
    return {
      text: tr(
        `QQ 说请求太频繁（${code}）。等一会儿再按回车重试（QQ 没说要等多久）。`,
        `QQ says too many requests (${code}). Wait a little, then press Enter to retry (QQ doesn't say how long).`,
        `QQ dice que hubo demasiadas solicitudes (${code}). Espera un poco y presiona Enter para reintentar (QQ no dice cuánto tiempo).`,
        `O QQ diz que houve solicitações demais (${code}). Espere um pouco e pressione Enter para tentar de novo (o QQ não diz quanto tempo).`,
      ),
      next: 'retry',
      failed: false,
    };
  if (reason === 'refused') {
    const words = error instanceof QqError ? terminalText(error.description.trim()) : '';
    const said = words ? `${code}: ${words}` : String(code);
    return {
      text: tr(
        `QQ 拒绝了（${words ? `${code}：${words}` : code}）。如果在${Z.ipWhitelist}里加过 IP，有可能是白名单拦了（未确认）：把这台电脑现在的公网 IPv4 加进去，或者清空白名单。说明：${QQ_LINKS.ipWhitelist}`,
        `QQ refused (${said}). If you added IPs to ${Z.ipWhitelist} (Server IP whitelist), it may be the whitelist (unconfirmed): add this computer's current public IPv4, or empty the whitelist. Guide: ${QQ_LINKS.ipWhitelist}`,
        `QQ lo rechazó (${said}). Si agregaste IP a ${Z.ipWhitelist} (Lista blanca de IP del servidor), puede ser la lista (sin confirmar): agrega la IPv4 pública actual de este equipo o vacía la lista. Guía: ${QQ_LINKS.ipWhitelist}`,
        `O QQ recusou (${said}). Se você adicionou IPs em ${Z.ipWhitelist} (Lista de permissões de IP do servidor), pode ser a lista (não confirmado): adicione o IPv4 público atual deste computador ou esvazie a lista. Guia: ${QQ_LINKS.ipWhitelist}`,
      ),
      next: 'retry',
      failed: true,
    };
  }
  if (status >= 500 || status === 429)
    return {
      text: tr(
        `QQ 暂时出错（HTTP ${status}）。按回车重试。`,
        `QQ had a temporary error (HTTP ${status}). Press Enter to retry.`,
        `QQ tuvo un error temporal (HTTP ${status}). Presiona Enter para reintentar.`,
        `O QQ teve um erro temporário (HTTP ${status}). Pressione Enter para tentar de novo.`,
      ),
      next: 'retry',
      failed: false,
    };
  return {
    text: tr(
      '连不上 QQ（api.bot.qq.com）：检查网络和代理，然后按回车重试。',
      "Can't reach QQ (api.bot.qq.com): check the network and the proxy, then press Enter to retry.",
      'No se puede conectar con QQ (api.bot.qq.com): revisa la red y el proxy, y luego presiona Enter para reintentar.',
      'Não foi possível conectar ao QQ (api.bot.qq.com): confira a rede e o proxy e depois pressione Enter para tentar de novo.',
    ),
    next: 'retry',
    failed: true,
  };
}

/** The checks with QQ of this run are used up. */
export function tooManyChecks(): string {
  return tr(
    `这次已经向 QQ 核对了 ${TOKEN_CHECKS_MAX} 次，先停在这里。核对好 AppID 和 AppSecret 后，再运行 yomi relay --setup 接着设置。`,
    `This run has checked with QQ ${TOKEN_CHECKS_MAX} times, so it stops here. Once the AppID and AppSecret are right, run yomi relay --setup again to go on.`,
    `Esta ejecución ya verificó con QQ ${TOKEN_CHECKS_MAX} veces, así que se detiene aquí. Cuando el AppID y el AppSecret estén bien, vuelve a ejecutar yomi relay --setup para continuar.`,
    `Esta execução já verificou com o QQ ${TOKEN_CHECKS_MAX} vezes, então para aqui. Quando o AppID e o AppSecret estiverem certos, execute yomi relay --setup de novo para continuar.`,
  );
}

/** HH:MM, `ms` from now. */
function clockIn(ms: number): string {
  const at = new Date(Date.now() + ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** What the check of the gateway decided: go on (saved), or save and end with `after` said. */
export type PrivateChatCheck = { end: boolean; after: string };

/**
 * Step 4's check (design §3.1, §4.2): one connection to QQ's gateway with the private-chat intent,
 * within the day's connections (none left: saved, and the guide ends; 5 or fewer: skipped, the
 * pairing checks), at least `GUIDE_TIMINGS.identifyIntervalMs` after the one before (`progress`).
 * 4014 and 4013 are said, then saved (`s`) or quit (`q`); a check that could not reach the gateway
 * may be tried again twice (`r`); a bot delisted or banned is not saved (a UsageError).
 * `service`: a background service runs (it uses connections too when it starts again).
 */
export async function checkPrivateChat(
  ui: GuideUi,
  api: QqApi,
  progress: { identifiedAt: number },
  service: boolean,
): Promise<PrivateChatCheck> {
  const info = await api.gatewayBot().catch(() => null);
  ui.check();
  const limit = info?.session_start_limit;
  const remaining = typeof limit?.remaining === 'number' ? limit.remaining : null;
  const resetAfter = typeof limit?.reset_after === 'number' ? limit.reset_after : 60_000;
  if (remaining === 0) {
    const time = clockIn(resetAfter);
    return {
      end: true,
      after: tr(
        `QQ 今天的连接次数用完了，${time} 后恢复。bot 已保存，到时运行 yomi relay --setup 接着配对。`,
        `QQ's connections for today are used up until ${time}. The bot is saved: then run yomi relay --setup to pair it.`,
        `Las conexiones de QQ de hoy se agotaron hasta las ${time}. El bot está guardado: a esa hora ejecuta yomi relay --setup para vincularlo.`,
        `As conexões do QQ de hoje acabaram até as ${time}. O bot está salvo: nesse horário, execute yomi relay --setup para pareá-lo.`,
      ),
    };
  }
  if (remaining !== null && remaining <= 5) {
    ui.lines(
      tr(
        `QQ 今天只剩 ${remaining} 次连接，留给配对和运行：这次跳过检查，配对时一起检查。`,
        `Only ${remaining} QQ connections left today, kept for pairing and running: skipping this check; pairing checks it.`,
        `Solo quedan ${remaining} conexiones de QQ hoy, reservadas para la vinculación y la ejecución: se omite esta comprobación; la vinculación lo comprueba.`,
        `Só restam ${remaining} conexões do QQ hoje, reservadas para o pareamento e a execução: esta verificação foi pulada; o pareamento verifica.`,
      ),
    );
    return { end: false, after: '' };
  }
  // What the check uses, said only when it is made.
  ui.lines(checkIntro(remaining, service));
  for (let again = 0; ; again += 1) {
    const wait = progress.identifiedAt + GUIDE_TIMINGS.identifyIntervalMs - Date.now();
    if (progress.identifiedAt && wait > 0) {
      ui.note(spacingText());
      await ui.sleep(wait);
    }
    const probe = await probeGatewayDetail(api, { signal: ui.signal });
    ui.check();
    if (probe.identifiedAt) progress.identifiedAt = probe.identifiedAt;
    if (probe.result === 'ok') {
      ui.ok(
        tr(
          '能收到私聊消息。',
          'The bot can receive private messages.',
          'El bot puede recibir mensajes privados.',
          'O bot pode receber mensagens privadas.',
        ),
      );
      return { end: false, after: '' };
    }
    if (probe.closeCode === 4914 || probe.closeCode === 4915)
      throw new UsageError(
        probe.closeCode === 4914
          ? tr(
              'QQ 说这个机器人已下架（4914）：没有保存。请在 q.qq.com 查看它的状态。',
              'QQ says this bot was delisted (4914): nothing was saved. Check its status on q.qq.com.',
              'QQ dice que este bot fue retirado (4914): no se guardó nada. Revisa su estado en q.qq.com.',
              'O QQ diz que este bot foi retirado (4914): nada foi salvo. Confira o status dele em q.qq.com.',
            )
          : tr(
              'QQ 说这个机器人已封禁（4915）：没有保存。只能在 q.qq.com 申请解封。',
              'QQ says this bot was banned (4915): nothing was saved. An unban can only be requested on q.qq.com.',
              'QQ dice que este bot fue bloqueado (4915): no se guardó nada. Solo se puede pedir el desbloqueo en q.qq.com.',
              'O QQ diz que este bot foi bloqueado (4915): nada foi salvo. Só é possível pedir o desbloqueio em q.qq.com.',
            ),
      );
    if (probe.result === 'intents') {
      ui.fail(
        tr(
          `QQ 说这个机器人没有私聊（单聊）消息事件的权限（4014）。QQ 的文档没有写在哪里开启。请确认${Z.devSettings} → ${Z.eventSubscription}写的是 WebSocket 方式；还不行的话，看常见问题 ${QQ_LINKS.faq} 或联系 QQ。`,
          `QQ says the bot has no permission for private (C2C) message events (4014). QQ's documentation doesn't say where to enable it. Check that ${Z.eventSubscription} (Event subscription) in ${Z.devSettings} (Development settings) uses WebSocket; if that doesn't help, see the FAQ at ${QQ_LINKS.faq} or contact QQ.`,
          `QQ dice que el bot no tiene permiso para los eventos de mensajes privados (C2C) (4014). La documentación de QQ no dice dónde activarlo. Comprueba que ${Z.eventSubscription} (Suscripción de eventos), en ${Z.devSettings} (Configuración de desarrollo), use WebSocket; si no se soluciona, consulta las preguntas frecuentes en ${QQ_LINKS.faq} o contacta con QQ.`,
          `O QQ diz que o bot não tem permissão para os eventos de mensagens privadas (C2C) (4014). A documentação do QQ não diz onde ativá-la. Confira se ${Z.eventSubscription} (Assinatura de eventos), em ${Z.devSettings} (Configurações de desenvolvimento), usa WebSocket; se não resolver, veja as perguntas frequentes em ${QQ_LINKS.faq} ou entre em contato com o QQ.`,
        ),
      );
      await saveOrQuit(
        ui,
        tr(
          's：先保存，配对时会再检查一次',
          's: save now; pairing checks again',
          's: guardar ahora; la vinculación vuelve a comprobarlo',
          's: salvar agora; o pareamento verifica de novo',
        ),
      );
      return { end: false, after: '' };
    }
    if (probe.result === 'protocol') {
      ui.fail(
        tr(
          '这个版本的 yomi 和 QQ 网关的协议对不上（4013，无效的 intent）。请升级 yomi：npm i -g @yomichat/cli',
          "This yomi doesn't match QQ's gateway protocol (4013, invalid intent). Update yomi: npm i -g @yomichat/cli",
          'Este yomi no coincide con el protocolo del gateway de QQ (4013, intent no válido). Actualiza yomi: npm i -g @yomichat/cli',
          'Este yomi não corresponde ao protocolo do gateway do QQ (4013, intent inválido). Atualize o yomi: npm i -g @yomichat/cli',
        ),
      );
      await saveOrQuit(
        ui,
        tr(
          's：保存后结束，升级后运行 yomi relay --setup 接着做',
          's: save and stop here; after updating, run yomi relay --setup to go on',
          's: guardar y terminar aquí; después de actualizar, ejecuta yomi relay --setup para continuar',
          's: salvar e parar aqui; depois de atualizar, execute yomi relay --setup para continuar',
        ),
      );
      return {
        end: true,
        after: tr(
          '升级 yomi 之后，运行 yomi relay --setup 接着设置。',
          'Once yomi is updated, run yomi relay --setup to go on.',
          'Cuando yomi esté actualizado, ejecuta yomi relay --setup para continuar.',
          'Depois de atualizar o yomi, execute yomi relay --setup para continuar.',
        ),
      };
    }
    ui.lines(
      tr(
        '没能连上 QQ 网关（网络、代理，或者 QQ 暂时不可用）。',
        "Couldn't reach QQ's gateway (network, proxy, or QQ unavailable).",
        'No se pudo conectar con el gateway de QQ (red, proxy o QQ no disponible).',
        'Não foi possível conectar ao gateway do QQ (rede, proxy ou QQ indisponível).',
      ),
    );
    const parts = [
      ...(again < 2
        ? [tr('r：再检查一次', 'r: check again', 'r: comprobar de nuevo', 'r: verificar de novo')]
        : []),
      tr('s：先保存', 's: save now', 's: guardar ahora', 's: salvar agora'),
      tr('q：退出', 'q: quit', 'q: salir', 'q: sair'),
    ];
    const key = await ui.key(`${parts.join(' · ')} `, again < 2 ? ['r', 's', 'q'] : ['s', 'q']);
    if (key === 'q') throw new GuideCancelled('quit');
    if (key === 's') return { end: false, after: '' };
  }
}

/** `s` saves (returns), `q` quits without saving. */
async function saveOrQuit(ui: GuideUi, save: string) {
  const quit = tr(
    'q：退出，不保存',
    'q: quit without saving',
    'q: salir sin guardar',
    'q: sair sem salvar',
  );
  if ((await ui.key(`${save} · ${quit} `, ['s', 'q'])) === 'q') throw new GuideCancelled('quit');
}

/** Step 4's first line when it checks: what the check uses of QQ's daily connections. */
function checkIntro(remaining: number | null, service: boolean): string {
  const left =
    remaining === null
      ? ''
      : tr(
          `今天还剩 ${remaining} 次；`,
          ` ${remaining} left today;`,
          ` hoy quedan ${remaining};`,
          ` restam ${remaining} hoje;`,
        );
  return service
    ? tr(
        `连一次 QQ 网关，确认机器人能收到私聊（单聊）消息。QQ 限制每个机器人每天的连接次数，${left}这次检查用 1 次，之后后台服务重启、配对、配对后服务再重启，最多再用 3 次。`,
        `One connection to QQ's gateway checks that the bot can receive private (C2C) messages. QQ limits connections per bot per day:${left} this check uses 1, and the service starting again, pairing and the service starting again after it up to 3 more.`,
        `Una conexión con el gateway de QQ comprueba que el bot pueda recibir mensajes privados (C2C). QQ limita las conexiones por bot y por día:${left} esta comprobación usa 1, y el reinicio del servicio, la vinculación y el reinicio del servicio después de ella hasta 3 más.`,
        `Uma conexão com o gateway do QQ verifica se o bot pode receber mensagens privadas (C2C). O QQ limita as conexões por bot e por dia:${left} esta verificação usa 1, e o reinício do serviço, o pareamento e o reinício do serviço depois dele até mais 3.`,
      )
    : tr(
        `连一次 QQ 网关，确认机器人能收到私聊（单聊）消息。QQ 限制每个机器人每天的连接次数，${left}这次检查用 1 次，配对再用 1 次。`,
        `One connection to QQ's gateway checks that the bot can receive private (C2C) messages. QQ limits connections per bot per day:${left} this check uses 1 and pairing 1 more.`,
        `Una conexión con el gateway de QQ comprueba que el bot pueda recibir mensajes privados (C2C). QQ limita las conexiones por bot y por día:${left} esta comprobación usa 1 y la vinculación 1 más.`,
        `Uma conexão com o gateway do QQ verifica se o bot pode receber mensagens privadas (C2C). O QQ limita as conexões por bot e por dia:${left} esta verificação usa 1 e o pareamento mais 1.`,
      );
}

/** Said while the guide waits out QQ's 5 s between two connections. */
export const spacingText = () =>
  tr(
    '（QQ 要求两次连接之间隔 5 秒，稍等）',
    '(QQ wants 5 s between two connections; a moment)',
    '(QQ pide 5 s entre dos conexiones; un momento)',
    '(O QQ pede 5 s entre duas conexões; um momento)',
  );

/** Step 6: adding the bot as a QQ friend (QQ only lets a bot message its friends). */
export function friendLines(): string[] {
  return [
    tr(
      'QQ 只允许机器人给好友发私聊消息。已经能在 QQ 里和它聊天的话，直接按回车。',
      'QQ only lets a bot send private messages to its friends. If you can already chat with it in QQ, just press Enter.',
      'QQ solo deja que un bot envíe mensajes privados a sus amigos. Si ya puedes chatear con él en QQ, solo presiona Enter.',
      'O QQ só deixa um bot enviar mensagens privadas para os amigos dele. Se você já consegue conversar com ele no QQ, é só pressionar Enter.',
    ),
    tr(
      `1. 在 q.qq.com 打开这个机器人，点顶部名字旁边的二维码（刚创建时，也可以用${Z.aiService}页上的${Z.scanToChat}）。`,
      `1. On q.qq.com open the bot and click the QR code next to its name at the top (right after creation, ${Z.scanToChat} (Scan to chat) on ${Z.aiService} works too).`,
      `1. En q.qq.com abre el bot y haz clic en el código QR junto a su nombre, arriba (justo después de crearlo, también sirve ${Z.scanToChat} (Escanear para chatear) en ${Z.aiService}).`,
      `1. Em q.qq.com, abra o bot e clique no código QR ao lado do nome dele, no alto (logo depois de criá-lo, também serve ${Z.scanToChat} (Escanear para conversar) em ${Z.aiService}).`,
    ),
    tr(
      '2. 用手机 QQ 扫码，按 QQ 的提示加好友，或者打开聊天。',
      "2. Scan it with QQ on your phone and follow QQ's prompts to add the bot or open the chat.",
      '2. Escanéalo con QQ en tu teléfono y sigue las indicaciones de QQ para agregar el bot o abrir el chat.',
      '2. Escaneie com o QQ no celular e siga as instruções do QQ para adicionar o bot ou abrir a conversa.',
    ),
    tr(
      `要用另一个 QQ 号聊天（不是登录 q.qq.com 的那个号）：先在${Z.testAccounts}里点${Z.addUser}，把那个号加进去（最多 20 个），否则它加不了机器人。`,
      `Chatting from another QQ account than the one signed in to q.qq.com: first add that account under ${Z.testAccounts} (Development settings → Test accounts) with ${Z.addUser} (+ Add user), up to 20; otherwise it can't add the bot.`,
      `Para chatear desde otra cuenta de QQ distinta de la que inició sesión en q.qq.com: primero agrega esa cuenta en ${Z.testAccounts} (Configuración de desarrollo → Cuentas de prueba) con ${Z.addUser} (+ Agregar usuario), hasta 20; si no, no podrá agregar el bot.`,
      `Para conversar de outra conta do QQ, diferente da que entrou em q.qq.com: primeiro adicione essa conta em ${Z.testAccounts} (Configurações de desenvolvimento → Contas de teste) com ${Z.addUser} (+ Adicionar usuário), até 20; senão ela não consegue adicionar o bot.`,
    ),
    tr(
      `现在给机器人发消息，它会回${Z.mars}：这是 relay 还没连上，正常现象，下一步连上就好了。`,
      `If you message the bot now it answers ${Z.mars} ("this bot went to Mars"): relay isn't connected yet. That's expected and stops after the next step.`,
      `Si le escribes al bot ahora, responde ${Z.mars} ("este bot se fue a Marte"): relay todavía no está conectado. Es normal y deja de pasar después del siguiente paso.`,
      `Se você mandar mensagem para o bot agora, ele responde ${Z.mars} ("este bot foi para Marte"): o relay ainda não está conectado. É normal e para depois do próximo passo.`,
    ),
    tr(
      `说明：${QQ_LINKS.testAccounts}`,
      `Guide: ${QQ_LINKS.testAccounts}`,
      `Guía: ${QQ_LINKS.testAccounts}`,
      `Guia: ${QQ_LINKS.testAccounts}`,
    ),
  ];
}

/** Setting a bot's AppSecret again, its first step: where to view or reset it. */
export function resetLines(name: string, appId: string, service: boolean): string[] {
  return [
    tr(
      `在 q.qq.com 打开机器人 ${name}（AppID ${appId}）的${Z.devSettings} → ${Z.credentials}，查看或重置 AppSecret（按钮的确切名字以控制台为准）。`,
      `On q.qq.com open ${Z.credentials} (AppID credentials) in the ${Z.devSettings} (Development settings) of the bot ${name} (AppID ${appId}), and view or reset the AppSecret (the console names the button).`,
      `En q.qq.com abre ${Z.credentials} (Credenciales del AppID), dentro de ${Z.devSettings} (Configuración de desarrollo) del bot ${name} (AppID ${appId}), y mira o restablece el AppSecret (el botón se llama como diga la consola).`,
      `Em q.qq.com, abra ${Z.credentials} (Credenciais do AppID), dentro de ${Z.devSettings} (Configurações de desenvolvimento) do bot ${name} (AppID ${appId}), e veja ou redefina o AppSecret (o botão tem o nome que o console mostrar).`,
    ),
    ...(service
      ? [
          tr(
            `${name} 正在后台服务里运行：重置以后它下次换令牌时会停下（其他 bot 不受影响），保存后服务重新启动就恢复。`,
            `${name} runs in the background service: once reset, it stops at its next token refresh (the other bots go on), and comes back when the service starts again after saving.`,
            `${name} se ejecuta en el servicio en segundo plano: tras restablecerlo, se detiene en su próxima renovación del token (los otros bots siguen) y vuelve cuando el servicio se reinicia después de guardar.`,
            `${name} está em execução no serviço em segundo plano: depois de redefinir, ele para na próxima renovação do token (os outros bots continuam) e volta quando o serviço reinicia depois de salvar.`,
          ),
        ]
      : []),
  ];
}
