# CLI 网页授权协议（v1）

`yomi login` 与 Yomi 网页端授权页 `/cli/auth` 之间的约定。安全考虑见 [security.md](security.md)。

## 为什么传 Firebase ID token

现有服务端认可的凭证：

| 凭证                                    | 有效期                                  | 用途                                      | 交给 CLI 的问题                                                |
| --------------------------------------- | --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| 网页会话 `auth_token` / `refresh_token` | auth 短期，refresh 长期，刷新会换新一对 | `X-Token`、长连接 `token`                 | CLI 与网页共用一条刷新链，一方刷新后另一方失效；而且是长期凭证 |
| Firebase ID token                       | 1 小时                                  | `account/login`（`login_type` 3）换出会话 | 短期；CLI 只用它换一次**自己的**会话，不落盘                   |

服务端目前没有 device code / 一次性授权码之类的接口，所以 v1 让网页把一枚刚取到的 Firebase ID token 交给本机 CLI，CLI 立即调用 `account/login`（`not_logout_other_device: true`，不踢掉 App 和网页的登录），得到独立的 `user_id / device_id / auth_token / refresh_token`。之后 CLI 只用这套会话，按 `account/refresh_auth_token` 续期，`yomi logout` 调 `account/logout` 撤销。Firebase token 用完即弃，不落盘、不打印。

如果以后服务端提供一次性授权码（网页用自己的会话换一个短期 code，CLI 用 code + PKCE verifier 换会话），协议可以升级为 v2，CLI 和网页都不再经手 Firebase token。（未实施）

## 流程

```
yomi login                                 浏览器（已登录 Yomi 网页）
────────────                               ───────────────────────────
生成 state（32 字节随机，base64url）
在 127.0.0.1:<随机端口> 起回调
打印确认码 XXXX-XXXX，打开 ──────────────▶ <web>/cli/auth#port=<port>&state=<state>&client=yomi-cli&version=<v>
                                           读出片段参数后立即从地址栏去掉
                                           校验参数；未登录则先登录
                                           显示账号、确认码、「授权」「取消」
                                           点授权：currentUser.getIdToken(true)
                         ◀──────────────── 表单 POST http://127.0.0.1:<port>/callback
校验 Host / Origin / state                  （state, id_token, email, display_name）
回一个「已授权，可以关闭此页」页面 ──────▶ 浏览器显示 CLI 的结果页
account/login → account/get_account
终端显示服务端返回的账号，问是否以它登录
  是：凭证存入系统钥匙串，关闭回调
  否：撤销刚建立的会话，回调继续等待
```

## 授权页 `/cli/auth`

参数放在 URL **片段**（`#` 之后）里，而不是查询串：片段不会发给任何服务器（不进 nginx / 网关访问日志），也不会出现在 Referer 里。页面读出后立即用 `history.replaceState` 把片段从地址栏去掉，参数只保留在当前标签页的历史记录状态（`history.state`）里，刷新页面仍可用；RUM 上报时也会去掉 `/cli/auth` 的片段。

片段参数（缺一不可，否则显示「链接无效」，不提供授权按钮）：

| 参数      | 规则                                          |
| --------- | --------------------------------------------- |
| `port`    | 十进制整数，1024–65535                        |
| `state`   | 43 个 base64url 字符（`^[A-Za-z0-9_-]{43}$`） |
| `client`  | 固定 `yomi-cli`                               |
| `version` | CLI 版本，仅展示                              |

页面要求：

- 不被搜索引擎收录（noindex）；`state` 不进访问日志、埋点、RUM 和 Referer（见上，片段 + 读后即删）。
- 显示当前账号（名字、邮箱）、**确认码**和提示：「只有在你刚刚于本机终端运行 `yomi login`、且终端显示同一确认码时才授权」。
- 未登录：走网页现有登录（Google / Apple），登录后回到本页。
- 「授权」点击时取新鲜的 Firebase ID token（`getIdToken(true)`）。网页会话在但 Firebase 登录态丢失（`currentUser` 为空）时，请用户在本页重新登录一次（弹窗），不要改动网页会话。
- 回传方式：**顶层表单 POST**（`<form method="POST" action="http://127.0.0.1:<port>/callback">`，`application/x-www-form-urlencoded`），不要用 `fetch`（会触发 Chrome 的本地网络访问授权弹窗，也需要 CORS）。`action` 只由校验过的 `port` 拼出，主机固定 `127.0.0.1`，路径固定 `/callback`。
- 提交前把页面的 referrer 策略设为 `origin`（`<meta name="referrer" content="origin">`）。默认策略 `strict-origin-when-cross-origin` 下，https 页面提交到 `http://127.0.0.1` 算降级，浏览器会发 `Origin: null`，CLI 会拒绝。`origin` 只带源，不带路径和片段。（2026-11-13 用 Chrome 157 和真实回调服务实测。）
- 表单字段：`state`（原样），`id_token`；`email`、`display_name` 可以带，但 CLI 不使用（终端显示的账号只取服务端返回的，防止伪造的回调冒充用户的邮箱）。取消时只发 `state` 和 `error=access_denied`。
- 凭证绝不出现在 URL 里。

