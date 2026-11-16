import { isProduction } from '../core/env.js';
import { confirm, paint, say, warn } from '../core/ui.js';
import type { Context } from './context.js';

/**
 * The app's declaration (`ugc_create_rights_confirmation`), confirmed by the person each time,
 * never stored in the character file. Without a terminal the explicit flag stands in for it.
 */
export const DECLARATION_EN = 'My characters are 18+, and I have the rights to these materials.';
export const DECLARATION_ZH = '我的角色均已年满 18 岁，且我拥有这些素材的使用权。';

export async function confirmDeclaration(context: Context, flag: boolean): Promise<boolean> {
  const { io } = context;
  say(io);
  say(io, paint(io, 'bold', '声明 / Declaration'));
  say(io, `  ${DECLARATION_ZH}`);
  say(io, `  ${DECLARATION_EN}`);
  if (flag) {
    say(io, paint(io, 'dim', '  已通过 --accept-declaration 确认。'));
    return true;
  }
  if (!io.interactive) {
    warn(io, '需要确认上述声明：在终端里运行，或加 --accept-declaration 明确确认。');
    return false;
  }
  return confirm(io, '确认以上声明？输入 yes 确认：', 'yes');
}

/** Writes in production need a second, explicit yes. */
export async function confirmProduction(
  context: Context,
  action: string,
  flag: boolean,
): Promise<boolean> {
  if (!isProduction(context.env)) return true;
  const { io } = context;
  warn(io, `注意：这会在生产环境（www.yomichat.io）${action}。`);
  if (flag) return true;
  if (!io.interactive) {
    warn(io, '非交互运行时请加 --confirm-prod 明确确认。');
    return false;
  }
  return confirm(io, '确认在生产环境继续？输入 prod 确认：', 'prod');
}
