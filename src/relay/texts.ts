/**
 * What the relay says in Telegram, in the CLI's language (`YOMI_LANG` / `LANG`: zh-Hans or en).
 * Plain text: the caller escapes it for HTML. No links to buy gems (Telegram allows only Stars for
 * digital goods in bots), only "top up in the app or on the web".
 */

const zh = {
  aiNotice: (name: string) =>
    `你正在与 AI 角色「${name}」聊天：回复由 AI 生成，不是真人。陪伴类聊天机器人可能不适合部分未成年人。`,
  paired: (bot: string) =>
    `已配对：这个 bot 现在只为你转发消息。用 /character 选择角色，/help 查看命令。（${bot}）`,
  badCode: '配对码不对或已过期，请看电脑终端上显示的配对码。',
  help: [
    '直接发文字，就会转给当前角色。',
    '/character [ID] 查看或切换角色',
    '/price 每条回复的价格、余额和预算',
    '/budget [数量|off] 设置可花的钻石上限（默认只用免费额度）',
    '/report 举报最近一条回复或角色',
    '/stop 停止转发当前回复（不退费）',
  ].join('\n'),
  noCharacter: '还没有选择角色：发送 /character 加角色 ID。',
  characterIs: (name: string, id: string) => `当前角色：${name}（ID ${id}）`,
  characterSet: (name: string) => `已切换到「${name}」。`,
  characterBad: '没有找到这个角色，或它暂时不能聊天。',
  busy: '上一条回复还没结束，请稍等。',
  sendUnknown:
    '网络异常，这条消息可能没有送达。为避免重复扣费，不会自动重发；如果已经扣费，下一条发送前会按余额核对计入预算。',
  walletUnavailable: '暂时读不到钻石余额，为了不超出预算，这条没有发送。请稍后再试。',
  priceUnknown:
    '暂时读不到每条回复的价格（不代表免费），为了不超出预算，这条没有发送。请稍后再试。',
  replyFailed: (detail: string) => `回复没有成功${detail ? `：${detail}` : ''}。可以重新发送。`,
  replyMissing: '暂时没有收到这条回复；稍后用 Yomi App 或网页查看。',
  emptyReply: '（这条回复没有可显示的内容）',
  stopped: '已停止转发这条回复。服务端没有中止生成的接口，本轮仍会照常扣费。',
  nothingToStop: '现在没有正在转发的回复。',
  stale: '这条消息是 relay 离线时发的，没有转发。需要的话请重新发送。',
  textOnly: '目前只支持文字消息。',
  unknownCommand: '不认识这个命令，/help 查看可用命令。',
  // Billing
  freeOnlyUnsupported:
    '服务端还没有确认支持「只用免费额度」，任何一条消息都可能扣钻石，所以没设预算前一条也不发。请先用 /budget <数量> 设置预算（要在电脑上用 --max-spend 允许）。',
  freeExhausted: (price: string, balance: string) =>
    `免费额度已用完。${price}${balance}如需继续，用 /budget <数量> 设置可花的钻石上限。`,
  priceLine: (price: number | null) =>
    price === null
      ? '每条回复的价格暂时未知（不代表免费）。'
      : `每条回复约 ${price} 钻石（以实际扣费为准）。`,
  balanceLine: (balance: number | null) => (balance === null ? '' : `当前余额 ${balance} 钻石。`),
  budgetLine: (mode: string, budget: number, spent: number, left: number, ceiling: number) =>
    (mode === 'paid' ? `预算 ${budget} 钻石，已用 ${spent}。` : '当前不花钻石（只用免费额度）。') +
    `本机上限 ${ceiling} 钻石，还可花 ${Math.max(0, left)}。`,
  budgetAsk: (amount: number) => `确认允许 relay 最多花 ${amount} 钻石吗？用完会暂停，不会自动续。`,
  budgetConfirm: (amount: number) => `允许最多 ${amount} 钻石`,
  cancel: '取消',
  budgetSet: (amount: number) => `已设置预算 ${amount} 钻石。`,
  budgetOff: '已改回只用免费额度。',
  budgetCancelled: '没有改动预算。',
  budgetTooHigh: (left: number, ceiling: number) =>
    ceiling > 0
      ? `超过本机上限：上限 ${ceiling} 钻石，还可花 ${Math.max(0, left)}。要提高或重置，请在电脑上用 --max-spend（或 --reset-spend）重新启动 relay。`
      : '本机没有允许花钻石：请在电脑上用 --max-spend <数量> 重新启动 relay。',
  budgetUsage: '用法：/budget 100 设置预算，/budget off 改回只用免费额度。',
  budgetExhausted: (spent: number) =>
    `预算已用完（已花 ${spent} 钻石），relay 已暂停。用 /budget 设置新的预算继续。`,
  budgetShort: (price: number, left: number) =>
    `剩余预算 ${left} 钻石，不够下一条回复（约 ${price} 钻石）。用 /budget 提高预算。`,
  freeCharged: (spent: number) =>
    `只用免费额度时，这条回复仍被扣了 ${spent} 钻石，relay 已暂停。请用 /budget 设置预算后再继续。`,
  insufficientGems: '钻石不足，请在 Yomi App 或网页充值后再发。',
  membership: '这项功能需要会员，请在 Yomi App 或网页查看。',
  rateLimited: (seconds: number) =>
    `发送太快了${seconds ? `，请 ${seconds} 秒后再试` : '，请稍后再试'}。`,
  ageGate: '这个账号暂时不能和该角色在这里聊天（年龄验证或内容分级限制）。',
  unavailable: '这个角色暂时不可用，请换一个角色。',
  disabled: (detail: string) => `relay 已被服务端关闭${detail ? `：${detail}` : ''}。`,
  tooOld: '这个版本的 yomi 太旧了，relay 已暂停。请在电脑上升级 yomi 后重新启动。',
  refused: (detail: string) => `发送失败${detail ? `：${detail}` : ''}。`,
  // Session
  signedOut: 'Yomi 登录已失效，relay 已暂停。请在电脑上运行 yomi login，完成后会自动恢复。',
  resumed: 'Yomi 登录已恢复，可以继续聊天。',
  otherAccount: '电脑上登录的 Yomi 账号变了，relay 已停止。请重新运行 yomi relay --telegram。',
  paused: (reason: string) => `relay 已暂停：${reason}`,
  // Report
  reportPick: '选择举报原因（只收集，不代表已处理）：',
  reportCharacter: '举报这个角色',
  reportNothing: '没有可以举报的回复：回复这条消息或在回复出现后再试。',
  reportDone: '已提交，谢谢反馈。',
  reportFailed: '提交失败，请稍后再试。',
  expired: '这个按钮已过期。',
};

