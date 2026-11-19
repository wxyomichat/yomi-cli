// The suites were written against the Chinese output: they run in Chinese whatever the machine's
// locale. Tests of the English output set the language themselves (setLanguage or YOMI_LANG).
process.env.YOMI_LANG = 'zh-Hans';

// Whatever the developer's shell sets, no test reaches a real chat platform: the tests that need a
// mock origin set one themselves.
for (const name of ['YOMI_TELEGRAM_API_ORIGIN', 'YOMI_QQ_API_ORIGIN', 'YOMI_WECHAT_API_ORIGIN'])
  delete process.env[name];
