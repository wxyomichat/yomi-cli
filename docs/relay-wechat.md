# yomi relay --channel wechat --experimental

**仅限个人使用**：relay 只转发你本人和你自己的微信 ClawBot 之间的消息。**实验功能**：微信 ClawBot（iLink）不是给第三方客户端的官方接口，对这类客户端的使用条款还不明确；不加 `--experimental` 不会启动。

> **还不能用**：微信通道正在开发中，现在运行 `yomi relay --channel wechat --experimental` 只会提示「还在开发中」。`--forget`、`--service-status`、`--uninstall-service` 已经可用（不需要 `--experimental`）。

完成后这里会写明：

- 用 `yomi relay --channel wechat --experimental --login` 在终端里扫码登录（扫码的人就是主人；不要在共享屏幕上显示二维码，`--qr-link` 才会打印链接）；
- 需要的实名与微信支付条件、PIN 绑定；
- 能力与限制（没有流式显示和按钮、回复窗口、不在窗口内的提醒怎样送达）；
- 怎样在手机微信里解除绑定。

通用的运行方式、命令、钱和隐私见 [docs/relay.md](relay.md)。
