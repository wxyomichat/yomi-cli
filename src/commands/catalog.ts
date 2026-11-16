import { existsSync, writeFileSync } from 'node:fs';

import { tr } from '../core/i18n.js';
import { paint, say } from '../core/ui.js';
import { loadAllTags, loadTagPage, loadVoiceCatalog } from '../ugc/catalog.js';
import { checkSpec } from '../ugc/character.js';
import type { CharacterSpec } from '../ugc/spec.js';
import { type Context, requireSignIn } from './context.js';

export async function voices(context: Context, options: { json: boolean }) {
  requireSignIn(context);
  const catalog = await loadVoiceCatalog(context.gateway);
  if (options.json) {
    say(context.io, JSON.stringify(catalog, null, 2));
    return;
  }
  const { io } = context;
  say(
    io,
    paint(
      io,
      'dim',
      tr(
        `声音目录 ${catalog.version}，共 ${catalog.voices.length} 个。在角色文件里写 voice: <ID>：`,
        `Voice catalog ${catalog.version}, ${catalog.voices.length} voices. In the character file, write voice: <ID>:`,
      ),
    ),
  );
  for (const voice of catalog.voices)
    say(
      io,
      `${paint(io, 'bold', voice.id)}  ${voice.name}${voice.gender ? tr(`（${voice.gender}）`, ` (${voice.gender})`) : ''}${voice.description ? paint(io, 'dim', '  ' + voice.description) : ''}`,
    );
}

export async function tags(context: Context, options: { json: boolean; query: string }) {
  requireSignIn(context);
  const result = options.query
    ? await loadTagPage(context.gateway, '', options.query)
    : await loadAllTags(context.gateway);
  if (options.json) {
    say(context.io, JSON.stringify(result, null, 2));
    return;
  }
  const { io } = context;
  say(
    io,
    paint(
      io,
      'dim',
      tr(
        `最多选 ${result.maxSelect} 个，角色文件里写名称或 ID：`,
        `Pick at most ${result.maxSelect}; in the character file, write the name or ID:`,
      ),
    ),
  );
  for (const tag of result.tags) say(io, `${tag.name}  ${paint(io, 'dim', tag.id)}`);
}

const TEMPLATE_ZH = `# Yomi 角色文件（yomi create -f / yomi preview -f）。字段规则与 App 相同，见 README。
name: 林夏                     # 必填，最多 50 字
gender: female                 # 必填：male / female / non-binary
description: |                 # 必填，最多 10000 字（description_format: html 时为 HTML 源码）
  一名在海边小镇开书店的店主，温柔、敏锐，喜欢在雨天推荐冷门小说。
opening: |                     # 必填，最多 10000 字。引号里的对白会配音，引号外是旁白
  雨点敲着玻璃。她抬起头，把一本旧书推到你面前。"这本，你一定会喜欢。"
background: |                  # 选填，最多 10000 字
  她十年前从城市回到小镇，接手了外婆的书店。
background_public: false       # 背景是否对其他用户可见
author_note: ''                # 选填，作者寄语，最多 20000 字
visibility: private            # public / private
tags: []                       # 最多 10 个，写名称或 ID（yomi tags 查看）
voice: REPLACE_WITH_VOICE_ID   # 必填（yomi voices 查看）；也可混合：
# voice:
#   voices:
#     - { id: VOICE_A, weight: 70 }
#     - { id: VOICE_B, weight: 30 }
#   pitch: 1.0                 # 0.5–1.5
#   speed: 1.0                 # 0.5–1.5
cover: ./cover.png             # 必填，形象图 1:2（App 为 720×1440），JPEG/PNG/WebP ≤ 20 MB
avatar: ./avatar.png           # 必填，头像 1:1（App 为 512×512）
`;

const TEMPLATE_EN = `# Yomi character file (yomi create -f / yomi preview -f). The field rules are the app's; see the README.
name: Nova                     # required, up to 50 characters
gender: female                 # required: male / female / non-binary
description: |                 # required, up to 10000 characters (HTML source with description_format: html)
  Runs a tiny bookshop in a seaside town. Gentle and perceptive, she loves recommending little-known novels on rainy days.
opening: |                     # required, up to 10000 characters. Dialogue in quotes is voiced; the rest is narration
  Rain taps on the glass. She looks up and slides an old book toward you. "You'll like this one."
background: |                  # optional, up to 10000 characters
  Ten years ago she left the city for the town and took over her grandmother's bookshop.
background_public: false       # whether other users can see the background
author_note: ''                # optional author note, up to 20000 characters
visibility: private            # public / private
tags: []                       # up to 10, by name or ID (see yomi tags)
voice: REPLACE_WITH_VOICE_ID   # required (see yomi voices); voices can also be mixed:
# voice:
#   voices:
#     - { id: VOICE_A, weight: 70 }
#     - { id: VOICE_B, weight: 30 }
#   pitch: 1.0                 # 0.5–1.5
#   speed: 1.0                 # 0.5–1.5
cover: ./cover.png             # required, cover image 1:2 (720×1440 in the app), JPEG/PNG/WebP ≤ 20 MB
avatar: ./avatar.png           # required, avatar 1:1 (512×512 in the app)
`;

/** The character file `yomi init` writes, in the CLI's language. */
export function template(): string {
  return tr(TEMPLATE_ZH, TEMPLATE_EN);
}

export function init(context: Context, path: string, force: boolean) {
  if (existsSync(path) && !force)
    throw new Error(
      tr(`${path} 已存在；加 --force 覆盖`, `${path} already exists; add --force to overwrite it`),
    );
  writeFileSync(path, template());
  say(
    context.io,
    tr(
      `已写入 ${path}。填好后先运行 yomi check -f ${path}`,
      `Wrote ${path}. Once it's filled in, run yomi check -f ${path} first`,
    ),
  );
}

/** `yomi check`: the file against the app's rules, offline. */
export function check(context: Context, spec: CharacterSpec) {
  checkSpec(spec);
  say(
    context.io,
    paint(
      context.io,
      'green',
      tr(
        `✓ ${spec.name}：本地检查通过（声音、标签与图片审核在 create / preview 时再向服务端确认）`,
        `✓ ${spec.name}: local checks passed (voices, tags and image review are confirmed with the server at create / preview)`,
      ),
    ),
  );
}
