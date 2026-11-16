import type { Gateway } from '../core/api.js';
import type { Json } from '../core/json.js';
import type { LocalState } from '../core/state.js';
import { videoFeatures } from '../gen/ugcVideo.js';
import { call, UgcFailure, wireIds } from './api.js';
import { loadAllTags, loadVoiceCatalog, resolveTags } from './catalog.js';
import { type ImageKind, loadImage } from './imageFile.js';
import {
  type CharacterSpec,
  GENDER_WIRE,
  type ImageInput,
  SpecError,
  validateSpec,
} from './spec.js';
import { prepareImage, Review } from './upload.js';

/**
 * A checked character file turned into `CharacterContent`, as the app builds it: tags
 * resolved against the catalog, voices checked against `ugc/voice/catalog`, both pictures
 * uploaded and PASSED.
 */

export type ImageRef = { upload_id: string } | { asset_id: string };

export type ResolvedCharacter = {
  spec: CharacterSpec;
  tagIds: string[];
  tagNames: string[];
  voiceNames: string[];
  cover: ImageRef;
  avatar: ImageRef;
  coverUrl: string;
  avatarUrl: string;
  /**
   * The AI videos made for this character file (`yomi video`): `dynamic_cover` / `intro_video`
   * and `draft_id` for `features`, null (nothing sent) while none has finished.
   */
  video?: Json | null;
};

export type Progress = (line: string) => void;

const disabledHtml = () => ({
  format_version: 1,
  enabled: false,
  description_source: '',
  opening_source: '',
});

/** Everything that can be checked without the network. */
export function checkSpec(spec: CharacterSpec) {
  const problems = validateSpec(spec);
  if (problems.length) throw new SpecError(problems);
}

async function resolveImage(
  gateway: Gateway,
  state: LocalState,
  input: ImageInput,
  kind: ImageKind,
  progress: Progress,
  fetcher?: typeof fetch,
): Promise<{ ref: ImageRef; url: string }> {
  const label = kind === 'cover' ? '形象图' : '头像';
  if (input.kind === 'asset') return { ref: { asset_id: input.assetId }, url: '' };
  if (input.kind === 'upload') {
    const result = await call(
      gateway,
      'npc/review_ugc_image',
      wireIds({ upload_id: input.uploadId }),
    );
    const upload = (result.upload ?? {}) as Json;
    if (Number(upload.review_status) !== Review.passed || upload.purpose !== kind)
      throw new UgcFailure(
        'IMAGE_REJECTED',
        `${label} upload_id ${input.uploadId} 不是审核通过的 ${kind} 图片`,
      );
    return { ref: { upload_id: input.uploadId }, url: String(upload.image_url ?? '') };
  }
  const image = loadImage(input.path, kind);
  const known = state.upload(image.sha256, kind);
  progress(
    known?.status === Review.passed
      ? `${label}（${image.width}×${image.height}）已审核通过，沿用`
      : `上传并审核${label}（${image.width}×${image.height}）…`,
  );
  const receipt = await prepareImage(gateway, state, image, kind, label, fetcher);
  return { ref: { upload_id: receipt.uploadId }, url: receipt.url };
}

export async function resolveCharacter(
  gateway: Gateway,
  state: LocalState,
  spec: CharacterSpec,
  progress: Progress,
  fetcher?: typeof fetch,
): Promise<ResolvedCharacter> {
  checkSpec(spec);
  const voice = spec.voice!;
  progress('读取声音目录…');
  const catalog = await loadVoiceCatalog(gateway);
  const missing = voice.voices.filter(
    (item) => !catalog.voices.some((entry) => entry.id === item.id),
  );
  if (missing.length)
    throw new SpecError(
      missing.map((item) => `声音 ${item.id} 不在当前目录里（yomi voices 查看可选声音）`),
    );
  const voiceNames = voice.voices.map(
    (item) => catalog.voices.find((entry) => entry.id === item.id)?.name ?? item.id,
  );
  let tagIds: string[] = [];
  let tagNames: string[] = [];
  if (spec.tags.length) {
    progress('读取标签目录…');
    const tags = await loadAllTags(gateway);
    const resolved = resolveTags(spec.tags, tags.tags);
    if (resolved.unknown.length)
      throw new SpecError(
        resolved.unknown.map((tag) => `标签「${tag}」不在当前目录里（yomi tags 查看）`),
      );
    if (resolved.ids.length > tags.maxSelect)
      throw new SpecError([`标签最多选 ${tags.maxSelect} 个`]);
    tagIds = resolved.ids;
    tagNames = tagIds.map((id) => tags.tags.find((tag) => tag.id === id)?.name ?? id);
  }
  const cover = await resolveImage(gateway, state, spec.cover!, 'cover', progress, fetcher);
  const avatar = await resolveImage(gateway, state, spec.avatar!, 'avatar', progress, fetcher);
  return {
    spec,
    tagIds,
    tagNames,
    voiceNames,
    cover: cover.ref,
    avatar: avatar.ref,
    coverUrl: cover.url,
    avatarUrl: avatar.url,
    video: videoFeatures(state, spec.source),
  };
}

function voiceContent(spec: CharacterSpec): Json {
  const voice = spec.voice!;
  return {
    format_version: 1,
    voices: voice.voices.map((item) => ({ voice_id: item.id, weight: item.weight })),
    pitch: voice.pitch,
    speed: voice.speed,
  };
}

function baseContent(character: ResolvedCharacter): Json {
  const spec = character.spec;
  return {
    name: spec.name,
    gender: GENDER_WIRE[spec.gender],
    description: spec.description,
    opening_message: spec.opening,
    background: spec.background,
    background_public: spec.backgroundPublic,
    tag_ids: character.tagIds,
    visibility: spec.visibility === 'private' ? 2 : 1,
    cover: character.cover,
    avatar: character.avatar,
    conversation_style: spec.conversationStyle,
    example_dialogue: spec.exampleDialogue,
    author_note: spec.authorNote,
  };
}

/** `features`: HTML styling off, the voice, and the finished AI videos with their draft. */
function featureContent(character: ResolvedCharacter): Json {
  return {
    format_version: 1,
    html_styling: disabledHtml(),
    voice_configuration: voiceContent(character.spec),
    ...(character.video ?? {}),
  };
}

/** `CharacterContent` for `npc/create_ugc_character` (`contentForSubmission`). */
export function contentForSubmission(
  character: ResolvedCharacter,
  declarationAccepted: boolean,
): Json {
  if (!declarationAccepted) throw new UgcFailure('DECLARATION', '需要先确认 18+ 与版权声明');
  return {
    ...baseContent(character),
    features: featureContent(character),
    declaration_accepted: true,
    content_format: character.spec.descriptionFormat,
  };
}

/** The preview character's content (`contentForPreview`): the form as it is, voice included. */
export function contentForPreview(
  character: ResolvedCharacter,
  declarationAccepted: boolean,
): Json {
  // As the web and the app: a preview sends the voice only. Video bindings belong to the created
  // character (create records the draft → character link); binding them to a preview character
  // could make the later create fail.
  return {
    features: {
      format_version: 1,
      html_styling: disabledHtml(),
      voice_configuration: voiceContent(character.spec),
    },
    ...baseContent(character),
    declaration_accepted: declarationAccepted,
    content_format: character.spec.descriptionFormat,
  };
}
