# yomi relay --channel qq

**仅限个人使用**：relay 只转发你本人和你自己的 QQ bot 之间的私聊消息。

> **还不能用**：QQ 通道正在开发中，现在运行 `yomi relay --channel qq` 只会提示「还在开发中」。`--forget`、`--service-status`、`--uninstall-service` 已经可用。

完成后这里会写明：

- 在 QQ 开放平台（q.qq.com）创建自己的机器人，拿到 AppID 和 AppSecret，用 `yomi relay --channel qq --set-app` 保存（AppSecret 不显示；或 `--token-stdin`，第一行 AppID、第二行 AppSecret）；
- 先加 bot 为 QQ 好友，再在私聊里发送终端显示的 `/pair 配对码`；
- 能力与限制（回复怎样显示、被动回复与主动消息的条数和时限、relay 离线时发的消息会丢失、内容规则）；
- AppSecret 可能泄露时怎样重置。

通用的运行方式、命令、钱和隐私见 [docs/relay.md](relay.md)。