### 确认码

两端用同一算法从 `state` 算出，便于用户核对终端和网页是同一次登录：

1. `digest = SHA-256(UTF-8("yomi-cli-auth:" + state))`
2. 取 `digest` 前 5 个字节，看作 40 位大端整数
3. 从高位起每 5 位一组，共 8 组，查表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
4. 前 4 位与后 4 位之间加 `-`，如 `K7QM-2XTR`

参考实现：`src/auth/loopback.ts` 的 `verificationCode`。

## CLI 回调 `POST /callback`

只监听 `127.0.0.1`，端口由系统分配。按下表的顺序校验，第一项不符即拒绝：

| 检查（按顺序）                                                                                   | 不符时 |
| ------------------------------------------------------------------------------------------------ | ------ |
| 对端是回环地址，`Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）           | 403    |
| 路径 `/callback`                                                                                 | 404    |
| 方法 POST，且 URL 不带查询串（凭证不进 URL）                                                     | 405    |
| 登录还没结束（读请求体前后各查一次；监听关闭前的片刻，之后连接直接被拒）                         | 410    |
| `Origin` 等于所选环境的网页 origin（生产为 `https://www.yomichat.io`），内容能解析，`state` 一致 | 400    |
| 终端没有在确认上一次收到的回答（token 或取消）                                                   | 409    |
| 取消（带 `error`）到此为止；否则 `id_token` 是三段 base64url（JWT 形状）                         | 400    |

无效回调一律拒绝，但**不会**结束等待：否则知道端口的人发几个错误请求就能让 CLI 停止监听，再占住空出来的端口，接住用户随后点「授权」发出的 token。400 的前三次在终端逐条提示原因，之后只提示一次；403、404、405、409、410 不在终端提示（409 的页面请用户回到终端处理）。

收到有效回答（token 或取消）后，回调先挂起：之后 `Origin` 和 `state` 正确的回调都得到 409（不再检查 `id_token`），页面提示到终端处理；超时计时也暂停，直到处理完（换会话、读回账号、终端确认）。

收到 token 时，CLI 在一个不碰本机凭证的会话里换出会话，在终端显示服务端返回的账号（名字、user_id、邮箱），交互运行时（标准输入和输出都是终端）询问是否以它登录（`y` 确认、`n` 拒绝，其他输入再问一次；提问前敲的输入会被丢弃）：

- 确认：保存凭证，再撤销被替换的旧 CLI 会话，关闭监听。保存失败时撤销新会话，旧的登录不变。撤销是尽力而为，失败时终端提示（见 security.md 5.1）。
- 拒绝：撤销刚建立的会话，回调用同一个 `state` 继续等待，直到超时。这样即使有人抢先用自己的 token 回调，CLI 既不会登录到他的账号，端口也不会空出来。
- 非交互运行：不询问，直接以服务端返回的账号登录并显示它，同时提醒「没有人确认这个账号」：没在网页上点过授权就不要再点（登录已结束、端口已空出），账号不是你的就 `yomi logout`。
- `account/login` 返回业务错误（服务端不接受 token）：没有建立会话，继续等待。`account/login` 成功但读回账号失败：撤销刚建立的会话，继续等待。账号在注销冷静期：同样继续等待。终端会显示服务端给的原因（前三次逐条），超时报错时附上最后一次拒绝的原因。网络或传输错误则结束登录。

收到取消时：非交互运行时提醒「不是你点的取消，就不要再在网页上授权」后结束；交互运行时问是否结束登录，回答 `n` 则继续等待（伪造的取消不能让端口空出来）。

结果页无脚本（`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、CSP `default-src 'none'`）。默认 300 秒超时（`--timeout`），收到有效回答后到处理完的这段时间暂停计时，继续等待时计算剩下的时间。凭证保存之前，Ctrl+C 在任何一步（包括确认提问处）取消登录：已经建立的会话撤销后才退出，正在进行的 `account/login` 等它返回再撤销；再按一次立即退出。凭证保存之后按 Ctrl+C 只会提示，不会撤回登录。
