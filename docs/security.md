# 安全说明

`yomi` 处理三类敏感信息：网页交来的一次性 Firebase ID token、CLI 自己的会话（`auth_token` / `refresh_token`），以及会花钱的操作（付费预演消息）。下面逐项说明 CLI 怎样处理它们，以及还没解决的风险。协议细节见 [auth-protocol.md](auth-protocol.md)。

## 1. 只接受本机回环回调

- 回调服务只绑定 `127.0.0.1`，端口随机（系统分配），不监听 `0.0.0.0`。
- 对端地址必须是回环地址；`Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，防 DNS rebinding（恶意网页把自己的域名解析到 127.0.0.1 后访问回调）。
- `Origin` 必须等于所选环境的网页 origin。其他网站的页面即使知道端口，也无法让浏览器带着 Yomi 的 `Origin` 提交；`Origin: null`（沙箱 iframe、data URL）同样拒绝。授权页提交前把 referrer 策略设为 `origin`，否则 https → http 的提交会被浏览器改成 `Origin: null`。被拒绝的回调会在终端里提示原因（不含凭证），等待继续。
- 网页端只按校验过的 `port` 拼 `http://127.0.0.1:<port>/callback`，主机和路径写死，不能被参数改成别的地址，不会变成开放重定向。

## 2. state 一次性

- `state` 为 32 字节密码学随机数，每次 `yomi login` 重新生成，只存在内存里。
- 回调用常数时间比较；第一次有效回调后立即结束监听，重放得到 410。
- 错误的 `state` 不会终止等待（避免被人用错误请求打断登录），但累计 5 次后停止，防止暴力猜测。
- 终端与网页同时显示由 `state` 派生的确认码，用户核对一致才点授权，防止钓鱼页面诱导用户授权别人发起的登录。

## 3. 凭证不进 URL，也不进日志

- Firebase ID token 只出现在表单 POST 正文里；带查询串的回调请求一律拒绝。
- 授权页链接只带 `port` 和 `state`（`state` 不是凭证，只防 CSRF），而且放在 URL 片段 `#…` 里：片段不发给服务器，不进访问日志和 Referer；网页读出后立即从地址栏删掉，RUM 上报也会去掉它。
- CLI 拿到 token 后只调用一次 `account/login`，不保存、不打印；之后只用 CLI 自己的会话。
- `--debug` 的请求日志只打印方法、路径、状态码和耗时，不打印请求体；所有调试输出经过 `redact()`，去掉 `token`、`auth_token`、`refresh_token`、`firebase_token`、`id_token`、`X-Token`、`state`。
- 长连接按服务端协议要求把 `refresh_token` 放在 `wss://…/connection/ws?token=…` 里（与 App、网页一致）。这个地址只在内存里交给 WebSocket，从不打印；走 TLS，也不经过浏览器历史。这是服务端协议本身的限制，见「已知风险」。

## 4. 凭证保存

- 默认存系统钥匙串：macOS 用 `security`（服务名 `yomi-cli`，账户为环境名 `test` / `prod`），Linux 用 Secret Service（`secret-tool`）。写入时密钥经标准输入传给 `security -i`（十六进制 `-X`）或 `secret-tool store`，不出现在命令行参数里，`ps` 看不到。
- 没有钥匙串时退到 `~/.config/yomi-cli/credentials.json`：目录 0700、文件 0600，先写临时文件再原子改名。会给出提示。`YOMI_CREDENTIAL_STORE=file` 可强制使用文件（测试、无桌面环境）。
- 本地状态文件（`state/*.json`，请求回执、草稿编号、上传记录）不含任何凭证。
- `yomi logout` 先调用 `account/logout` 撤销服务端会话，再删除本机凭证；服务端失败时仍删除本机副本并提示。重新 `login` 会撤销被替换的旧 CLI 会话。

## 5. CLI 会话与 App、网页隔离

- CLI 用 Firebase token 换出**自己的**会话（独立 `device_id`），不复用网页的 `refresh_token`，所以 CLI 刷新令牌不会让网页掉线，撤销 CLI 会话也不影响网页和 App。
- 登录时带 `not_logout_other_device: true`，避免把用户从其他设备踢下线。
- 刷新令牌失败（过期、被撤销）时 CLI 删除本机凭证，要求重新登录；多个 CLI 进程同时运行时，若钥匙串里已有别的进程刷新过的新令牌，直接采用，不重复刷新。

## 6. 超时与取消

- 授权默认 300 秒有效（`--timeout` 可改，最长 3600），超时后回调服务关闭，`state` 作废。
- Ctrl+C 立即关闭回调服务。
- 网页上点「取消」会通知 CLI 结束，不会建立会话。

## 7. 花钱与生产环境

- 默认连生产环境，这也是唯一内置的环境；测试环境要显式 `--env test` 并自己配置地址，用 `YOMI_API_ORIGIN` / `YOMI_WEB_ORIGIN` 指向的 mock 或本地构建不算生产。生产环境的 `create` / `preview` / `relay` 需要再输入 `prod` 确认（非交互时需 `--confirm-prod`）。
- 预演开始先显示服务端返回的剩余免费条数。用完后，CLI 先查询并显示钻石余额，用户输入 `yes` 才会以 `consumption_mode=1`（付费）发送；非交互运行必须加 `--allow-paid`，否则停止。CLI 从不在未确认的情况下发付费消息。
- 18+ 与版权声明每次 `create` / `preview` 都要确认（输入 `yes`，或非交互时显式 `--accept-declaration`），不写在角色文件里。

## 已知风险与后续

1. **Firebase ID token 经过浏览器**：它在 1 小时内可以换出会话。缓解：只发给本机回环、一次性、表单 POST、不进 URL。根本解决需要服务端提供一次性授权码。
2. **本机其他进程**：同一用户下的恶意进程理论上可以抢先监听或读取钥匙串，这超出 CLI 能防御的范围（`gh`、`gcloud` 同样如此）。
3. **长连接 URL 中的 refresh_token**：服务端协议所致；若服务端支持握手后鉴权或短期连接票据，CLI 可以跟进。
4. **Safari**：从 https 页面向 `http://127.0.0.1` 提交表单，个别 Safari 版本可能提示「此表单不安全」。用户确认后仍可提交；也可以用 `--no-browser` 把地址复制到 Chrome。
