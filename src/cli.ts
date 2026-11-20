#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { ApiError, NotSignedIn } from './core/api.js';
import { UsageError } from './core/env.js';
import { docUrl } from './core/docs.js';
import { type Language, parseLanguage, setLanguage, tr } from './core/i18n.js';
import { redact } from './core/redact.js';
import { type Io, paint, processIo, say } from './core/ui.js';
import { VERSION } from './core/version.js';
import { login, logout, whoami } from './commands/auth.js';
import { check, init, tags, voices } from './commands/catalog.js';
import { createContext, type GlobalOptions } from './commands/context.js';
import { create } from './commands/create.js';
import { image } from './commands/image.js';
import { persona } from './commands/persona.js';
import { preview } from './commands/preview.js';
import { relay, relayList, relayRebind } from './commands/relay.js';
import { video } from './commands/video.js';
import { CHANNEL_KINDS, type ChannelKind } from './relay/channels/types.js';
import { UgcFailure } from './ugc/api.js';
import { ImageError } from './ugc/imageFile.js';
import {
  type CharacterSpec,
  emptySpec,
  loadSpecFile,
  SpecError,
  specFromObject,
} from './ugc/spec.js';

function help(): string {
  return tr(
    `yomi ${VERSION} — Yomi 命令行工具

用法：yomi <命令> [选项]

命令：
  login              通过网页授权登录（打开浏览器，在网页上确认）
  logout             退出登录，撤销并删除本机凭证
  whoami             显示当前登录的账号
  init [文件]        生成角色文件模板（默认 character.yaml）
  check -f <文件>    按 App 规则检查角色文件（不联网）
  voices             列出可选声音
  tags               列出可选标签
  create -f <文件>   创建角色
  preview -f <文件>  在终端里和草稿角色试聊（不创建角色）
  image -p <描述>    AI 生成角色图片（封面 / 头像），按张扣钻石
  video -f <文件>    AI 生成角色视频（动态封面 / 介绍视频），按报价扣钻石
  persona list       你的聊天人设（主控）
  persona avatar     AI 生成人设头像
  relay --channel …  把你自己的 Telegram、QQ bot 或微信 ClawBot 的私聊转给已发布的 Yomi 角色（实验）

全局选项：
  --env <prod|test>  环境，默认 prod（生产，创建和花钻石前要再确认）；test 需自己配置地址
                     （YOMI_TEST_API_ORIGIN / YOMI_TEST_WEB_ORIGIN）
  --lane <名称>      测试环境的泳道，加 Lane 请求头
  --lang zh|en|es|pt 输出语言（默认按 YOMI_LANG 或系统语言：zh 开头为中文，es 开头为西班牙语，pt 开头为葡萄牙语，其余英文）
  --debug            打印请求日志（凭证已脱敏）
  -h, --help         帮助；yomi <命令> --help 查看命令选项
  -v, --version      版本

示例：
  yomi login
  yomi init lin-xia.yaml && yomi check -f lin-xia.yaml
  yomi preview -f lin-xia.yaml
  yomi create -f lin-xia.yaml
`,
    `yomi ${VERSION} — Yomi command-line tool

Usage: yomi <command> [options]

Commands:
  login              Sign in through the web (opens a browser; you confirm on the web page)
  logout             Sign out; revoke and delete the credentials on this machine
  whoami             Show the signed-in account
  init [file]        Write a character file template (default character.yaml)
  check -f <file>    Check a character file against the app's rules (offline)
  voices             List the available voices
  tags               List the available tags
  create -f <file>   Create a character
  preview -f <file>  Preview a chat with the draft character in the terminal (creates nothing)
  image -p <prompt>  Generate character images with AI (cover / avatar), gems charged per image
  video -f <file>    Generate character videos with AI (dynamic cover / intro video), gems charged per quote
  persona list       Your chat personas
  persona avatar     Generate a persona avatar with AI
  relay --channel …  Relay private chats with your own Telegram or QQ bot, or WeChat ClawBot, to a published Yomi character (experimental)

Global options:
  --env <prod|test>  Environment, default prod (production: asks again before creating or spending gems); test
                     needs its addresses set up (YOMI_TEST_API_ORIGIN / YOMI_TEST_WEB_ORIGIN)
  --lane <name>      Lane in the test environment; adds the Lane request header
  --lang zh|en|es|pt Output language (default from YOMI_LANG or the system language: zh… is Chinese, es… Spanish, pt… Portuguese, anything else English)
  --debug            Print request logs (credentials redacted)
  -h, --help         Help; yomi <command> --help shows a command's options
  -v, --version      Version

Examples:
  yomi login
  yomi init lin-xia.yaml && yomi check -f lin-xia.yaml
  yomi preview -f lin-xia.yaml
  yomi create -f lin-xia.yaml
`,
    `yomi ${VERSION} — herramienta de línea de comandos de Yomi

Uso: yomi <comando> [opciones]

Comandos:
  login                 Inicia sesión a través de la web (abre un navegador; confirmas en la página web)
  logout                Cierra sesión; revoca y elimina las credenciales de este equipo
  whoami                Muestra la cuenta con la sesión iniciada
  init [archivo]        Escribe una plantilla de archivo del personaje (por defecto character.yaml)
  check -f <archivo>    Revisa un archivo del personaje según las reglas de la app (sin conexión)
  voices                Lista las voces disponibles
  tags                  Lista las etiquetas disponibles
  create -f <archivo>   Crea un personaje
  preview -f <archivo>  Abre en la terminal una vista previa del chat con el personaje en borrador (no crea nada)
  image -p <prompt>     Genera imágenes del personaje con IA (portada / avatar); cobra gemas por imagen
  video -f <archivo>    Genera videos del personaje con IA (portada animada / video de presentación); cobra gemas según la cotización
  persona list          Tus personas de chat
  persona avatar        Genera un avatar de persona con IA
  relay --channel …     Reenvía los chats privados con tu propio bot de Telegram o QQ, o con WeChat ClawBot, a un personaje de Yomi publicado (experimental)

Opciones globales:
  --env <prod|test>     Entorno, por defecto prod (producción: vuelve a preguntar antes de crear o gastar gemas); test
                        necesita sus direcciones configuradas (YOMI_TEST_API_ORIGIN / YOMI_TEST_WEB_ORIGIN)
  --lane <nombre>       Lane en el entorno de pruebas; agrega el encabezado de solicitud Lane
  --lang zh|en|es|pt    Idioma de salida (por defecto según YOMI_LANG o el idioma del sistema: zh… es chino, es… español, pt… portugués, cualquier otro, inglés)
  --debug               Imprime los registros de solicitudes (credenciales ocultas)
  -h, --help            Ayuda; yomi <comando> --help muestra las opciones de un comando
  -v, --version         Versión

Ejemplos:
  yomi login
  yomi init lin-xia.yaml && yomi check -f lin-xia.yaml
  yomi preview -f lin-xia.yaml
  yomi create -f lin-xia.yaml
`,
    `yomi ${VERSION} — ferramenta de linha de comando do Yomi

Uso: yomi <comando> [opções]

Comandos:
  login                 Entra na sua conta pela web (abre um navegador; você confirma na página web)
  logout                Sai da conta; revoga e apaga as credenciais desta máquina
  whoami                Mostra a conta conectada
  init [arquivo]        Grava um template de arquivo do personagem (padrão character.yaml)
  check -f <arquivo>    Verifica um arquivo do personagem com as regras do app (offline)
  voices                Lista as vozes disponíveis
  tags                  Lista as tags disponíveis
  create -f <arquivo>   Cria um personagem
  preview -f <arquivo>  Abre no terminal uma prévia do chat com o personagem em rascunho (não cria nada)
  image -p <prompt>     Gera imagens do personagem com IA (capa / avatar); cobra gemas por imagem
  video -f <arquivo>    Gera vídeos do personagem com IA (capa animada / vídeo de apresentação); cobra gemas conforme a cotação
  persona list          Suas personas de chat
  persona avatar        Gera um avatar de persona com IA
  relay --channel …     Repassa os chats privados com o seu próprio bot do Telegram ou do QQ, ou com o WeChat ClawBot, para um personagem do Yomi publicado (experimental)

Opções globais:
  --env <prod|test>     Ambiente, padrão prod (produção: pergunta novamente antes de criar ou gastar gemas); test
                        precisa dos endereços configurados (YOMI_TEST_API_ORIGIN / YOMI_TEST_WEB_ORIGIN)
  --lane <nome>         Lane no ambiente de teste; adiciona o cabeçalho de solicitação Lane
  --lang zh|en|es|pt    Idioma de saída (padrão segundo YOMI_LANG ou o idioma do sistema: zh… é chinês, es… espanhol, pt… português, qualquer outro, inglês)
  --debug               Imprime os logs das solicitações (credenciais ocultadas)
  -h, --help            Ajuda; yomi <comando> --help mostra as opções de um comando
  -v, --version         Versão

Exemplos:
  yomi login
  yomi init lin-xia.yaml && yomi check -f lin-xia.yaml
  yomi preview -f lin-xia.yaml
  yomi create -f lin-xia.yaml
`,
  );
}

