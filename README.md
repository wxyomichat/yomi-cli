# yomi-cli

Yomi 的命令行工具：在终端里通过网页授权登录、按文件创建角色、和草稿角色试聊（流式显示回复），以及把自己的 Telegram bot 私聊转给已发布的角色（实验）。调用的接口、字段规则和审核流程与 App / 网页端相同。

```bash
yomi login                                   # 打开网页授权（像 gh auth login）
yomi init lin-xia.yaml                       # 生成角色文件模板
yomi voices                                  # 查可选声音 ID
yomi check -f lin-xia.yaml                   # 按 App 规则检查（不联网）
yomi preview -f lin-xia.yaml                 # 和草稿角色试聊，不创建角色
yomi create -f lin-xia.yaml                  # 创建角色（提交即进入审核）
yomi relay --telegram --set-token            # 保存自己的 Telegram bot token（实验）
yomi relay --telegram --character <角色ID>   # Telegram 私聊 ⇄ 角色，流式回复
yomi whoami / yomi logout
```

默认连**生产环境**（API `https://api.yomichat.io`，网页 `https://www.yomichat.io`），这也是唯一内置的环境。`create`、`preview`、`relay` 在生产环境开始前会要求输入 `prod` 确认（非交互时加 `--confirm-prod`）。

测试环境由运行它的人提供，CLI 不内置它的地址：加 `--env test`（或设 `YOMI_ENV=test`），并用 `YOMI_TEST_API_ORIGIN` / `YOMI_TEST_WEB_ORIGIN` 设好它的 API 与网页地址。测试环境如有泳道，用 `--lane <名称>` 指定（加 `Lane` 请求头）。

## 安装与开发

需要 Node 22（≥ 22.4，自带 `fetch` 和 `WebSocket`）与 pnpm 10。

```bash
pnpm install
pnpm build                 # 产出 dist/，入口 dist/cli.js
node dist/cli.js --help    # 或 pnpm link --global 后直接用 yomi
pnpm verify                # 格式检查 + 类型检查 + 单元测试 + 构建
```

尚未发布到 npm。

### 不依赖真实服务的测试路径

`src/mock/server.ts` 是一个本地 mock 网关兼授权页：校验请求签名、`X-Token`、i64 ID、幂等请求号、预演入口的递增序号和免费条数，并通过真实 WebSocket 用真实的 packet + Thrift 编码推送流式回复。

- `pnpm test` 里的 `test/e2e.test.ts` 用它完整跑通 login（模拟浏览器提交授权表单）→ whoami → voices / tags → create → preview（流式回复、免费条数、付费确认）→ logout。凭证写到临时目录的文件里，不碰系统钥匙串。
- 手动体验：

  ```bash
  pnpm mock                  # 打印 mock 地址和要设的环境变量
  # 另开终端，按提示 export YOMI_API_ORIGIN / YOMI_WEB_ORIGIN / YOMI_CONFIG_DIR / YOMI_CREDENTIAL_STORE
  node dist/cli.js login     # 浏览器里会打开 mock 授权页，点「授权」
  node dist/cli.js preview -f examples/character.yaml
  ```

## 命令

