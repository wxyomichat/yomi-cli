# yomi relay --telegram（实验）

把你**本人**在 Telegram 私聊里发给自己 bot 的消息，转给一个已发布的 Yomi 角色，并把角色的回复流式发回 Telegram。bot 是你自己在 @BotFather 建的，token 只存在这台电脑的系统钥匙串里；relay 只发起出站连接（Telegram 长轮询、Yomi 长连接），不在本机开端口。

服务端通过 `relay/get_policy` 声明它已经支持的能力（只用免费额度、花费上限、合规提示注入等）。没有声明之前，relay 按最严格的方式运行，下文标出了现在的行为。

## 准备

1. `yomi login`（relay 使用 CLI 自己的 Yomi 会话）。
2. 在 Telegram 里找 @BotFather，`/newbot` 建一个**专用**的 bot（不要用已经接了别的服务的 bot：relay 发现 webhook 会拒绝启动）。
3. 保存 token：

   ```sh
   yomi relay --telegram --set-token          # 粘贴 token，不显示
   # 或者（脚本里）：
   some-secret-manager read telegram-bot | yomi relay --telegram --set-token --token-stdin
   ```

   token 不接受命令行参数和环境变量（会出现在 `ps`、shell 历史、子进程里）。没有系统钥匙串（Linux 没有 Secret Service 时）relay 默认拒绝启动，确认接受明文 0600 文件时才加 `--allow-file-store`。

## 运行与配对

```sh
yomi relay --telegram --character 7300000000000009001
```

第一次运行时终端会显示配对码（15 分钟内有效、只能用一次、错 5 次作废），在 Telegram 里给你的 bot 发 `/start 配对码`，或打开终端里给出的 `t.me/...?start=...` 链接。配对之后，这个 bot 只处理你本人（同一个 Telegram 账号、私聊）的消息：别人发来的消息不会转给 Yomi，也不会扣费；有人把 bot 拉进群，它会自动退出。要换人或重新配对：`yomi relay --telegram --pair`。

relay 离线时你发的消息（超过 10 分钟）不会补转，以免意外扣费。

## Telegram 里的命令

| 命令                              | 作用                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 直接发文字                        | 转给当前角色，回复流式出现（Telegram 的「思考中」草稿，可点「停止」）                                        |
| `/character [ID]`                 | 查看或切换角色（可以粘贴角色链接，取其中的 ID）。第一次和这个角色聊时会显示开场白                            |
| `/price`                          | 每条回复的价格（`reply_cost_diamonds`，仅供参考）、余额、预算                                                |
| `/budget 100` / `/budget off`     | 设置可花的钻石上限（要点按钮确认）/ 改回不花钻石                                                             |
| `/report`                         | 举报最近一条回复（或回复某条消息再发 `/report`），也可以举报角色                                             |
| `/image`                          | 根据最近一条回复生成一张图片（回复角色的某条消息再发，则根据那一条），图片以照片发回 Telegram                |
| `/image resume` / `/image forget` | 用同一个请求号继续上一次没有结果的生图（不会重复扣费）/ 放弃追踪一个结果未知的请求；已被服务端受理的不能放弃 |
| `/stop`                           | 停止转发当前回复，或停止等待图片。服务端没有中止生成的接口，**照常扣费**                                     |

## 钱

- 默认不花钻石。付费需要两道确认：
  - 电脑上启动时用 `--max-spend <钻石>` 设本机上限（默认 0，不允许付费）。这个上限是**累计**的：Telegram 里怎么重设预算都不会重置它，只有在电脑上改 `--max-spend` 的值或加 `--reset-spend` 才重新计算。即使 Telegram 账号被别人拿到，也花不过本机上限。
  - Telegram 里用 `/budget N`（N 不超过本机剩余额度）并点按钮确认。重新配对、或电脑上换了 Yomi 账号，预算都会作废，要重新确认。
