/**
 * Strips credentials from anything the CLI may print or log: the `token` query of the long
 * connection, `X-Token` and `Authorization` headers, and secret fields in JSON or form bodies
 * (Yomi's tokens, the sign-in's one-time code and PKCE verifier; QQ's AppSecret and access token; WeChat iLink's bot token, context token,
 * typing ticket, image keys and upload parameters, and the login QR, whose holder can collect
 * the bot token). Debug output goes through this; secrets are never printed on purpose.
 */
const FIELDS = [
  'token',
  'auth_token',
  'refresh_token',
  'firebase_token',
  'id_token',
  'authToken',
  'refreshToken',
  'idToken',
  'code_verifier',
  'codeVerifier',
  'x-token',
  'X-Token',
  'state',
  'secret',
  'access_token',
  'clientSecret',
  'client_secret',
  'bot_token',
  'botToken',
  'context_token',
  'typing_ticket',
  'aeskey',
  'aes_key',
  'encrypt_query_param',
  'upload_param',
  'qrcode',
  'qrcode_img_content',
  'verify_code',
  'Authorization',
  // A Headers object writes its names in lower case (in JSON, too).
  'authorization',
];

/**
 * Masked as a JSON string or a query / form value only: `code` is the sign-in's one-time code
 * there, while a line that starts with `code:` or a numeric `"code": 40001` (a status) is not.
 */
const VALUE_FIELDS = ['code'];

/** A Telegram bot token (`<bot id>:<secret>`), alone or in a Bot API URL path (`/bot<token>/`). */
const BOT_TOKEN = /\b(bot)?([0-9]{5,16}):[A-Za-z0-9_-]{30,}/g;

export function redact(text: string): string {
  let result = text.replace(
    BOT_TOKEN,
    (_match, prefix: string | undefined, id: string) => `${prefix ?? ''}${id}:***`,
  );
  for (const field of [...FIELDS, ...VALUE_FIELDS]) {
    const name = field.replace(/[-]/g, '\\-');
    result = result
      // JSON: "field":"value"
      .replace(new RegExp(`("${name}"\\s*:\\s*")[^"]*(")`, 'g'), '$1***$2')
      // query or form: field=value
      .replace(new RegExp(`(^|[?&\\s])(${name}=)[^&\\s"]*`, 'gm'), '$1$2***');
    if (VALUE_FIELDS.includes(field)) continue;
    // header: field: value, to the end of the line (`Authorization: Bearer <token>` is two words)
    result = result.replace(new RegExp(`(^|\\n)(${name}:\\s*)[^\\r\\n]+`, 'gi'), '$1$2***');
  }
  return result;
}