| 命令                                  | 说明                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login [--no-browser] [--timeout 秒]` | 网页授权登录。终端和网页显示同一个确认码，一致再点「授权」。CLI 建立自己的会话，不影响 App 和网页的登录                                                                                                                 |
| `logout`                              | 撤销服务端会话并删除本机凭证                                                                                                                                                                                            |
| `whoami`                              | 当前账号、邮箱、钻石、凭证存放位置                                                                                                                                                                                      |
| `init [文件] [--force]`               | 写角色文件模板                                                                                                                                                                                                          |
| `check -f 文件`                       | 本地检查（必填、长度、声音配比、标签数），不联网                                                                                                                                                                        |
| `voices [--json]`                     | 声音目录（`ugc/voice/catalog`）                                                                                                                                                                                         |
| `tags [--query 词] [--json]`          | 标签目录（`npc/list_ugc_tags`，自动翻页）                                                                                                                                                                               |
| `create -f 文件`                      | 创建角色。`--dry-run` 只打印请求体；`--new` 同一内容再建一个；`--accept-declaration` 非交互确认声明                                                                                                                     |
| `preview -f 文件`                     | 预演。`-m 消息`（可重复）非交互发送；`--allow-paid` 非交互允许付费；`--reply-timeout 秒`                                                                                                                                |
| `relay --telegram`                    | 自己的 Telegram bot 私聊 ⇄ 已发布角色（实验）。配对码只给本人，默认不花钻石，付费需 `--max-spend`（本机累计上限）与 Telegram 里 `/budget` 两道确认；`--install-service` 装成后台服务。见 [docs/relay.md](docs/relay.md) |

全局：`--env prod|test`（默认 prod）、`--lane 名称`（仅测试环境）、`--debug`（请求日志，凭证脱敏）。环境变量：`YOMI_ENV`、`YOMI_LANE`、`YOMI_TEST_API_ORIGIN` / `YOMI_TEST_WEB_ORIGIN`（测试环境地址）、`YOMI_API_ORIGIN` / `YOMI_WEB_ORIGIN`（指向 mock 或本地网页构建；这样的运行不算生产）、`YOMI_CONFIG_DIR`、`YOMI_CREDENTIAL_STORE=auto|keychain|file`、`YOMI_LANG`、`NO_COLOR`。

字段选项可覆盖文件中的值：`--name --gender --description --opening --background --visibility --voice --tag（可重复）--cover --avatar`。

## 角色文件

YAML 或 JSON，见 [examples/character.yaml](examples/character.yaml)。规则与 App 和网页的创建页相同，长度按 Unicode 码点计。

| 字段                               | 规则                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`                             | 必填，≤ 50                                                                                                                |
| `gender`                           | 必填：`male` / `female` / `non-binary`（也认 男 / 女 / 非二元）                                                           |
| `description`                      | 必填，≤ 10000；`description_format: html` 时是 HTML 源码，当前接口同样 ≤ 10000                                            |
| `opening`                          | 必填，≤ 10000。引号里的对白会配音，引号外是旁白                                                                           |
| `background` / `background_public` | 选填，≤ 10000；是否对他人可见，默认否                                                                                     |
| `example_dialogue`                 | 选填，≤ 10000                                                                                                             |
| `author_note`                      | 选填，作者寄语，≤ 20000                                                                                                   |
| `visibility`                       | `public`（默认）/ `private`                                                                                               |
| `tags`                             | ≤ 10，写名称或 ID（以 `yomi tags` 为准）                                                                                  |
| `voice`                            | 必填。一个声音 ID，或 `{ voices: [{ id, weight }], pitch, speed }`：最多 4 个，权重 0–100 至少一个 > 0，音调/语速 0.5–1.5 |
| `cover`                            | 必填，形象图 1:2（App 为 720×1440），JPEG / PNG / WebP ≤ 20 MB。也可写 `{ upload_id }`（已审核通过）或 `{ asset_id }`     |
| `avatar`                           | 必填，头像 1:1（App 为 512×512）                                                                                          |

CLI 不裁剪、不转码，按比例检查后原样上传（误差 2%），请先裁好。18+ 与版权声明不写在文件里，每次 `create` / `preview` 时确认。

## 创建与预演的流程（与 App 相同）

**create**：本地检查 → 确认声明（生产再确认一次）→ 声音目录核对声音 ID → 标签目录把名称换成 ID → 图片 `npc/create_ugc_image_upload` → 预签名 PUT（不带业务凭证、不跟随重定向）→ `npc/review_ugc_image`，两张都 PASSED 才继续 → 冻结整个请求及其 `client_request_id` 后调用 `npc/create_ugc_character`。

