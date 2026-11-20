/**
 * The names QQ's console shows (q.qq.com), as it shows them, in every language: outside Chinese a
 * translation follows them, so a reader can still find the button or menu the text names. One
 * table for the guide (qq-guide.ts), `--set-app` (qq.ts) and the gateway's stops (qq-gateway.ts);
 * it imports nothing, so each of them can use it.
 */
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
  /** How the scan page names whoever asks (yomi here), unless Tencent agreed another name. */
  thirdParty: '「第三方机器人」',
} as const;
