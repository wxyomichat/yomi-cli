/**
 * Strips credentials from anything the CLI may print or log: the `token` query of the long
 * connection, `X-Token`, and token fields in JSON or form bodies. Debug output goes through this;
 * tokens are never printed on purpose.
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
  'x-token',
  'X-Token',
  'state',
];

/** A Telegram bot token (`<bot id>:<secret>`), alone or in a Bot API URL path (`/bot<token>/`). */
const BOT_TOKEN = /\b(bot)?([0-9]{5,16}):[A-Za-z0-9_-]{30,}/g;

export function redact(text: string): string {
  let result = text.replace(
    BOT_TOKEN,
    (_match, prefix: string | undefined, id: string) => `${prefix ?? ''}${id}:***`,
  );
  for (const field of FIELDS) {
    const name = field.replace(/[-]/g, '\\-');
    result = result
      // JSON: "field":"value"
      .replace(new RegExp(`("${name}"\\s*:\\s*")[^"]*(")`, 'g'), '$1***$2')
      // query or form: field=value
      .replace(new RegExp(`(^|[?&\\s])(${name}=)[^&\\s"]*`, 'gm'), '$1$2***')
      // header: field: value
      .replace(new RegExp(`(^|\\n)(${name}:\\s*)\\S+`, 'gi'), '$1$2***');
  }
  return result;
}
