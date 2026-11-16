# CLI 网页授权协议（v1）

`yomi login` 与 Yomi 网页端授权页 `/cli/auth` 之间的约定。安全考虑见 [security.md](security.md)。

## 为什么传 Firebase ID token

现有服务端认可的凭证：

| 凭证                                    | 有效期                                  | 用途                                      | 交给 CLI 的问题                                                |
| --------------------------------------- | --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| 网页会话 `auth_token` / `refresh_token` | auth 短期，refresh 长期，刷新会换新一对 | `X-Token`、长连接 `token`                 | CLI 与网页共用一条刷新链，一方刷新后另一方失效；而且是长期凭证 |
| Firebase ID token                       | 1 小时                                  | `account/login`（`login_type` 3）换出会话 | 短期、一次性使用；CLI 用它换出**自己的**会话                   |

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
校验 Host / Origin / state（一次性）         （state, id_token, email, display_name）
回一个「已授权，可以关闭此页」页面 ──────▶ 浏览器显示 CLI 的结果页
account/login → account/get_account
凭证存入系统钥匙串
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
- 表单字段：`state`（原样），`id_token`，`email`、`display_name`（可选，仅供终端显示）。取消时只发 `state` 和 `error=access_denied`。
- 凭证绝不出现在 URL 里。

### 确认码

两端用同一算法从 `state` 算出，便于用户核对终端和网页是同一次登录：

1. `digest = SHA-256(UTF-8("yomi-cli-auth:" + state))`
2. 取 `digest` 前 5 个字节，看作 40 位大端整数
3. 从高位起每 5 位一组，共 8 组，查表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
4. 前 4 位与后 4 位之间加 `-`，如 `K7QM-2XTR`

参考实现：`src/auth/loopback.ts` 的 `verificationCode`。

## CLI 回调 `POST /callback`

只监听 `127.0.0.1`，端口由系统分配。逐项校验，任一不符即拒绝：

| 检查                                                                                        | 不符时                   |
| ------------------------------------------------------------------------------------------- | ------------------------ |
| 对端是回环地址，`Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）      | 403                      |
| 路径 `/callback`                                                                            | 404                      |
| 方法 POST，且 URL 不带查询串（凭证不进 URL）                                                | 405                      |
| `Origin` 等于所选环境的网页 origin（生产为 `https://www.yomichat.io`）；`null` 或缺失都拒绝 | 400                      |
| `state` 常数时间比较一致                                                                    | 400；累计 5 次后停止等待 |
| `id_token` 是三段 base64url（JWT 形状）                                                     | 400，并结束              |
| 已处理过一次                                                                                | 410                      |

成功后返回一个无脚本的结果页（`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、CSP `default-src 'none'`），随即关闭监听。默认 300 秒超时（`--timeout`），Ctrl+C 取消。