- 创建即生成审核中的版本，无需再提交；审核通过后才公开。
- 服务端同步做文本审核：`42201` 未通过（改文本再试）、`50301` 暂不可用（稍后再试）。
- 网络错误时结果未知，再次运行会重发**当时冻结的请求**（同一请求号，服务端去重，不会重复创建）。同一文件内容创建成功后再运行会提示已创建，`--new` 才会再建一个。

**preview**：同样先检查、确认声明、上传审核图片 → `ugc/begin_ugc_draft`（每个角色文件一次，本地草稿号 `draft_<32 hex>`）→ `ugc/prepare_ugc_preview`（递增的入口号 `pv2_…`，每次进入新 CID，免费额度属于草稿不重置）→ 显示免费条数和开场白 → `conversation/send_message`（`preview_cid`）发送，回复经长连接（业务类型 5、purpose UgcPreview）流式显示；长连接不可用时改读 `ugc/list_ugc_preview_messages` → 退出时 `ugc/close_ugc_preview`。预演不会出现在正式聊天里。

交互命令：`/quota` 免费条数，`/history` 本次记录，`/quit` 退出（Ctrl+C / Ctrl+D 亦可）。

免费条数用完后：CLI 显示提示和钻石余额，输入 `yes` 才按标准费率付费发送（同一会话只问一次，与 App 一致）；非交互需 `--allow-paid`。钻石不足会提示去 App 或网页充值。

## 登录与安全

见 [docs/auth-protocol.md](docs/auth-protocol.md)（与网页授权页的约定）和 [docs/security.md](docs/security.md)（回环回调、一次性 state、凭证不进 URL 和日志、超时、存储）。以后若服务端提供一次性授权码，协议可以升级为不经手 Firebase token 的 v2（未实施）。

授权页 `/cli/auth` 由网页端提供。所连环境的网页还没有这个页面时，可以用 `YOMI_WEB_ORIGIN` 指向一个带有它的本地网页构建：`YOMI_WEB_ORIGIN=http://127.0.0.1:<端口> yomi login`。

## Telegram relay（实验）

用法、配对、命令、预算、后台服务见 [docs/relay.md](docs/relay.md)。合规提示、扣费上限、年龄与分级拦截、限流这些规则应由服务端对所有渠道统一执行，relay 只做适配。服务端通过 `relay/get_policy` 声明它已经支持哪些能力；没有声明时 relay 按最严格的默认值运行。

## 代码结构

| 路径            | 内容                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`    | 参数解析、帮助、错误输出                                                                                      |
| `src/commands/` | 各命令（login/logout/whoami、create、preview、voices/tags/init/check）                                        |
| `src/core/`     | 环境、签名请求客户端 `api.ts`（签名方式与 Yomi 网页端相同）、i64 JSON、凭证存储、本地状态、脱敏、终端交互     |
| `src/auth/`     | 回环回调、浏览器授权、Firebase token 换会话                                                                   |
| `src/ugc/`      | 角色文件解析与规则、图片检查与上传审核、声音/标签目录、创建、预演                                             |
| `src/im/`       | 长连接：packet / Thrift 编解码（与 Yomi 客户端的长连接编码一致），预演与 relay 共用的连接（重连、补偿、去重） |
| `src/chat/`     | 正式聊天接口（发消息、历史、补偿拉取、角色资料、价格、举报）                                                  |
| `src/relay/`    | Telegram relay：Bot API 客户端、配对、流式呈现、预算、策略、状态、后台服务                                    |
| `src/mock/`     | mock 网关与授权页、mock Telegram Bot API                                                                      |
| `test/`         | 单元测试与 mock 端到端测试                                                                                    |

照 Yomi 客户端协议实现的文件（请求签名、长连接编解码）在文件头注明；服务端协议变动时需要同步。

## 暂不支持

- 群聊（Multi characters）创建与预演：第二步，接口为 `group_chat/*`。
- AI 生图、动态封面、介绍视频、草稿箱、编辑已有角色（`update_ugc_character`）。
- 预演语音播放。
