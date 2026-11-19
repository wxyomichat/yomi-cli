# yomi relay（实验）

把你**本人**在私聊里发给自己 bot 的消息，转给一个已发布的 Yomi 角色，并把角色的回复发回这个私聊。bot 是你自己的，它的凭证只存在这台电脑的系统钥匙串里；relay 只发起出站连接（聊天平台的长轮询或长连接、Yomi 长连接），不在本机开端口。

| 通道                  | 怎样选择                                | 说明                   | 准备、配对、能力与限制                  |
| --------------------- | --------------------------------------- | ---------------------- | --------------------------------------- |
| Telegram              | `--channel telegram`（或 `--telegram`） | 实验                   | 本文的 [Telegram](#telegram) 一节       |
| QQ                    | `--channel qq`                          | 仅限个人使用           | [docs/relay-qq.md](relay-qq.md)         |
| 微信 ClawBot（iLink） | `--channel wechat --experimental`       | 实验功能，仅限个人使用 | [docs/relay-wechat.md](relay-wechat.md) |

下文的运行方式、聊天里的命令、钱、隐私和后台服务对所有通道相同；各通道自己的部分（怎样拿到 bot、怎样配对、能不能流式显示、离线时的消息）在各自的文档里。

服务端通过 `relay/get_policy` 声明它已经支持的能力（只用免费额度、花费上限、合规提示注入等），请求里带着通道名。没有声明之前，relay 按最严格的方式运行，下文标出了现在的行为。在生产环境，QQ 和微信只在服务端明确为这个通道返回了策略时才转发；否则每条消息都只会收到「服务端已关闭」的答复，不转发、不扣费，服务端开放后自动恢复。测试环境和自定义地址只提示一句，照常运行。

## 运行与配对

先 `yomi login`（relay 使用 CLI 自己的 Yomi 会话），保存好通道的凭证（见各通道的文档），然后：

```sh
yomi relay --channel telegram --character 7300000000000009001
```

- 只服务配对过的本人：Telegram 和 QQ 在终端里显示一次性的配对码（15 分钟内有效、只能用一次、同一个人错 5 次作废），在聊天里发给 bot；微信是扫码登录的人。之后别人发来的消息不会转给 Yomi，也不会扣费。要换人：`--pair`（Telegram、QQ）或重新 `--login`（微信）。
- relay 离线时你发的消息（超过 10 分钟）不会补转，以免意外扣费。
- 凭证不接受命令行参数和环境变量（会出现在 `ps`、shell 历史、子进程里）：在终端里输入（不显示），或用 `--token-stdin` 从标准输入读。没有系统钥匙串（Linux 没有 Secret Service 时）relay 默认拒绝启动，确认接受明文 0600 文件时才加 `--allow-file-store`。
- QQ 和微信启动时会提示「仅限个人使用」；微信还会提示它是实验功能，不加 `--experimental` 不启动。

## 聊天里的命令

| 命令                              | 作用                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 直接发文字                        | 转给当前角色，把回复发回来（Telegram 是可以点「停止」的「思考中」草稿，其他通道见各自的文档）                |
| `/character [ID]`                 | 查看或切换角色（可以粘贴角色链接，取其中的 ID）。第一次和这个角色聊时会显示开场白                            |
| `/price`                          | 每条回复的价格（`reply_cost_diamonds`，仅供参考）、余额、预算                                                |
| `/budget 100` / `/budget off`     | 设置可花的钻石上限（要确认）/ 改回不花钻石                                                                   |
| `/report`                         | 举报最近一条回复（Telegram 也可以回复某条消息再发 `/report`），也可以举报角色                                |
| `/image`                          | 根据最近一条回复生成一张图片（Telegram 里回复角色的某条消息再发，则根据那一条），图片发回聊天                |
| `/image resume` / `/image forget` | 用同一个请求号继续上一次没有结果的生图（不会重复扣费）/ 放弃追踪一个结果未知的请求；已被服务端受理的不能放弃 |
| `/stop`                           | 停止转发当前回复，或停止等待图片。服务端没有中止生成的接口，**照常扣费**                                     |

需要你确认的地方（`/budget`、`/report` 的选项）：Telegram 点按钮；QQ 和微信没有按钮，消息里给出一个一次性代码和带编号的选项，回复「代码 序号」（例如 `K7Q2 1`）选择，10 分钟内有效，重启后旧代码只会得到「已过期」。

## 钱

- 默认不花钻石。付费需要两道确认：
  - 电脑上启动时用 `--max-spend <钻石>` 设本机上限（默认 0，不允许付费）。这个上限是**累计**的：聊天里怎么重设预算都不会重置它，只有在电脑上改 `--max-spend` 的值或加 `--reset-spend` 才重新计算。即使聊天账号被别人拿到，也花不过本机上限。
  - 聊天里用 `/budget N`（N 不超过本机剩余额度）并确认。重新配对、或电脑上换了 Yomi 账号，预算都会作废，要重新确认。
- 预算用完即暂停，不会自动续，也不会自动重试发送。
- **现在**：服务端还没有确认正式聊天支持「只用免费额度」，所以没设预算前 relay 一条消息也不发。
- 每条消息都核对花费：服务端报了扣费就直接计入；否则发送前后各读一次余额，按差额计入（同时在 App 里花的钻石也会算进来，偏保守；回复期间余额反而增加时，按报价计入）。
- 读不到余额时不发送；一条消息的花费还没核对清楚（网络中断、relay 被停止、登录失效），会记在本机，下一条发送前先核对，重启后也不会丢。
- 读不到每条回复的价格时也不发送（价格未知不代表免费）。第一次给某个角色付费发送前，会先显示单价和余额。
- 免费模式下被扣了钻石会立即暂停，要用 `/budget` 设预算后才继续。
- 生图（`/image`）：免费的图片也要能读到余额才发起，而且它的原价要在本机 `--max-spend` 还能花的范围内（免费次数只是快照）；要花钻石的图片和回复一样，需要确认过的 `/budget` 且剩余预算够用。图片在送达时扣费，按任务自己的扣费状态计入预算（不看同期余额变化）。图片的任务结束之前不会结算，也不会发出新的消息或生图；已送达但扣费还没到账的，从送达起最多再等 180 秒。
- 钻石不足时只提示「请在 Yomi App 或网页充值」，不附链接（Telegram 规定 bot 里的数字商品只能用 Stars 购买；其他通道同样处理）。

## 隐私与内容

- 只转发服务端审核过的段落（`paragraphs`）；生成过程中的原始文本和思考内容从不发到聊天平台。
- 只转发本 relay 自己发起的回复：你在 App 或网页上和同一角色聊天，不会出现在聊天平台里。
- 对话会经过聊天平台（Telegram、QQ、微信）的服务器，由它按自己的隐私政策处理；在 Yomi 里删除会话不会删掉聊天平台里的消息。
- **现在**：relay 在会话开始和之后每 3 小时显示一条 AI 提示（含「陪伴类聊天机器人可能不适合部分未成年人」）。服务端注入合规提示后，改为只转发服务端的提示。
- 本机只保存 relay 需要的最少信息（`~/.config/yomi-cli/relay/*.json`，0600，每个 bot 一份）：你在这个平台上的用户 ID（Telegram 还有名字）、当前角色、预算、聊天消息与 Yomi 消息 ID 的对应（用于举报，最多 500 条），以及通道自己需要的少量状态（例如还没送达的提醒）。凭证不在这些文件里，只在系统钥匙串（或 `--allow-file-store` 时单独的 0600 文件）里。`yomi relay --channel <通道> --forget` 删除这个通道的凭证和这些信息，其他通道的不受影响。

## 一直运行（后台服务）

先在终端里完成配对（微信：先登录），再：

```sh
yomi relay --channel telegram --max-spend 200 --install-service    # macOS: launchd LaunchAgent；Linux: systemd --user
yomi relay --channel telegram --service-status
yomi relay --channel telegram --uninstall-service
```

- 每个通道有自己的服务：Telegram 是 `io.yomichat.yomi-cli.relay.<环境>`（Linux `yomi-relay-<环境>.service`，和以前一样），QQ 是 `….relay.qq-<环境>`（`yomi-relay-qq-<环境>.service`），微信是 `….relay.wechat-<环境>`（`yomi-relay-wechat-<环境>.service`）。
- 服务里没有任何凭证：启动时从钥匙串读。macOS 的登录钥匙串在你登录后才可用，所以服务只在你登录期间工作；Linux 需要桌面会话里的 Secret Service（无人值守时 `loginctl enable-linger` 并解锁 keyring，或明确使用 `--allow-file-store`）。
- 日志在 `~/.config/yomi-cli/logs/`，只记录状态（连接、转发了一条、花费），不记录消息内容和凭证。
- 遇到「另一个程序在用这个 bot 收消息」「凭证失效」「电脑上登录的账号变了」这类重启也解决不了的情况，relay 会说明原因并正常退出，服务不会反复重启。
- 同一个 bot 同时只能运行一个 relay（本机锁文件；Telegram 还有它自己的 409）。

## 断线与恢复

- Yomi 长连接无限次重连，电脑休眠唤醒后立即重连；每次连上先读 `poll_message` 补齐离线期间的推送，回复超时（默认 120 秒）后按消息 ID 读历史。
- Yomi 登录失效时 relay 暂停，并在聊天里提醒你；在电脑上 `yomi login` 之后自动恢复。
- relay 和 `yomi create` 等命令同时刷新会话时会排队，不会互相把对方登出。

## Telegram

`--telegram` 和 `--channel telegram` 完全相同，下面用短的写法。

### 准备

1. `yomi login`。
2. 在 Telegram 里找 @BotFather，`/newbot` 建一个**专用**的 bot（不要用已经接了别的服务的 bot：relay 发现 webhook 会拒绝启动）。
3. 保存 token：

   ```sh
   yomi relay --telegram --set-token          # 粘贴 token，不显示
   # 或者（脚本里）：
   some-secret-manager read telegram-bot | yomi relay --telegram --set-token --token-stdin
   ```

### 运行与配对

```sh
yomi relay --telegram --character 7300000000000009001
```

第一次运行时终端会显示配对码，在 Telegram 里给你的 bot 发 `/start 配对码`（或 `/pair 配对码`），或打开终端里给出的 `t.me/...?start=...` 链接。配对之后，这个 bot 只处理你本人（同一个 Telegram 账号、私聊）的消息；有人把 bot 拉进群，它会自动退出。要换人或重新配对：`yomi relay --telegram --pair`。

### Telegram 的不同之处

- 回复以 Telegram 的「思考中」草稿流式出现，可以点「停止」；`--no-drafts` 改为编辑消息。
- 确认用按钮；回复（引用）某条消息再发 `/report` 或 `/image`，就针对那一条。
- 本机保存你的 Telegram 用户 ID 和名字（Bot Developer Terms §4.2 允许的最少信息）。
- token 可能泄露时，在 @BotFather 里用 `/revoke` 让它失效，再 `yomi relay --telegram --set-token` 换新的。