/** Built per call, in the language of this run. */
function commandHelp(): Record<string, string> {
  return {
    login: tr(
      `yomi login [--no-browser] [--timeout 秒]
  打开 Yomi 网页的授权页，确认码一致后点「授权」。CLI 会建立自己的会话，不影响 App 和网页的登录。
  --no-browser   只打印授权地址，不自动打开浏览器
  --timeout      等待授权的秒数，默认 300`,
      `yomi login [--no-browser] [--timeout seconds]
  Opens the authorization page on the Yomi website; when the confirmation codes match, click "Authorize". The CLI
  gets its own session and does not affect your sign-in on the app or the web.
  --no-browser   Only print the authorization URL; do not open a browser
  --timeout      Seconds to wait for authorization, default 300`,
      `yomi login [--no-browser] [--timeout segundos]
  Abre la página de autorización en el sitio web de Yomi; cuando los códigos de confirmación coincidan, haz clic en
  "Autorizar". La CLI obtiene su propia sesión y no afecta tu sesión iniciada en la app ni en la web.
  --no-browser   Solo imprime la URL de autorización; no abre un navegador
  --timeout      Segundos de espera para la autorización, por defecto 300`,
      `yomi login [--no-browser] [--timeout segundos]
  Abre a página de autorização no site do Yomi; quando os códigos de confirmação forem iguais, clique em
  "Autorizar". A CLI cria a própria sessão e não afeta o seu login no app nem na web.
  --no-browser   Só imprime a URL de autorização; não abre o navegador
  --timeout      Segundos de espera pela autorização, padrão 300`,
    ),
    create: tr(
      `yomi create -f <文件> [字段选项] [--accept-declaration] [--dry-run] [--new] [--confirm-prod]
  按文件创建一个角色（字段规则同 App）。会先确认 18+ 与版权声明，再上传并审核图片、提交。
  --accept-declaration  非交互运行时明确确认声明
  --dry-run             只打印请求体，不创建（图片仍会上传审核）
  --new                 同一文件内容已创建过时，再创建一个新角色
  --confirm-prod        非交互在生产环境运行时明确确认
${'  '}字段选项（覆盖文件里的值）：--name --gender --description --opening --background
  --visibility --voice --tag（可重复）--cover --avatar`,
      `yomi create -f <file> [field options] [--accept-declaration] [--dry-run] [--new] [--confirm-prod]
  Creates a character from the file (same field rules as the app). First confirms the 18+ and copyright
  declaration, then uploads the images for review and submits.
  --accept-declaration  Accept the declaration explicitly when running non-interactively
  --dry-run             Only print the request body; create nothing (images are still uploaded for review)
  --new                 Create another new character when this file's content was already created
  --confirm-prod        Confirm explicitly when running non-interactively in production
${'  '}Field options (override the values in the file): --name --gender --description --opening --background
  --visibility --voice --tag (repeatable) --cover --avatar`,
      `yomi create -f <archivo> [opciones de campo] [--accept-declaration] [--dry-run] [--new] [--confirm-prod]
  Crea un personaje a partir del archivo (mismas reglas de campos que la app). Primero confirma la declaración
  de 18+ y derechos de autor; luego sube las imágenes para revisión y envía.
  --accept-declaration  Acepta la declaración de forma explícita al ejecutar sin interacción
  --dry-run             Solo imprime el cuerpo de la solicitud; no crea nada (las imágenes igual se suben para revisión)
  --new                 Crea otro personaje nuevo cuando el contenido de este archivo ya se creó
  --confirm-prod        Confirma de forma explícita al ejecutar sin interacción en producción
${'  '}Opciones de campo (reemplazan los valores del archivo): --name --gender --description --opening --background
  --visibility --voice --tag (repetible) --cover --avatar`,
      `yomi create -f <arquivo> [opções de campo] [--accept-declaration] [--dry-run] [--new] [--confirm-prod]
  Cria um personagem a partir do arquivo (mesmas regras de campos do app). Primeiro confirma a declaração
  de 18+ e direitos autorais; depois envia as imagens para revisão e submete.
  --accept-declaration  Aceita a declaração explicitamente ao executar de forma não interativa
  --dry-run             Só imprime o corpo da solicitação; não cria nada (as imagens ainda são enviadas para revisão)
  --new                 Cria outro personagem novo quando o conteúdo deste arquivo já foi criado
  --confirm-prod        Confirma explicitamente ao executar de forma não interativa em produção
${'  '}Opções de campo (substituem os valores do arquivo): --name --gender --description --opening --background
  --visibility --voice --tag (repetível) --cover --avatar`,
    ),
    preview: tr(
      `yomi preview -f <文件> [字段选项] [-m 消息 ...] [--allow-paid] [--accept-declaration]
  用文件里的草稿内容开一个临时预演会话（与 App 的「预览」相同），流式显示回复。
  先显示服务端返回的免费条数；用完后发送会按标准费率扣钻石，扣之前必须输入 yes 确认。
  -m, --message         非交互：依次发送这些消息，收完回复后退出
  --allow-paid          非交互时允许免费条数用完后继续付费发送
  --reply-timeout       等待一条回复的秒数，默认 90，超时后改为读取消息记录
  --accept-declaration  非交互运行时明确确认声明`,
      `yomi preview -f <file> [field options] [-m message ...] [--allow-paid] [--accept-declaration]
  Opens a temporary preview session with the draft in the file (the same as "Preview" in the app) and streams
  the replies. Shows the free messages the server grants first; once they run out, each message is charged
  gems at the standard rate, and you must type yes to confirm before any charge.
  -m, --message         Non-interactive: send these messages in order, exit once the replies are in
  --allow-paid          Non-interactive: keep sending, paid, after the free messages run out
  --reply-timeout       Seconds to wait for a reply, default 90; after that, read the message history instead
  --accept-declaration  Accept the declaration explicitly when running non-interactively`,
      `yomi preview -f <archivo> [opciones de campo] [-m mensaje ...] [--allow-paid] [--accept-declaration]
  Abre una sesión temporal de vista previa con el borrador del archivo (igual que "Vista previa" en la app) y
  muestra las respuestas en tiempo real. Primero muestra los mensajes gratis que otorga el servidor; cuando se
  acaban, se cobran gemas por cada mensaje con la tarifa estándar, y debes escribir yes para confirmar antes de
  cualquier cobro.
  -m, --message         Sin interacción: envía estos mensajes en orden y sale cuando llegan las respuestas
  --allow-paid          Sin interacción: sigue enviando, con pago, cuando se acaban los mensajes gratis
  --reply-timeout       Segundos de espera para una respuesta, por defecto 90; después, lee el historial de mensajes
  --accept-declaration  Acepta la declaración de forma explícita al ejecutar sin interacción`,
      `yomi preview -f <arquivo> [opções de campo] [-m mensagem ...] [--allow-paid] [--accept-declaration]
  Abre uma sessão temporária de prévia com o rascunho do arquivo (o mesmo que "Prévia" no app) e mostra as
  respostas em tempo real. Primeiro mostra as mensagens grátis que o servidor concede; quando elas acabam, cada
  mensagem é cobrada em gemas pela tarifa padrão, e você precisa digitar yes para confirmar antes de qualquer
  cobrança.
  -m, --message         Sem interação: envia essas mensagens em ordem e sai quando as respostas chegarem
  --allow-paid          Sem interação: continua enviando, pago, depois que as mensagens grátis acabarem
  --reply-timeout       Segundos de espera por uma resposta, padrão 90; depois disso, lê o histórico de mensagens
  --accept-declaration  Aceita a declaração explicitamente ao executar de forma não interativa`,
    ),
    image: tr(
      `yomi image -p <描述> [--count N] [--model ID] [--style ID] [--reference 图片] [选项]
  用 AI 生成角色图片，下载原图并裁好封面（1:2）和头像（1:1）。先显示单价、张数、总价和余额，
  输入 yes（或 --accept-price）才扣钻石；生成失败的那张自动退款。
  --options            列出可用模型、风格、比例和价格（不扣费）
  --count N            张数（1–4，默认 4）
  --model / --style    模型、风格（默认第一个模型、不选风格）
  --ratio R            比例（默认 9:16，没有就用第一个）
  --reference 图片      参考图（先上传审核）
  --out 目录           保存位置，默认 ./yomi-media
  --pick N --into 文件 --as cover|avatar|both
                       把第 N 张裁好的图写进角色文件的 cover/avatar（保留注释）
  --resume 批次|请求    继续之前的一次：已受理的只查看和下载，不再扣费；答复未知的请求
                       会原样重发（同一请求 ID，最多扣一次）
  --resume ID --forget 放弃本机对这个请求或批次的跟踪（不取消、不退款；同样的命令会重新扣费）
  --accept-price       非交互时同意显示的价格
  --json               输出 JSON`,
      `yomi image -p <prompt> [--count N] [--model ID] [--style ID] [--reference image] [options]
  Generates character images with AI, downloads the originals and crops a cover (1:2) and an avatar (1:1).
  Shows the unit price, count, total and balance first; gems are charged only after you type yes (or
  --accept-price). An image that fails to generate is refunded automatically.
  --options            List the models, styles, aspect ratios and prices (no charge)
  --count N            Number of images (1–4, default 4)
  --model / --style    Model and style (default: the first model, no style)
  --ratio R            Aspect ratio (default 9:16, else the first one)
  --reference image    Reference image (uploaded for review first)
  --out dir            Where to save, default ./yomi-media
  --pick N --into file --as cover|avatar|both
                       Write the Nth cropped image into the character file's cover/avatar (comments kept)
  --resume batch|request
                       Continue an earlier run: what was accepted is only checked and downloaded, not charged
                       again; a request with an unknown outcome is resent as is (same request ID, charged once
                       at most)
  --resume ID --forget Stop tracking this request or batch on this machine (no cancel, no refund; the same
                       command charges again)
  --accept-price       Accept the shown price when running non-interactively
  --json               Output JSON`,
      `yomi image -p <prompt> [--count N] [--model ID] [--style ID] [--reference imagen] [opciones]
  Genera imágenes del personaje con IA, descarga los originales y recorta una portada (1:2) y un avatar (1:1).
  Primero muestra el precio unitario, la cantidad, el total y el saldo; las gemas se cobran solo después de que
  escribas yes (o --accept-price). Una imagen que no se genera se reembolsa automáticamente.
  --options            Lista los modelos, estilos, relaciones de aspecto y precios (sin cobro)
  --count N            Cantidad de imágenes (1–4, por defecto 4)
  --model / --style    Modelo y estilo (por defecto: el primer modelo, sin estilo)
  --ratio R            Relación de aspecto (por defecto 9:16; si no existe, la primera)
  --reference imagen   Imagen de referencia (primero se sube para revisión)
  --out carpeta        Dónde guardar, por defecto ./yomi-media
  --pick N --into archivo --as cover|avatar|both
                       Escribe la imagen recortada número N en cover/avatar del archivo del personaje (conserva los
                       comentarios)
  --resume lote|solicitud
                       Continúa una ejecución anterior: lo que ya se aceptó solo se consulta y descarga, sin volver
                       a cobrar; una solicitud con resultado desconocido se reenvía tal cual (mismo ID de
                       solicitud, se cobra una vez como máximo)
  --resume ID --forget Deja de seguir esta solicitud o lote en este equipo (no cancela ni reembolsa; el
                       mismo comando vuelve a cobrar)
  --accept-price       Acepta el precio mostrado al ejecutar sin interacción
  --json               Salida en JSON`,
      `yomi image -p <prompt> [--count N] [--model ID] [--style ID] [--reference imagem] [opções]
  Gera imagens do personagem com IA, baixa os originais e recorta uma capa (1:2) e um avatar (1:1).
  Primeiro mostra o preço unitário, a quantidade, o total e o saldo; as gemas só são cobradas depois que você
  digitar yes (ou --accept-price). Uma imagem que falha ao ser gerada é reembolsada automaticamente.
  --options            Lista os modelos, estilos, proporções e preços (sem cobrança)
  --count N            Número de imagens (1–4, padrão 4)
  --model / --style    Modelo e estilo (padrão: o primeiro modelo, sem estilo)
  --ratio R            Proporção (padrão 9:16; se não houver, a primeira)
  --reference imagem   Imagem de referência (enviada para revisão primeiro)
  --out pasta          Onde salvar, padrão ./yomi-media
  --pick N --into arquivo --as cover|avatar|both
                       Grava a imagem recortada número N em cover/avatar do arquivo do personagem (mantém os
                       comentários)
  --resume lote|solicitação
                       Continua uma execução anterior: o que já foi aceito só é consultado e baixado, sem cobrar
                       de novo; uma solicitação com resultado desconhecido é reenviada como está (mesmo ID da
                       solicitação, cobrada no máximo uma vez)
  --resume ID --forget Para de acompanhar esta solicitação ou lote nesta máquina (não cancela nem reembolsa;
                       o mesmo comando cobra de novo)
  --accept-price       Aceita o preço mostrado ao executar de forma não interativa
  --json               Saída em JSON`,
    ),
    video: tr(
      `yomi video -f <角色文件> [--template ID | --prompt 描述] [--duration 秒] [选项]
  用 AI 为角色生成视频。首帧默认取角色封面（裁成 9:16），先上传首帧、拿到报价，显示价格和余额，
  输入 yes（或 --accept-price）才创建任务扣钻石；失败自动退款。结果记在本机，下次 yomi create
  这个角色文件时一起提交（yomi preview 试聊不带视频）。
  --options            列出模板、时长和展示价（不扣费）
  --template ID        模板；不写则为自定义（--prompt 描述）
  --duration 秒        时长（默认用模板或自定义的默认值）
  --frame 图片         自己指定首帧（JPEG/PNG，会裁成 9:16）
  --as dynamic-cover|intro-video   用作动态封面（默认）或介绍视频
  --list               列出这个角色文件生成过的视频任务
  --resume 请求ID       继续之前的任务：已受理的只查看，不再扣费；答复未知的请求会原样重发
                       （同一请求 ID，最多扣一次）
  --out 目录           保存预览视频，默认 ./yomi-media
  --accept-price / --confirm-prod / --json`,
      `yomi video -f <character file> [--template ID | --prompt text] [--duration seconds] [options]
  Generates a video for the character with AI. The first frame is the character's cover by default (cropped to
  9:16): the CLI uploads it, gets a quote and shows the price and balance; the task is created and gems are
  charged only after you type yes (or --accept-price); a failure is refunded automatically. The result is kept
  on this machine and submitted the next time you run yomi create with this character file (a yomi preview
  does not include the video).
  --options            List the templates, durations and listed prices (no charge)
  --template ID        Template; without it, a custom video (--prompt text)
  --duration seconds   Duration (default: the template's or the custom default)
  --frame image        Your own first frame (JPEG/PNG, cropped to 9:16)
  --as dynamic-cover|intro-video   Use as the dynamic cover (default) or the intro video
  --list               List the video tasks generated for this character file
  --resume ID          Continue an earlier task: what was accepted is only checked, not charged again; a
                       request with an unknown outcome is resent as is (same request ID, charged once at most)
  --out dir            Where to save the preview video, default ./yomi-media
  --accept-price / --confirm-prod / --json`,
      `yomi video -f <archivo del personaje> [--template ID | --prompt texto] [--duration segundos] [opciones]
  Genera un video para el personaje con IA. Por defecto, el primer fotograma es la portada del personaje
  (recortada a 9:16): la CLI lo sube, obtiene una cotización y muestra el precio y el saldo; la tarea se crea y
  las gemas se cobran solo después de que escribas yes (o --accept-price); si falla, se reembolsa
  automáticamente. El resultado se guarda en este equipo y se envía la próxima vez que ejecutes yomi create con
  este archivo del personaje (yomi preview no incluye el video).
  --options            Lista las plantillas, duraciones y precios de lista (sin cobro)
  --template ID        Plantilla; sin ella, un video personalizado (--prompt texto)
  --duration segundos  Duración (por defecto: la de la plantilla o la del video personalizado)
  --frame imagen       Tu propio primer fotograma (JPEG/PNG, recortado a 9:16)
  --as dynamic-cover|intro-video   Usar como portada animada (por defecto) o como video de presentación
  --list               Lista las tareas de video generadas para este archivo del personaje
  --resume ID          Continúa una tarea anterior: lo que ya se aceptó solo se consulta, sin volver a cobrar;
                       una solicitud con resultado desconocido se reenvía tal cual (mismo ID de solicitud, se
                       cobra una vez como máximo)
  --out carpeta        Dónde guardar el video de vista previa, por defecto ./yomi-media
  --accept-price / --confirm-prod / --json`,
      `yomi video -f <arquivo do personagem> [--template ID | --prompt texto] [--duration segundos] [opções]
  Gera um vídeo para o personagem com IA. Por padrão, o primeiro quadro é a capa do personagem (recortada para
  9:16): a CLI a envia, obtém uma cotação e mostra o preço e o saldo; a tarefa só é criada e as gemas só são
  cobradas depois que você digitar yes (ou --accept-price); uma falha é reembolsada automaticamente. O
  resultado fica salvo nesta máquina e é enviado na próxima vez que você executar yomi create com este arquivo do
  personagem (o yomi preview não inclui o vídeo).
  --options            Lista os templates, durações e preços de tabela (sem cobrança)
  --template ID        Template; sem ele, um vídeo personalizado (--prompt texto)
  --duration segundos  Duração (padrão: a do template ou a do vídeo personalizado)
  --frame imagem       Seu próprio primeiro quadro (JPEG/PNG, recortado para 9:16)
  --as dynamic-cover|intro-video   Usar como capa animada (padrão) ou como vídeo de apresentação
  --list               Lista as tarefas de vídeo geradas para este arquivo do personagem
  --resume ID          Continua uma tarefa anterior: o que já foi aceito só é consultado, sem cobrar de novo;
                       uma solicitação com resultado desconhecido é reenviada como está (mesmo ID da
                       solicitação, cobrada no máximo uma vez)
  --out pasta          Onde salvar a prévia do vídeo, padrão ./yomi-media
  --accept-price / --confirm-prod / --json`,
    ),
    persona: tr(
      `yomi persona list
yomi persona avatar -p <描述> [--persona ID | --new --name 名字 --gender male|female|other --age N] [选项]
  AI 生成聊天人设（主控）头像，选一张写进人设。先显示单价、张数、总价和余额，输入 yes 才扣钻石；
  失败或未通过内容检查的那张不扣费。
  --options            列出可用模型和风格（不扣费）
  --count N            张数（默认按服务端上限）
  --reference 图片      参考图
  --pick N             直接用第 N 张；不写时交互选择，非交互只下载不写入
  --out 目录           保存位置，默认 ./yomi-media
  --resume 请求ID       继续之前的一次生成：已受理的只查看，不再扣费；答复未知的请求会原样
                       重发（同一请求 ID，最多扣一次）
  --create-again       新建人设的结果未知、persona list 里确认没有它时，非交互地再建一次
  --accept-price / --confirm-prod / --json`,
      `yomi persona list
yomi persona avatar -p <prompt> [--persona ID | --new --name name --gender male|female|other --age N] [options]
  Generates chat persona avatars with AI; pick one to write into the persona. Shows the unit price, count, total
  and balance first; gems are charged only after you type yes. An image that fails or does not pass the
  content check is not charged.
  --options            List the available models and styles (no charge)
  --count N            Number of images (default: the server's limit)
  --reference image    Reference image
  --pick N             Use the Nth image directly; without it, pick interactively (a non-interactive run only
                       downloads, writes nothing)
  --out dir            Where to save, default ./yomi-media
  --resume ID          Continue an earlier generation: what was accepted is only checked, not charged again; a
                       request with an unknown outcome is resent as is (same request ID, charged once at most)
  --create-again       When creating the new persona had an unknown outcome and persona list shows it is not
                       there, create it again non-interactively
  --accept-price / --confirm-prod / --json`,
      `yomi persona list
yomi persona avatar -p <prompt> [--persona ID | --new --name nombre --gender male|female|other --age N] [opciones]
  Genera avatares de persona de chat con IA; elige uno para escribirlo en la persona. Primero muestra el precio
  unitario, la cantidad, el total y el saldo; las gemas se cobran solo después de que escribas yes. Una imagen
  que falla o no pasa la verificación de contenido no se cobra.
  --options            Lista los modelos y estilos disponibles (sin cobro)
  --count N            Cantidad de imágenes (por defecto: el límite del servidor)
  --reference imagen   Imagen de referencia
  --pick N             Usa directamente la imagen N; sin esto, eliges de forma interactiva (sin interacción solo
                       descarga, no escribe nada)
  --out carpeta        Dónde guardar, por defecto ./yomi-media
  --resume ID          Continúa una generación anterior: lo que ya se aceptó solo se consulta, sin volver a
                       cobrar; una solicitud con resultado desconocido se reenvía tal cual (mismo ID de
                       solicitud, se cobra una vez como máximo)
  --create-again       Cuando crear la persona nueva tuvo un resultado desconocido y persona list muestra que no
                       está, la crea de nuevo sin interacción
  --accept-price / --confirm-prod / --json`,
      `yomi persona list
yomi persona avatar -p <prompt> [--persona ID | --new --name nome --gender male|female|other --age N] [opções]
  Gera avatares de persona de chat com IA; escolha um para gravar na persona. Primeiro mostra o preço unitário,
  a quantidade, o total e o saldo; as gemas só são cobradas depois que você digitar yes. Uma imagem que falha
  ou não passa na verificação de conteúdo não é cobrada.
  --options            Lista os modelos e estilos disponíveis (sem cobrança)
  --count N            Número de imagens (padrão: o limite do servidor)
  --reference imagem   Imagem de referência
  --pick N             Usa a imagem N diretamente; sem isso, você escolhe de forma interativa (uma execução
                       não interativa só baixa, não grava nada)
  --out pasta          Onde salvar, padrão ./yomi-media
  --resume ID          Continua uma geração anterior: o que já foi aceito só é consultado, sem cobrar de novo;
                       uma solicitação com resultado desconhecido é reenviada como está (mesmo ID da
                       solicitação, cobrada no máximo uma vez)
  --create-again       Quando a criação da nova persona teve resultado desconhecido e persona list mostra que
                       ela não está lá, cria novamente de forma não interativa
  --accept-price / --confirm-prod / --json`,
    ),
    relay: tr(
      `yomi relay [--channel telegram|qq|wechat] [--bot 名字] [--character ID] [--max-spend 钻石] [选项]
  把你本人在私聊里发给自己 bot 的消息转给 Yomi 角色，再把角色的回复发回去。不指定通道和 bot 时，一个进程
  运行这台电脑上登记的所有 bot（共用一次 Yomi 登录和一个花费上限）。通道：
    telegram   你在 @BotFather 建的 Telegram bot，回复流式显示（--telegram 等同 --channel telegram）
    qq         你自己在 QQ 开放平台（q.qq.com）建的 QQ bot，只用私聊（仅限个人使用）
    wechat     微信 ClawBot（iLink），扫码登录（实验功能，仅限个人使用；要加 --experimental）
  只服务配对过的本人。默认不设花费上限：和在 App 里一样按 Yomi 的正常规则扣费，钻石不足时会在聊天
  里提示，relay 继续运行。上限都是可选的：本机的 --max-spend（累计花费，聊天里不能重置；0 表示只用
  免费额度），以及聊天里的 /budget <数量>（Telegram 点按钮确认，QQ 和微信回复确认码）。详见：
    ${docUrl('relay.md')}
    ${docUrl('relay-qq.md')}
    ${docUrl('relay-wechat.md')}
  --set-token           Telegram：添加 bot，或给 --bot 名字 重新设置 token（终端里输入，不显示；或配合
                        --token-stdin）
  --set-app             QQ：添加 bot，或给 --bot 名字 重新设置 AppID 和 AppSecret（AppSecret 不显示；
                        或配合 --token-stdin）
  --login               微信：扫码连接你的 ClawBot（添加 bot，或给 --bot 名字 重新登录），扫码的人就是
                        主人（只能在终端里）。一个微信号只连一个 ClawBot：换角色用 --bot 名字 --character ID
  --qr-link             微信：和 --login 一起用，同时打印二维码的链接
  --token-stdin         从标准输入读凭证（Telegram：token；QQ：第一行 AppID，第二行 AppSecret），
                        不接受命令行参数和环境变量
  --experimental        使用微信通道时必须加
  --pair                重新配对（Telegram、QQ：会显示新的配对码）
  --character ID        这个 bot 对话的角色：添加时给出，或之后用 --bot 名字 --character ID 绑定（运行时只
                        绑定还没有角色的 bot）
  --bot 名字            只运行这些 bot（可以重复，或用逗号分隔；名字见 --list）；和 --character 一起用：
                        给这个 bot 换绑角色；和凭证参数一起用：重新设置它的凭证（名字是新的：添加一个）
  --max-spend 数量      可选的本机花费上限：relay 在这台电脑上累计最多花的钻石（默认不设上限；
                        0：只用免费额度）
  --reset-spend         重新计算 relay 的累计花费（有没有上限都适用）
  --allow-file-store    没有系统钥匙串时，允许把凭证和会话存成 0600 文件
  --install-service     安装一个后台服务，在一个进程里运行全部 bot（macOS launchd / Linux systemd --user），
                        替换旧版按通道分开的服务；还没配对（微信：还没登录）的 bot 会被指出，不能运行
  --uninstall-service   停止并删除后台服务（包括旧版按通道分开的服务），bot 保留
  --service-status      查看后台服务和每个 bot 的状态
  --list                列出这台电脑上的 bot：通道、角色、主人和状态（可以加 --channel 只看一个通道）
  --forget              删除 bot：--forget --bot 名字；--channel <通道> --forget（这个通道只有一个 bot 时）；
                        --forget --all 删除全部（包括后台服务和花费记录）
  改动 bot 时后台服务在运行，会先停止它，改完后重新启动；终端里有 relay 在运行时要先停止它
  --reply-timeout 秒    等一条回复的时间，默认 120，超时后读消息记录
  --no-drafts           Telegram：不用流式草稿，改为编辑消息
  --confirm-prod        非交互在生产环境运行时明确确认`,
      `yomi relay [--channel telegram|qq|wechat] [--bot name] [--character ID] [--max-spend gems] [options]
  Relays the messages you yourself send your own bot in a private chat to a Yomi character, and sends the
  character's replies back. Without a channel or a bot, one process runs every bot registered on this
  computer (one Yomi sign-in and one spending cap for all). Channels:
    telegram   A Telegram bot you created with @BotFather; replies stream in (--telegram is the same as
               --channel telegram)
    qq         Your own QQ bot from the QQ Open Platform (q.qq.com), private chat only (personal use only)
    wechat     WeChat ClawBot (iLink), signed in with a QR code (experimental, personal use only; needs
               --experimental)
  Serves only the paired owner. By default there is no spending cap: Yomi charges by its normal rules, as in
  the app, and when the balance is too low the relay says so in the chat and keeps running. Optional caps:
  --max-spend on this computer (a running total nothing in the chat resets; 0 means free replies only) and
  /budget <amount> in the chat (confirmed with a button in Telegram, a typed code in QQ and WeChat). Details:
    ${docUrl('relay.md')}
    ${docUrl('relay-qq.md')}
    ${docUrl('relay-wechat.md')}
  --set-token           Telegram: add a bot, or set the token of --bot name again (typed in the terminal,
                        hidden; or with --token-stdin)
  --set-app             QQ: add a bot, or set the AppID and AppSecret of --bot name again (the AppSecret
                        hidden; or both with --token-stdin)
  --login               WeChat: link your ClawBot by scanning a QR code (add a bot, or sign --bot name in
                        again); whoever scans it is the owner (in a terminal only). One WeChat account links
                        one ClawBot: to change its character, use --bot name --character ID
  --qr-link             WeChat, with --login: also print the QR code's link
  --token-stdin         Read the credentials from standard input (Telegram: the token; QQ: the AppID on line 1,
                        the AppSecret on line 2), never from arguments or environment variables
  --experimental        Required for the WeChat channel
  --pair                Pair again (Telegram, QQ: shows a new pairing code)
  --character ID        The character this bot chats as: given when it is added, or bound later with --bot
                        name --character ID (a run binds it only to a bot that has none)
  --bot name            Run only these bots (repeat it, or separate names with commas; names in --list);
                        with --character: bind this bot to another character; with a credentials flag: set
                        its credentials again (a new name: add a bot)
  --max-spend amount    Optional local spending cap: the most gems relay may spend in total on this machine
                        (default: no cap; 0: free replies only)
  --reset-spend         Start the relay's running spending total over (with or without a cap)
  --allow-file-store    Without a system keychain, allow keeping the credentials and session in a 0600 file
  --install-service     Install one background service that runs every bot in one process (macOS launchd /
                        Linux systemd --user), replacing the older per-channel services; a bot not paired yet
                        (WeChat: not signed in) is named and does not run
  --uninstall-service   Stop and remove the background service (and the older per-channel ones); the bots
                        stay
  --service-status      Show the background service and each bot's status
  --list                List the bots on this computer: channel, character, owner and status (add --channel
                        to see one channel)
  --forget              Remove bots: --forget --bot name; --channel <channel> --forget (a channel with one
                        bot); --forget --all for every bot (and the background service and spending records)
  Changing the bots stops a running background service and starts it again after; a relay running in a
  terminal must be stopped first
  --reply-timeout s     How long to wait for a reply, default 120; after that, read the message history
  --no-drafts           Telegram: edit messages instead of streaming drafts
  --confirm-prod        Confirm explicitly when running non-interactively in production`,
      `yomi relay [--channel telegram|qq|wechat] [--bot nombre] [--character ID] [--max-spend gemas] [opciones]
  Reenvía a un personaje de Yomi los mensajes que tú mismo le envías a tu propio bot en un chat privado, y
  devuelve las respuestas del personaje. Sin canal ni bot, un solo proceso ejecuta todos los bots registrados
  en este equipo (un inicio de sesión de Yomi y un límite de gasto para todos). Canales:
    telegram   Un bot de Telegram que creaste con @BotFather; las respuestas aparecen en tiempo real
               (--telegram equivale a --channel telegram)
    qq         Tu propio bot de QQ de la QQ Open Platform (q.qq.com), solo chat privado (solo para uso
               personal)
    wechat     WeChat ClawBot (iLink), con inicio de sesión por código QR (experimental, solo para uso
               personal; requiere --experimental)
  Solo atiende al dueño vinculado. Por defecto no hay límite de gasto: Yomi cobra según sus reglas habituales,
  como en la app, y cuando el saldo no alcanza el relay lo avisa en el chat y sigue funcionando. Límites
  opcionales: --max-spend en este equipo (un total acumulado que nada en el chat reinicia; 0 significa solo
  respuestas gratis) y /budget <cantidad> en el chat (se confirma con un botón en Telegram y con un código
  escrito en QQ y WeChat). Más detalles:
    ${docUrl('relay.md')}
    ${docUrl('relay-qq.md')}
    ${docUrl('relay-wechat.md')}
  --set-token           Telegram: agrega un bot, o vuelve a configurar el token de --bot nombre (se escribe en la
                        terminal, oculto; o con --token-stdin)
  --set-app             QQ: agrega un bot, o vuelve a configurar el AppID y el AppSecret de --bot nombre (el
                        AppSecret oculto; o ambos con --token-stdin)
  --login               WeChat: vincula tu ClawBot escaneando un código QR (agrega un bot, o vuelve a iniciar
                        la sesión de --bot nombre); quien lo escanea es el dueño (solo en una terminal). Una
                        cuenta de WeChat vincula un solo ClawBot: para cambiar su personaje, usa --bot nombre
                        --character ID
  --qr-link             WeChat, con --login: imprime también el enlace del código QR
  --token-stdin         Lee las credenciales de la entrada estándar (Telegram: el token; QQ: el AppID en la línea 1,
                        el AppSecret en la línea 2), nunca de argumentos ni de variables de entorno
  --experimental        Obligatorio para el canal de WeChat
  --pair                Vincula de nuevo (Telegram, QQ: muestra un código de vinculación nuevo)
  --character ID        El personaje con el que chatea este bot: se indica al agregarlo, o se asigna después
                        con --bot nombre --character ID (una ejecución solo se lo asigna a un bot sin personaje)
  --bot nombre          Ejecuta solo estos bots (repítelo o separa los nombres con comas; los nombres están
                        en --list); con --character: asigna otro personaje a este bot; con una opción de
                        credenciales: vuelve a configurar sus credenciales (un nombre nuevo: agrega un bot)
  --max-spend cantidad  Límite de gasto local opcional: el máximo de gemas que relay puede gastar en total en
                        este equipo (por defecto: sin límite; 0: solo respuestas gratis)
  --reset-spend         Reinicia el total acumulado de gasto del relay (con o sin límite)
  --allow-file-store    Sin llavero del sistema, permite guardar las credenciales y la sesión en un archivo 0600
  --install-service     Instala un servicio en segundo plano que ejecuta todos los bots en un solo proceso
                        (macOS launchd / Linux systemd --user) y reemplaza los servicios antiguos, uno por canal;
                        un bot todavía sin vincular (WeChat: sin iniciar sesión) se indica y no se ejecuta
  --uninstall-service   Detiene y elimina el servicio en segundo plano (y los antiguos, uno por canal); los
                        bots se conservan
  --service-status      Muestra el estado del servicio en segundo plano y de cada bot
  --list                Muestra los bots de este equipo: canal, personaje, dueño y estado (agrega --channel
                        para ver un solo canal)
  --forget              Elimina bots: --forget --bot nombre; --channel <canal> --forget (un canal con un solo
                        bot); --forget --all para todos los bots (y el servicio en segundo plano y los registros
                        de gasto)
  Cambiar los bots detiene el servicio en segundo plano que esté en ejecución y lo vuelve a iniciar después;
  un relay en ejecución en una terminal se debe detener primero
  --reply-timeout s     Cuánto esperar una respuesta, por defecto 120; después, lee el historial de mensajes
  --no-drafts           Telegram: edita los mensajes en lugar de transmitir borradores
  --confirm-prod        Confirma de forma explícita al ejecutar sin interacción en producción`,
      `yomi relay [--channel telegram|qq|wechat] [--bot nome] [--character ID] [--max-spend gemas] [opções]
  Repassa para um personagem do Yomi as mensagens que você mesmo envia ao seu próprio bot em um chat privado,
  e devolve as respostas do personagem. Sem canal nem bot, um só processo executa todos os bots registrados
  neste computador (um login do Yomi e um limite de gastos para todos). Canais:
    telegram   Um bot do Telegram que você criou com o @BotFather; as respostas aparecem em tempo real
               (--telegram é o mesmo que --channel telegram)
    qq         O seu próprio bot do QQ da QQ Open Platform (q.qq.com), só chat privado (somente para uso
               pessoal)
    wechat     WeChat ClawBot (iLink), com login por código QR (experimental, somente para uso pessoal;
               exige --experimental)
  Atende só o dono pareado. Por padrão não há limite de gastos: o Yomi cobra pelas regras normais, como no
  app, e quando o saldo fica baixo o relay avisa no chat e continua funcionando. Limites opcionais:
  --max-spend neste computador (um total acumulado que nada no chat zera; 0 significa só respostas grátis) e
  /budget <quantidade> no chat (confirmado com um botão no Telegram e com um código digitado no QQ e no
  WeChat). Mais detalhes:
    ${docUrl('relay.md')}
    ${docUrl('relay-qq.md')}
    ${docUrl('relay-wechat.md')}
  --set-token           Telegram: adiciona um bot, ou define de novo o token de --bot nome (digitado no terminal,
                        oculto; ou com --token-stdin)
  --set-app             QQ: adiciona um bot, ou define de novo o AppID e o AppSecret de --bot nome (o AppSecret
                        oculto; ou ambos com --token-stdin)
  --login               WeChat: vincula o seu ClawBot escaneando um código QR (adiciona um bot, ou entra de
                        novo com --bot nome); quem escaneia é o dono (só em um terminal). Uma conta do WeChat
                        vincula um só ClawBot: para trocar o personagem dele, use --bot nome --character ID
  --qr-link             WeChat, com --login: também imprime o link do código QR
  --token-stdin         Lê as credenciais da entrada padrão (Telegram: o token; QQ: o AppID na linha 1, o
                        AppSecret na linha 2), nunca de argumentos nem de variáveis de ambiente
  --experimental        Obrigatório para o canal do WeChat
  --pair                Pareia novamente (Telegram, QQ: mostra um novo código de pareamento)
  --character ID        O personagem com que este bot conversa: informado ao adicioná-lo, ou vinculado depois
                        com --bot nome --character ID (uma execução só o vincula a um bot sem personagem)
  --bot nome            Executa só estes bots (repita, ou separe os nomes com vírgulas; os nomes estão em
                        --list); com --character: vincula este bot a outro personagem; com uma opção de
                        credenciais: define de novo as credenciais dele (um nome novo: adiciona um bot)
  --max-spend quantia   Limite de gastos local opcional: o máximo de gemas que o relay pode gastar no total
                        nesta máquina (padrão: sem limite; 0: só respostas grátis)
  --reset-spend         Zera o total acumulado de gastos do relay (com ou sem limite)
  --allow-file-store    Sem Keychain do sistema, permite guardar as credenciais e a sessão em um arquivo 0600
  --install-service     Instala um serviço em segundo plano que executa todos os bots em um só processo (macOS
                        launchd / Linux systemd --user) e substitui os serviços antigos, um por canal; um bot
                        ainda não pareado (WeChat: sem login) é indicado e não é executado
  --uninstall-service   Para e remove o serviço em segundo plano (e os antigos, um por canal); os bots
                        continuam
  --service-status      Mostra o status do serviço em segundo plano e de cada bot
  --list                Mostra os bots deste computador: canal, personagem, dono e status (adicione --channel
                        para ver um canal só)
  --forget              Remove bots: --forget --bot nome; --channel <canal> --forget (um canal com um bot só);
                        --forget --all para todos os bots (e o serviço em segundo plano e os registros de gastos)
  Mudar os bots interrompe o serviço em segundo plano em execução e o inicia de novo depois; um relay em execução
  em um terminal precisa ser parado antes
  --reply-timeout s     Quanto tempo esperar por uma resposta, padrão 120; depois disso, lê o histórico de mensagens
  --no-drafts           Telegram: edita as mensagens em vez de transmitir rascunhos
  --confirm-prod        Confirma explicitamente ao executar de forma não interativa em produção`,
    ),
    check: tr(
      `yomi check -f <文件> [字段选项]
  按 App 的必填项和长度限制检查角色文件，不联网。`,
      `yomi check -f <file> [field options]
  Checks a character file against the app's required fields and length limits, offline.`,
      `yomi check -f <archivo> [opciones de campo]
  Revisa un archivo del personaje según los campos obligatorios y los límites de longitud de la app, sin conexión.`,
      `yomi check -f <arquivo> [opções de campo]
  Verifica um arquivo do personagem com os campos obrigatórios e os limites de tamanho do app, offline.`,
    ),
    init: tr(
      `yomi init [文件] [--force]
  写一份角色文件模板。`,
      `yomi init [file] [--force]
  Writes a character file template.`,
      `yomi init [archivo] [--force]
  Escribe una plantilla de archivo del personaje.`,
      `yomi init [arquivo] [--force]
  Grava um template de arquivo do personagem.`,
    ),
    voices: `yomi voices [--json]`,
    tags: tr(
      `yomi tags [--query 关键词] [--json]`,
      `yomi tags [--query keyword] [--json]`,
      `yomi tags [--query término] [--json]`,
      `yomi tags [--query termo] [--json]`,
    ),
    logout: `yomi logout`,
    whoami: `yomi whoami`,
  };
}

