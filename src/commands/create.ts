import { describeEnvironment } from '../core/env.js';
import { tr } from '../core/i18n.js';
import { paint, say, warn } from '../core/ui.js';
import { describeVideoFeatures } from '../gen/ugcVideo.js';
import { UgcFailure } from '../ugc/api.js';
import { checkSpec, resolveCharacter } from '../ugc/character.js';
import { AlreadyCreated, failureMessage, ReviewState, submitCharacter } from '../ugc/create.js';
import { type CharacterSpec, GENDER_LABEL } from '../ugc/spec.js';
import { type Context, localState, requireSignIn } from './context.js';
import { confirmDeclaration, confirmProduction } from './declaration.js';

export type CreateOptions = {
  acceptDeclaration: boolean;
  confirmProd: boolean;
  dryRun: boolean;
  fresh: boolean;
};

/**
 * `yomi create`: one character, as the app's Create button does. The file is checked first
 * (nothing sent), then the declaration (and production) confirmed, then the catalogs checked,
 * the pictures uploaded and reviewed, and the character submitted.
 */
export async function create(context: Context, spec: CharacterSpec, options: CreateOptions) {
  const { io } = context;
  requireSignIn(context);
  checkSpec(spec);
  say(
    io,
    tr(
      `创建角色「${spec.name}」（${describeEnvironment(context.env)}）`,
      `Creating the character "${spec.name}" (${describeEnvironment(context.env)})`,
    ),
  );
  if (!options.dryRun) {
    if (!(await confirmDeclaration(context, options.acceptDeclaration))) {
      process.exitCode = 1;
      say(
        io,
        tr('没有确认声明，未提交。', 'The declaration was not confirmed; nothing was submitted.'),
      );
      return;
    }
    if (
      !(await confirmProduction(
        context,
        tr('创建一个真实角色', 'create a real character'),
        options.confirmProd,
      ))
    ) {
      process.exitCode = 1;
      say(io, tr('已取消。', 'Cancelled.'));
      return;
    }
  }
  const state = localState(context);
  const character = await resolveCharacter(
    context.gateway,
    state,
    spec,
    (line) => say(io, paint(io, 'dim', line)),
    context.fetch,
  );
  say(io);
  say(io, tr(`名字：${spec.name}`, `Name: ${spec.name}`));
  say(
    io,
    tr(
      `性别：${GENDER_LABEL[spec.gender]}　可见性：${spec.visibility === 'private' ? '私密' : '公开'}`,
      `Gender: ${GENDER_LABEL[spec.gender]}  Visibility: ${spec.visibility === 'private' ? 'private' : 'public'}`,
    ),
  );
  say(
    io,
    tr(`声音：${character.voiceNames.join(' + ')}`, `Voice: ${character.voiceNames.join(' + ')}`),
  );
  if (character.tagNames.length)
    say(io, tr(`标签：${character.tagNames.join('、')}`, `Tags: ${character.tagNames.join(', ')}`));
  say(
    io,
    tr(
      '图片：形象图与头像均已审核通过',
      'Images: the cover image and the avatar both passed review',
    ),
  );
  const videos = describeVideoFeatures(character.video);
  if (videos) say(io, videos);
  if (options.dryRun) {
    await submitCharacter(context.gateway, state, character, {
      fresh: options.fresh,
      dryRun: (body) => {
        say(io);
        say(
          io,
          paint(
            io,
            'dim',
            tr(
              '--dry-run：不会创建角色。将要发送的 npc/create_ugc_character 请求体：',
              '--dry-run: no character will be created. The npc/create_ugc_character request body it would send:',
            ),
          ),
        );
        say(io, JSON.stringify(JSON.parse(body), null, 2));
      },
    });
    return;
  }
  say(io, tr('提交中…', 'Submitting…'));
  try {
    const outcome = await submitCharacter(context.gateway, state, character, {
      fresh: options.fresh,
    });
    if (!outcome) return;
    if (outcome.recovered)
      warn(
        io,
        tr(
          '上次提交的结果未知，这次重发的是当时冻结的请求（不是当前文件内容）。',
          "The last submission's outcome was unknown, so this resent the request exactly as it was then (not the file's current content).",
        ),
      );
    say(
      io,
      paint(
        io,
        'green',
        tr(`✓ 已创建角色 ${outcome.npcId}`, `✓ Created character ${outcome.npcId}`),
      ),
    );
    say(
      io,
      tr(
        `版本 ${outcome.version}，状态：${ReviewState[outcome.reviewState] ?? outcome.reviewState}`,
        `Version ${outcome.version}, status: ${ReviewState[outcome.reviewState] ?? outcome.reviewState}`,
      ),
    );
    if (outcome.reviewState === 1)
      say(
        io,
        paint(
          io,
          'dim',
          tr(
            '审核通过后才会公开；审核中只有你自己能看到。',
            'It goes public once it passes review; while it is in review, only you can see it.',
          ),
        ),
      );
    say(
      io,
      tr(
        `在网页上打开：${context.env.webOrigin}/chat/${outcome.npcId}`,
        `Open it on the web: ${context.env.webOrigin}/chat/${outcome.npcId}`,
      ),
    );
  } catch (error) {
    if (error instanceof AlreadyCreated) {
      say(
        io,
        tr(
          `这个文件的当前内容已经创建过角色 ${error.npcId}：${context.env.webOrigin}/chat/${error.npcId}`,
          `A character (${error.npcId}) was already created from this file's current content: ${context.env.webOrigin}/chat/${error.npcId}`,
        ),
      );
      say(
        io,
        paint(
          io,
          'dim',
          tr('要再建一个新角色，加 --new。', 'To create another new character, add --new.'),
        ),
      );
      return;
    }
    if (error instanceof UgcFailure) {
      process.exitCode = 1;
      warn(io, failureMessage(error.code, false));
      if (error.message && error.message !== error.code) say(io, paint(io, 'dim', error.message));
      return;
    }
    throw error;
  }
}