export type RelayTexts = typeof zh;

const en: RelayTexts = {
  aiNotice: (name) =>
    `You are chatting with the AI character "${name}": replies are AI-generated, not a person. Companion chatbots may not be suitable for some minors.`,
  paired: (bot) =>
    `Paired: this bot now relays your messages only. Pick a character with /character; /help lists commands. (${bot})`,
  badCode: 'That pairing code is wrong or expired. Use the code shown in your terminal.',
  help: [
    'Send text and it goes to the current character.',
    '/character [ID] show or switch the character',
    '/price price per reply, balance and budget',
    '/budget [amount|off] gems the relay may spend (default: free replies only)',
    '/report report the last reply or the character',
    '/stop stop relaying the current reply (no refund)',
  ].join('\n'),
  noCharacter: 'No character yet: send /character with a character ID.',
  characterIs: (name, id) => `Current character: ${name} (ID ${id})`,
  characterSet: (name) => `Switched to "${name}".`,
  characterBad: 'That character was not found or cannot chat right now.',
  busy: 'The last reply is still coming. Please wait.',
  sendUnknown:
    "Network trouble: this message may not have arrived. It won't be resent automatically, to avoid paying twice. If it was charged, the balance is checked and counted against the budget before the next message.",
  walletUnavailable:
    "Can't read your gem balance right now, so this message was not sent (to stay within the budget). Try again shortly.",
  priceUnknown:
    "Can't read the price per reply right now (that does not mean free), so this message was not sent. Try again shortly.",
  replyFailed: (detail) =>
    `The reply didn't come through${detail ? `: ${detail}` : ''}. You can send again.`,
  replyMissing: "This reply hasn't arrived yet; check it later in the Yomi app or on the web.",
  emptyReply: '(This reply has nothing to show.)',
  stopped:
    'Stopped relaying this reply. The server cannot stop generating, so this turn is still charged.',
  nothingToStop: 'No reply is being relayed right now.',
  stale:
    'This message was sent while the relay was offline, so it was not relayed. Send it again if you like.',
  textOnly: 'Only text messages are supported for now.',
  unknownCommand: 'Unknown command. /help lists the commands.',
  freeOnlyUnsupported:
    "The server hasn't confirmed free-replies-only yet, so any message may cost gems, and nothing is sent before you set a budget with /budget <amount> (allowed on the computer with --max-spend).",
  freeExhausted: (price, balance) =>
    `Your free replies are used up. ${price}${balance}To continue, set a gem budget with /budget <amount>.`,
  priceLine: (price) =>
    price === null
      ? 'The price per reply is unknown right now (that does not mean free). '
      : `About ${price} gems per reply (the actual charge may differ). `,
  balanceLine: (balance) => (balance === null ? '' : `Balance: ${balance} gems. `),
  budgetLine: (mode, budget, spent, left, ceiling) =>
    (mode === 'paid'
      ? `Budget ${budget} gems, ${spent} spent. `
      : 'Not spending gems (free replies only). ') +
    `Local limit ${ceiling} gems, ${Math.max(0, left)} left.`,
  budgetAsk: (amount) =>
    `Allow the relay to spend up to ${amount} gems? It pauses when they are spent and never tops up.`,
  budgetConfirm: (amount) => `Allow up to ${amount} gems`,
  cancel: 'Cancel',
  budgetSet: (amount) => `Budget set to ${amount} gems.`,
  budgetOff: 'Back to free replies only.',
  budgetCancelled: 'Budget unchanged.',
  budgetTooHigh: (left, ceiling) =>
    ceiling > 0
      ? `Above the local limit: ${ceiling} gems, ${Math.max(0, left)} left. Restart the relay with --max-spend (or --reset-spend) to raise or reset it.`
      : 'Spending gems is not allowed on this computer: restart the relay with --max-spend <amount>.',
  budgetUsage: 'Usage: /budget 100 to set a budget, /budget off for free replies only.',
  budgetExhausted: (spent) =>
    `The budget is spent (${spent} gems); the relay is paused. Set a new one with /budget.`,
  budgetShort: (price, left) =>
    `${left} gems left, not enough for the next reply (about ${price}). Raise the budget with /budget.`,
  freeCharged: (spent) =>
    `This reply was charged ${spent} gems although only free replies were allowed; the relay is paused. Set a budget with /budget to continue.`,
  insufficientGems: 'Not enough gems. Top up in the Yomi app or on the web, then send again.',
  membership: 'This needs a membership; see the Yomi app or the web.',
  rateLimited: (seconds) =>
    `Too fast${seconds ? `; try again in ${seconds} seconds` : '; try again shortly'}.`,
  ageGate: "This account can't chat with that character here (age verification or content rating).",
  unavailable: 'That character is unavailable right now; pick another one.',
  disabled: (detail) => `The server has switched relays off${detail ? `: ${detail}` : ''}.`,
  tooOld:
    'This version of yomi is too old; the relay is paused. Upgrade yomi on your computer and restart it.',
  refused: (detail) => `Couldn't send${detail ? `: ${detail}` : ''}.`,
  signedOut:
    'Your Yomi sign-in expired; the relay is paused. Run yomi login on your computer and it resumes by itself.',
  resumed: 'Yomi sign-in is back; you can continue.',
  otherAccount:
    'A different Yomi account is signed in on the computer; the relay stopped. Run yomi relay --telegram again.',
  paused: (reason) => `The relay is paused: ${reason}`,
  reportPick: 'Pick a reason (collected for review; not a promise of action):',
  reportCharacter: 'Report this character',
  reportNothing: 'Nothing to report yet: reply to a message, or try after a reply arrives.',
  reportDone: 'Sent. Thanks for the feedback.',
  reportFailed: "Couldn't send it; try again later.",
  expired: 'This button has expired.',
};

export function relayTexts(language: string): RelayTexts {
  return /^zh/i.test(language) ? zh : en;
}

export const COMMANDS = {
  zh: [
    { command: 'character', description: '查看或切换角色' },
    { command: 'price', description: '价格、余额和预算' },
    { command: 'budget', description: '设置可花的钻石上限' },
    { command: 'report', description: '举报回复或角色' },
    { command: 'stop', description: '停止转发当前回复（不退费）' },
    { command: 'help', description: '帮助' },
  ],
  en: [
    { command: 'character', description: 'Show or switch the character' },
    { command: 'price', description: 'Price, balance and budget' },
    { command: 'budget', description: 'Gems the relay may spend' },
    { command: 'report', description: 'Report a reply or the character' },
    { command: 'stop', description: 'Stop relaying the reply (no refund)' },
    { command: 'help', description: 'Help' },
  ],
};