const GLOBAL: ParseArgsConfig['options'] = {
  lang: { type: 'string' },
  env: { type: 'string' },
  lane: { type: 'string' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const SPEC: ParseArgsConfig['options'] = {
  file: { type: 'string', short: 'f' },
  name: { type: 'string' },
  gender: { type: 'string' },
  description: { type: 'string' },
  opening: { type: 'string' },
  background: { type: 'string' },
  visibility: { type: 'string' },
  voice: { type: 'string' },
  tag: { type: 'string', multiple: true },
  cover: { type: 'string' },
  avatar: { type: 'string' },
  'accept-declaration': { type: 'boolean' },
  'confirm-prod': { type: 'boolean' },
};

const OPTIONS: Record<string, ParseArgsConfig['options']> = {
  login: { 'no-browser': { type: 'boolean' }, timeout: { type: 'string' } },
  logout: {},
  whoami: {},
  init: { force: { type: 'boolean' } },
  check: SPEC,
  voices: { json: { type: 'boolean' } },
  tags: { json: { type: 'boolean' }, query: { type: 'string' } },
  create: { ...SPEC, 'dry-run': { type: 'boolean' }, new: { type: 'boolean' } },
  relay: {
    channel: { type: 'string' },
    telegram: { type: 'boolean' },
    experimental: { type: 'boolean' },
    'set-token': { type: 'boolean' },
    'set-app': { type: 'boolean' },
    login: { type: 'boolean' },
    'qr-link': { type: 'boolean' },
    'token-stdin': { type: 'boolean' },
    pair: { type: 'boolean' },
    forget: { type: 'boolean' },
    character: { type: 'string' },
    'max-spend': { type: 'string' },
    'allow-file-store': { type: 'boolean' },
    'install-service': { type: 'boolean' },
    'uninstall-service': { type: 'boolean' },
    'service-status': { type: 'boolean' },
    'reply-timeout': { type: 'string' },
    'no-drafts': { type: 'boolean' },
    'confirm-prod': { type: 'boolean' },
    'reset-spend': { type: 'boolean' },
    list: { type: 'boolean' },
    bot: { type: 'string', multiple: true },
    all: { type: 'boolean' },
  },
  image: {
    prompt: { type: 'string', short: 'p' },
    model: { type: 'string' },
    style: { type: 'string' },
    count: { type: 'string' },
    ratio: { type: 'string' },
    reference: { type: 'string' },
    out: { type: 'string' },
    pick: { type: 'string' },
    into: { type: 'string' },
    as: { type: 'string' },
    resume: { type: 'string' },
    forget: { type: 'boolean' },
    options: { type: 'boolean' },
    'accept-price': { type: 'boolean' },
    'confirm-prod': { type: 'boolean' },
    json: { type: 'boolean' },
  },
  video: {
    ...SPEC,
    template: { type: 'string' },
    prompt: { type: 'string', short: 'p' },
    duration: { type: 'string' },
    frame: { type: 'string' },
    as: { type: 'string' },
    out: { type: 'string' },
    list: { type: 'boolean' },
    resume: { type: 'string' },
    options: { type: 'boolean' },
    'accept-price': { type: 'boolean' },
    json: { type: 'boolean' },
  },
  persona: {
    prompt: { type: 'string', short: 'p' },
    persona: { type: 'string' },
    new: { type: 'boolean' },
    name: { type: 'string' },
    gender: { type: 'string' },
    age: { type: 'string' },
    model: { type: 'string' },
    style: { type: 'string' },
    count: { type: 'string' },
    reference: { type: 'string' },
    pick: { type: 'string' },
    out: { type: 'string' },
    resume: { type: 'string' },
    'create-again': { type: 'boolean' },
    options: { type: 'boolean' },
    'accept-price': { type: 'boolean' },
    'confirm-prod': { type: 'boolean' },
    json: { type: 'boolean' },
  },
  preview: {
    ...SPEC,
    message: { type: 'string', short: 'm', multiple: true },
    'allow-paid': { type: 'boolean' },
    'reply-timeout': { type: 'string' },
  },
};

type Values = Record<string, string | boolean | string[] | undefined>;

function specFrom(values: Values): CharacterSpec {
  const file = values.file as string | undefined;
  const base = file ? loadSpecFile(file) : null;
  const overrides: Record<string, unknown> = {};
  for (const key of [
    'name',
    'gender',
    'description',
    'opening',
    'background',
    'visibility',
    'voice',
    'cover',
    'avatar',
  ])
    if (typeof values[key] === 'string') overrides[key] = values[key];
  if (Array.isArray(values.tag)) overrides.tags = values.tag;
  if (!base && Object.keys(overrides).length === 0)
    throw new UsageError(
      tr(
        '需要角色文件：-f character.yaml（yomi init 生成模板）',
        'A character file is needed: -f character.yaml (yomi init writes a template)',
        'Se necesita un archivo del personaje: -f character.yaml (yomi init escribe una plantilla)',
        'É preciso um arquivo do personagem: -f character.yaml (yomi init grava um template)',
      ),
    );
  if (!base) return specFromObject(overrides);
  if (Object.keys(overrides).length === 0) return base;
  const patched = specFromObject(overrides);
  const merged: CharacterSpec = { ...base };
  const empty = emptySpec();
  for (const key of Object.keys(patched) as (keyof CharacterSpec)[]) {
    if (key === 'source') continue;
    if (JSON.stringify(patched[key]) !== JSON.stringify(empty[key]))
      (merged as Record<string, unknown>)[key] = patched[key];
  }
  return merged;
}

function seconds(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3600)
    throw new UsageError(
      tr(
        `${label} 必须是 1–3600 之间的秒数`,
        `${label} must be a number of seconds from 1 to 3600`,
        `${label} debe ser un número de segundos entre 1 y 3600`,
        `${label} deve ser um número de segundos de 1 a 3600`,
      ),
    );
  return parsed;
}

/** A whole number option within [min, max], or null when it is not given. */
function whole(value: unknown, label: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new UsageError(
      tr(
        `${label} 必须是 ${min}–${max} 的整数`,
        `${label} must be a whole number from ${min} to ${max}`,
        `${label} debe ser un número entero entre ${min} y ${max}`,
        `${label} deve ser um número inteiro de ${min} a ${max}`,
      ),
    );
  return parsed;
}

/** `--max-spend`: null when absent (no local cap), else 0 to 1,000,000 (0: free replies only). */
function gems(value: unknown): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000)
    throw new UsageError(
      tr(
        '--max-spend 必须是 0–1000000 的整数（钻石）',
        '--max-spend must be a whole number of gems from 0 to 1000000',
        '--max-spend debe ser un número entero de gemas entre 0 y 1000000',
        '--max-spend deve ser um número inteiro de gemas de 0 a 1000000',
      ),
    );
  return parsed;
}

