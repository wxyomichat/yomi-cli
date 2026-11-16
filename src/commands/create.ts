import { describeEnvironment } from '../core/env.js';
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
  say(io, `创建角色「${spec.name}」（${describeEnvironment(context.env)}）`);
  if (!options.dryRun) {
    if (!(await confirmDeclaration(context, options.acceptDeclaration))) {
      process.exitCode = 1;
      say(io, '没有确认声明，未提交。');
      return;
    }
    if (!(await confirmProduction(context, '创建一个真实角色', options.confirmProd))) {
      process.exitCode = 1;
      say(io, '已取消。');
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
  say(io, `名字：${spec.name}`);
  say(
    io,
    `性别：${GENDER_LABEL[spec.gender]}　可见性：${spec.visibility === 'private' ? '私密' : '公开'}`,
  );
  say(io, `声音：${character.voiceNames.join(' + ')}`);
  if (character.tagNames.length) say(io, `标签：${character.tagNames.join('、')}`);
  say(io, '图片：形象图与头像均已审核通过');
  const videos = describeVideoFeatures(character.video);
  if (videos) say(io, videos);
  if (options.dryRun) {
    await submitCharacter(context.gateway, state, character, {
      fresh: options.fresh,
      dryRun: (body) => {
        say(io);
        say(
          io,
          paint(io, 'dim', '--dry-run：不会创建角色。将要发送的 npc/create_ugc_character 请求体：'),
        );
        say(io, JSON.stringify(JSON.parse(body), null, 2));
      },
    });
    return;
  }
  say(io, '提交中…');
  try {
    const outcome = await submitCharacter(context.gateway, state, character, {
      fresh: options.fresh,
    });
    if (!outcome) return;
    if (outcome.recovered)
      warn(io, '上次提交的结果未知，这次重发的是当时冻结的请求（不是当前文件内容）。');
    say(io, paint(io, 'green', `✓ 已创建角色 ${outcome.npcId}`));
    say(
      io,
      `版本 ${outcome.version}，状态：${ReviewState[outcome.reviewState] ?? outcome.reviewState}`,
    );
    if (outcome.reviewState === 1)
      say(io, paint(io, 'dim', '审核通过后才会公开；审核中只有你自己能看到。'));
    say(io, `在网页上打开：${context.env.webOrigin}/chat/${outcome.npcId}`);
  } catch (error) {
    if (error instanceof AlreadyCreated) {
      say(
        io,
        `这个文件的当前内容已经创建过角色 ${error.npcId}：${context.env.webOrigin}/chat/${error.npcId}`,
      );
      say(io, paint(io, 'dim', '要再建一个新角色，加 --new。'));
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
