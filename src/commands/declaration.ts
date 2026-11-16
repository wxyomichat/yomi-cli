import { isProduction } from '../core/env.js';
import { language, tr } from '../core/i18n.js';
import { confirm, paint, say, warn } from '../core/ui.js';
import type { Context } from './context.js';

/**
 * The app's declaration (`ugc_create_rights_confirmation`), confirmed by the person each time,
 * never stored in the character file. Without a terminal the explicit flag stands in for it.
 */
export const DECLARATION_EN = 'My characters are 18+, and I have the rights to these materials.';
export const DECLARATION_ZH = '我的角色均已年满 18 岁，且我拥有这些素材的使用权。';
export const DECLARATION_ES =
  'Mis personajes son mayores de 18 años y tengo los derechos de estos materiales.';
export const DECLARATION_PT =
  'Meus personagens são maiores de 18 anos e tenho os direitos sobre estes materiais.';

export async function confirmDeclaration(context: Context, flag: boolean): Promise<boolean> {
  const { io } = context;
  say(io);
  say(io, paint(io, 'bold', tr('声明 / Declaration', 'Declaration', 'Declaración', 'Declaração')));
  const current = language();
  if (current === 'zh') say(io, `  ${DECLARATION_ZH}`);
  if (current === 'es') say(io, `  ${DECLARATION_ES}`);
  else if (current === 'pt') say(io, `  ${DECLARATION_PT}`);
  else say(io, `  ${DECLARATION_EN}`);
  if (flag) {
    say(
      io,
      paint(
        io,
        'dim',
        tr(
          '  已通过 --accept-declaration 确认。',
          '  Confirmed with --accept-declaration.',
          '  Confirmado con --accept-declaration.',
          '  Confirmado com --accept-declaration.',
        ),
      ),
    );
    return true;
  }
  if (!io.interactive) {
    warn(
      io,
      tr(
        '需要确认上述声明：在终端里运行，或加 --accept-declaration 明确确认。',
        'The declaration above needs confirming: run this in a terminal, or add --accept-declaration to confirm explicitly.',
        'Hay que confirmar la declaración anterior: ejecuta esto en una terminal o agrega --accept-declaration para confirmarla explícitamente.',
        'É preciso confirmar a declaração acima: execute isto em um terminal ou adicione --accept-declaration para confirmá-la explicitamente.',
      ),
    );
    return false;
  }
  return confirm(
    io,
    tr(
      '确认以上声明？输入 yes 确认：',
      'Confirm the declaration above? Type yes to confirm: ',
      '¿Confirmas la declaración anterior? Escribe yes para confirmar: ',
      'Confirma a declaração acima? Digite yes para confirmar: ',
    ),
    'yes',
  );
}

/** Writes in production need a second, explicit yes. */
export async function confirmProduction(
  context: Context,
  action: string,
  flag: boolean,
): Promise<boolean> {
  if (!isProduction(context.env)) return true;
  const { io } = context;
  warn(
    io,
    tr(
      `注意：这会在生产环境（www.yomichat.io）${action}。`,
      `Note: this will ${action} in production (www.yomichat.io).`,
      `Nota: esto va a ${action} en producción (www.yomichat.io).`,
      `Atenção: isto vai ${action} em produção (www.yomichat.io).`,
    ),
  );
  if (flag) return true;
  if (!io.interactive) {
    warn(
      io,
      tr(
        '非交互运行时请加 --confirm-prod 明确确认。',
        'When running non-interactively, add --confirm-prod to confirm explicitly.',
        'Al ejecutar sin interacción, agrega --confirm-prod para confirmarlo explícitamente.',
        'Ao executar de forma não interativa, adicione --confirm-prod para confirmar explicitamente.',
      ),
    );
    return false;
  }
  return confirm(
    io,
    tr(
      '确认在生产环境继续？输入 prod 确认：',
      'Continue in production? Type prod to confirm: ',
      '¿Continuar en producción? Escribe prod para confirmar: ',
      'Continuar em produção? Digite prod para confirmar: ',
    ),
    'prod',
  );
}