- 预算用完即暂停，不会自动续，也不会自动重试发送。
- **现在**：服务端还没有确认正式聊天支持「只用免费额度」，所以没设预算前 relay 一条消息也不发。
- 每条消息都核对花费：服务端报了扣费就直接计入；否则发送前后各读一次余额，按差额计入（同时在 App 里花的钻石也会算进来，偏保守；回复期间余额反而增加时，按报价计入）。
- 读不到余额时不发送；一条消息的花费还没核对清楚（网络中断、relay 被停止、登录失效），会记在本机，下一条发送前先核对，重启后也不会丢。
- 读不到每条回复的价格时也不发送（价格未知不代表免费）。第一次给某个角色付费发送前，会先显示单价和余额。
- 免费模式下被扣了钻石会立即暂停，要用 `/budget` 设预算后才继续。
- 生图（`/image`）：免费的图片也要能读到余额才发起，而且它的原价要在本机 `--max-spend` 还能花的范围内（免费次数只是快照）；要花钻石的图片和回复一样，需要确认过的 `/budget` 且剩余预算够用。图片在送达时扣费，按任务自己的扣费状态计入预算（不看同期余额变化）。图片的任务结束之前不会结算，也不会发出新的消息或生图；已送达但扣费还没到账的，从送达起最多再等 180 秒。
- 钻石不足时只提示「请在 Yomi App 或网页充值」，不附链接（Telegram 规定 bot 里的数字商品只能用 Stars 购买）。

## 隐私与内容

- 只转发服务端审核过的段落（`paragraphs`）；生成过程中的原始文本和思考内容从不发到 Telegram。
- 只转发本 relay 自己发起的回复：你在 App 或网页上和同一角色聊天，不会出现在 Telegram。
- 对话会经过 Telegram 的服务器，由 Telegram 按其隐私政策处理；在 Yomi 里删除会话不会删掉 Telegram 里的消息。
- **现在**：relay 在会话开始和之后每 3 小时显示一条 AI 提示（含「陪伴类聊天机器人可能不适合部分未成年人」）。服务端注入合规提示后，改为只转发服务端的提示。
- 本机只保存 relay 需要的最少信息（`~/.config/yomi-cli/relay/*.json`，0600）：你的 Telegram 用户 ID 和名字、当前角色、预算、Telegram 消息与 Yomi 消息 ID 的对应（用于举报，最多 500 条）。`yomi relay --telegram --forget` 删除 token 和这些信息。

## 一直运行（后台服务）

先在终端里完成配对，再：

```sh
yomi relay --telegram --max-spend 200 --install-service    # macOS: launchd LaunchAgent；Linux: systemd --user
yomi relay --telegram --service-status
yomi relay --telegram --uninstall-service
```

- 服务里没有任何 token：启动时从钥匙串读。macOS 的登录钥匙串在你登录后才可用，所以服务只在你登录期间工作；Linux 需要桌面会话里的 Secret Service（无人值守时 `loginctl enable-linger` 并解锁 keyring，或明确使用 `--allow-file-store`）。
- 日志在 `~/.config/yomi-cli/logs/`，只记录状态（连接、转发了一条、花费），不记录消息内容和 token。
- 遇到「另一个程序在用这个 bot 收消息」「token 失效」「电脑上登录的账号变了」这类重启也解决不了的情况，relay 会说明原因并正常退出，服务不会反复重启。
- 同一个 bot 同时只能运行一个 relay（本机锁文件，加上 Telegram 自己的 409）。

## 断线与恢复

- Yomi 长连接无限次重连，电脑休眠唤醒后立即重连；每次连上先读 `poll_message` 补齐离线期间的推送，回复超时（默认 120 秒）后按消息 ID 读历史。
- Yomi 登录失效时 relay 暂停，并在 Telegram 里提醒你；在电脑上 `yomi login` 之后自动恢复。
- relay 和 `yomi create` 等命令同时刷新会话时会排队，不会互相把对方登出。