/** What `yomi relay --list` may be given besides the global options. */
const LIST_GOES_WITH = new Set([
  'list',
  'channel',
  'telegram',
  'experimental',
  'allow-file-store',
  ...Object.keys(GLOBAL ?? {}),
]);

/** What `yomi relay --bot NAME --character ID` may be given besides those two and the global options. */
const BOT_GOES_WITH = new Set([
  'bot',
  'character',
  'channel',
  'telegram',
  'experimental',
  'allow-file-store',
  ...Object.keys(GLOBAL ?? {}),
]);

/** What `--bot` does not take: the background service, which runs every bot. */
const BOT_RUN_REFUSES = new Set(['install-service', 'uninstall-service', 'service-status']);

/** The flags that set a bot's credentials (with `--bot` and `--character`: a bot added). */
const CREDENTIALS = ['set-token', 'set-app', 'login'];

/**
 * Which relay: `--channel telegram|qq|wechat`, or `--telegram` (the same as `--channel telegram`,
 * kept for good). Both naming different channels or an unknown name is a usage error; neither is
 * null: every channel (`--list`, a run of every registered bot), or the channels of the bots
 * `--bot` names (a registered bot's credentials, `--forget --bot`). Adding a bot needs one named;
 * the background service runs every bot, whichever is named (commands/relay.ts).
 */
export function relayChannelKind(values: Values): ChannelKind | null {
  const alias = Boolean(values.telegram);
  const named = values.channel as string | undefined;
  if (named === undefined) return alias ? 'telegram' : null;
  const kind = CHANNEL_KINDS.find((item) => item === named.trim().toLowerCase());
  if (!kind) {
    // Shown back only when it reads like a name: a token pasted here must not be printed.
    const word = named.trim();
    const shown = /^[A-Za-z]{1,16}$/.test(word) ? JSON.stringify(word) : '';
    throw new UsageError(
      tr(
        `不认识的通道${shown ? `：${shown}` : ''}。可选 telegram、qq、wechat`,
        `Unknown channel${shown ? `: ${shown}` : ''}. Choose telegram, qq or wechat`,
        `Canal desconocido${shown ? `: ${shown}` : ''}. Elige telegram, qq o wechat`,
        `Canal desconhecido${shown ? `: ${shown}` : ''}. Escolha telegram, qq ou wechat`,
      ),
    );
  }
  if (alias && kind !== 'telegram')
    throw new UsageError(
      tr(
        `--telegram 和 --channel ${kind} 不能同时使用`,
        `--telegram and --channel ${kind} cannot be used together`,
        `--telegram y --channel ${kind} no se pueden usar juntos`,
        `--telegram e --channel ${kind} não podem ser usados juntos`,
      ),
    );
  return kind;
}

/**
 * `--lang zh|en` (or `--lang=…`) anywhere on the line: undefined when absent, null when the value is
 * neither (refused by `main`).
 */
function langFlag(argv: string[]): Language | null | undefined {
  const at = argv.findIndex((arg) => arg === '--lang' || arg.startsWith('--lang='));
  if (at < 0) return undefined;
  const value = argv[at].startsWith('--lang=') ? argv[at].slice('--lang='.length) : argv[at + 1];
  return /^(zh|en|es|pt)([-_].*)?$/i.test(value ?? '') ? parseLanguage(value) : null;
}

/** The arguments with `--lang` and its value taken out (it may come before the command). */
function withoutLang(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') i++;
    else if (!argv[i].startsWith('--lang=')) out.push(argv[i]);
  }
  return out;
}

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const requested = langFlag(argv);
  if (requested === null) {
    io.stderr.write(
      '--lang 只能是 zh、en、es 或 pt / --lang must be zh, en, es or pt / --lang debe ser zh, en, es o pt / --lang deve ser zh, en, es ou pt\n', // i18n-ignore
    );
    return 2;
  }
  // For this run only: the next one (a test, a second command) starts from the environment again.
  setLanguage(requested ?? null);
  try {
    return await run(withoutLang(argv), io);
  } finally {
    setLanguage(null);
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  process.exitCode = undefined;
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const rest = command ? argv.slice(1) : argv;
  if (!command) {
    const { values } = parseArgs({ args: rest, options: GLOBAL, strict: false });
    say(io, values.version ? VERSION : help());
    return 0;
  }
  if (command === 'help') {
    say(io, commandHelp()[rest[0] ?? ''] ?? help());
    return 0;
  }
  const own = OPTIONS[command];
  if (!own) {
    io.stderr.write(
      tr(
        `不认识的命令：${command}\n\n`,
        `Unknown command: ${command}\n\n`,
        `Comando desconocido: ${command}\n\n`,
        `Comando desconhecido: ${command}\n\n`,
      ) + help(),
    );
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL, ...own },
      allowPositionals: command === 'init' || command === 'persona',
      strict: true,
    });
  } catch (error) {
    // A token pasted as an argument must not be printed back.
    io.stderr.write(
      `${redact(error instanceof Error ? error.message : String(error))}\n\n${commandHelp()[command]}\n`,
    );
    return 2;
  }
  const values = parsed.values as Values;
  if (values.help) {
    say(io, commandHelp()[command]);
    return 0;
  }
  try {
    const globals: GlobalOptions = {
      env: values.env as string | undefined,
      lane: values.lane as string | undefined,
      debug: values.debug as boolean | undefined,
    };
    // Before the context: the server tells relays apart by this User-Agent suffix (several
    // channels: each bot's requests still name its own, commands/relay.ts).
    const relayKind = command === 'relay' ? relayChannelKind(values) : null;
    const context = createContext(
      io,
      globals,
      command === 'relay'
        ? { client: relayKind ? `relay-${relayKind}` : 'relay-multi', channel: 'cli_relay' }
        : {},
    );
    switch (command) {
      case 'login':
        await login(context, {
          browser: !values['no-browser'],
          timeoutSeconds: seconds(values.timeout, 300, '--timeout'),
        });
        break;
      case 'logout':
        await logout(context);
        break;
      case 'whoami':
        await whoami(context);
        break;
      case 'init':
        init(context, parsed.positionals[0] ?? 'character.yaml', Boolean(values.force));
        break;
      case 'check':
        check(context, specFrom(values));
        break;
      case 'voices':
        await voices(context, { json: Boolean(values.json) });
        break;
      case 'tags':
        await tags(context, { json: Boolean(values.json), query: (values.query as string) ?? '' });
        break;
      case 'create':
        await create(context, specFrom(values), {
          acceptDeclaration: Boolean(values['accept-declaration']),
          confirmProd: Boolean(values['confirm-prod']),
          dryRun: Boolean(values['dry-run']),
          fresh: Boolean(values.new),
        });
        break;
      case 'preview':
        await preview(context, specFrom(values), {
          acceptDeclaration: Boolean(values['accept-declaration']),
          confirmProd: Boolean(values['confirm-prod']),
          messages: (values.message as string[] | undefined) ?? [],
          allowPaid: Boolean(values['allow-paid']),
          replyTimeoutMs: seconds(values['reply-timeout'], 90, '--reply-timeout') * 1000,
        });
        break;
      case 'image':
        await image(context, {
          prompt: (values.prompt as string | undefined) ?? '',
          model: (values.model as string | undefined) ?? '',
          style: (values.style as string | undefined) ?? '',
          count: whole(values.count, '--count', 1, 4),
          ratio: (values.ratio as string | undefined) ?? '',
          reference: (values.reference as string | undefined) ?? '',
          out: (values.out as string | undefined) ?? '',
          pick: whole(values.pick, '--pick', 1, 4),
          into: (values.into as string | undefined) ?? '',
          as: (values.as as string | undefined) ?? '',
          resume: (values.resume as string | undefined) ?? '',
          forget: Boolean(values.forget),
          listOptions: Boolean(values.options),
          acceptPrice: Boolean(values['accept-price']),
          confirmProd: Boolean(values['confirm-prod']),
          json: Boolean(values.json),
        });
        break;
      case 'video': {
        const needsFile = !values.options;
        await video(context, needsFile ? specFrom(values) : null, {
          template: (values.template as string | undefined) ?? '',
          prompt: (values.prompt as string | undefined) ?? '',
          duration: whole(values.duration, '--duration', 1, 600),
          frame: (values.frame as string | undefined) ?? '',
          as: (values.as as string | undefined) ?? '',
          out: (values.out as string | undefined) ?? '',
          list: Boolean(values.list),
          resume: (values.resume as string | undefined) ?? '',
          listOptions: Boolean(values.options),
          acceptPrice: Boolean(values['accept-price']),
          confirmProd: Boolean(values['confirm-prod']),
          json: Boolean(values.json),
        });
        break;
      }
      case 'persona':
        await persona(context, parsed.positionals[0] ?? '', {
          prompt: (values.prompt as string | undefined) ?? '',
          persona: (values.persona as string | undefined) ?? '',
          create: Boolean(values.new),
          name: (values.name as string | undefined) ?? '',
          gender: (values.gender as string | undefined) ?? '',
          age: whole(values.age, '--age', 18, 150),
          model: (values.model as string | undefined) ?? '',
          style: (values.style as string | undefined) ?? '',
          count: whole(values.count, '--count', 1, 16),
          reference: (values.reference as string | undefined) ?? '',
          pick: whole(values.pick, '--pick', 1, 16),
          out: (values.out as string | undefined) ?? '',
          resume: (values.resume as string | undefined) ?? '',
          createAgain: Boolean(values['create-again']),
          listOptions: Boolean(values.options),
          acceptPrice: Boolean(values['accept-price']),
          confirmProd: Boolean(values['confirm-prod']),
          json: Boolean(values.json),
        });
        break;
      case 'relay':
        if (values.list) {
          const others = Object.keys(values).filter(
            (key) => values[key] !== undefined && !LIST_GOES_WITH.has(key),
          );
          if (others.length)
            throw new UsageError(
              tr(
                `--list 只列出 bot，不能和 --${others[0]} 一起用（可以加 --channel 只看一个通道）`,
                `--list only lists the bots and does not go with --${others[0]} (add --channel to see one channel)`,
                `--list solo muestra los bots y no se usa con --${others[0]} (agrega --channel para ver un solo canal)`,
                `--list só mostra os bots e não é usado com --${others[0]} (adicione --channel para ver um canal só)`,
              ),
            );
          await relayList(context, relayKind);
          break;
        }
        const bots = ((values.bot as string[] | undefined) ?? [])
          .flatMap((value) => value.split(','))
          .map((name) => name.trim())
          .filter(Boolean);
        // An empty name (an unset variable, say) would widen the run to every bot.
        if (values.bot !== undefined && !bots.length)
          throw new UsageError(
            tr(
              '--bot 需要一个 bot 名字（名字见 yomi relay --list）',
              '--bot needs a bot name (the names are in yomi relay --list)',
              '--bot necesita el nombre de un bot (los nombres están en yomi relay --list)',
              '--bot precisa do nome de um bot (os nomes estão em yomi relay --list)',
            ),
          );
        const credentials = CREDENTIALS.some((key) => values[key] !== undefined);
        if (values.bot !== undefined && values.character !== undefined && !credentials) {
          const others = Object.keys(values).filter(
            (key) => values[key] !== undefined && !BOT_GOES_WITH.has(key),
          );
          if (others.length)
            throw new UsageError(
              tr(
                `--bot 和 --character 一起用是给 bot 换绑角色，不能再加 --${others[0]}：yomi relay --bot 名字 --character ID`,
                `--bot with --character binds a bot to another character and does not go with --${others[0]}: yomi relay --bot NAME --character ID`,
                `--bot con --character vincula un bot a otro personaje y no se usa con --${others[0]}: yomi relay --bot NOMBRE --character ID`,
                `--bot com --character vincula um bot a outro personagem e não é usado com --${others[0]}: yomi relay --bot NOME --character ID`,
              ),
            );
          if (bots.length !== 1)
            throw new UsageError(
              tr(
                '一次只能给一个 bot 换绑角色：yomi relay --bot 名字 --character ID',
                'Bind one bot at a time: yomi relay --bot NAME --character ID',
                'Vincula un bot a la vez: yomi relay --bot NOMBRE --character ID',
                'Vincule um bot de cada vez: yomi relay --bot NOME --character ID',
              ),
            );
          await relayRebind(context, {
            bot: bots[0],
            characterId: String(values.character),
            channel: relayKind,
          });
          break;
        }
        if (values.bot !== undefined) {
          const others = Object.keys(values).filter(
            (key) => values[key] !== undefined && BOT_RUN_REFUSES.has(key),
          );
          if (others.length)
            throw new UsageError(
              tr(
                `--bot 不能和 --${others[0]} 一起用：后台服务运行这台电脑上的全部 bot（yomi relay --${others[0]}）`,
                `--bot does not go with --${others[0]}: the background service runs every bot on this computer (yomi relay --${others[0]})`,
                `--bot no se usa con --${others[0]}: el servicio en segundo plano ejecuta todos los bots de este equipo (yomi relay --${others[0]})`,
                `--bot não é usado com --${others[0]}: o serviço em segundo plano executa todos os bots deste computador (yomi relay --${others[0]})`,
              ),
            );
        }
        await relay(context, {
          channel: relayKind,
          bots,
          experimental: Boolean(values.experimental),
          setToken: Boolean(values['set-token']),
          setApp: Boolean(values['set-app']),
          login: Boolean(values.login),
          qrLink: Boolean(values['qr-link']),
          tokenStdin: Boolean(values['token-stdin']),
          pair: Boolean(values.pair),
          forget: Boolean(values.forget),
          all: Boolean(values.all),
          characterId: (values.character as string | undefined) ?? '',
          maxSpend: gems(values['max-spend']),
          allowFileStore: Boolean(values['allow-file-store']),
          installService: Boolean(values['install-service']),
          uninstallService: Boolean(values['uninstall-service']),
          serviceStatus: Boolean(values['service-status']),
          replyTimeoutMs: seconds(values['reply-timeout'], 120, '--reply-timeout') * 1000,
          drafts: !values['no-drafts'],
          confirmProd: Boolean(values['confirm-prod']),
          resetSpend: Boolean(values['reset-spend']),
        });
        break;
    }
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    reportError(io, error);
    return 1;
  }
}

function reportError(io: Io, error: unknown) {
  const line = (text: string) => io.stderr.write(paint(io, 'red', redact(text)) + '\n');
  if (error instanceof SpecError) {
    line(
      tr(
        '角色文件有问题：',
        'The character file has problems:',
        'El archivo del personaje tiene problemas:',
        'O arquivo do personagem tem problemas:',
      ),
    );
    for (const problem of error.problems) io.stderr.write(`  · ${problem}\n`);
  } else if (
    error instanceof NotSignedIn ||
    error instanceof UsageError ||
    error instanceof ImageError
  )
    line(error.message);
  else if (error instanceof UgcFailure)
    line(
      tr(
        `请求失败（${error.code}）${error.message && error.message !== error.code ? '：' + error.message : ''}`,
        `Request failed (${error.code})${error.message && error.message !== error.code ? ': ' + error.message : ''}`,
        `La solicitud falló (${error.code})${error.message && error.message !== error.code ? ': ' + error.message : ''}`,
        `Falha na solicitação (${error.code})${error.message && error.message !== error.code ? ': ' + error.message : ''}`,
      ),
    );
  else if (error instanceof ApiError) {
    if (error.needsSignIn)
      line(
        tr(
          '登录已失效，请重新运行 yomi login',
          'Your sign-in has expired; run yomi login again',
          'Tu sesión expiró; vuelve a ejecutar yomi login',
          'Seu login expirou; execute yomi login novamente',
        ),
      );
    else
      line(
        tr(
          `请求失败（${error.code}${error.path ? ' ' + error.path : ''}）${error.message ? '：' + error.message : ''}`,
          `Request failed (${error.code}${error.path ? ' ' + error.path : ''})${error.message ? ': ' + error.message : ''}`,
          `La solicitud falló (${error.code}${error.path ? ' ' + error.path : ''})${error.message ? ': ' + error.message : ''}`,
          `Falha na solicitação (${error.code}${error.path ? ' ' + error.path : ''})${error.message ? ': ' + error.message : ''}`,
        ),
      );
  } else line(error instanceof Error ? error.message : String(error));
}

const invoked = process.argv[1] ?? '';
if (/(?:^|[\\/])(cli\.js|yomi)$/.test(invoked)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    },
  );
}
