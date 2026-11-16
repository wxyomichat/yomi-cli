import { readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { countText, LIMITS } from './text.js';

/**
 * A character as a file (YAML or JSON; examples/character.yaml), checked with the app's rules.
 * The declaration (18+ and rights) is never in the file: the command asks for it every time.
 */

export type Gender = 'male' | 'female' | 'non-binary';
export type ImageInput =
  | { kind: 'file'; path: string }
  | { kind: 'upload'; uploadId: string }
  | { kind: 'asset'; assetId: string };
export type VoiceSpec = {
  voices: { id: string; weight: number }[];
  pitch: number;
  speed: number;
};

export type CharacterSpec = {
  /** Where the file is (identifies the local draft); '' for one built from flags only. */
  source: string;
  name: string;
  gender: Gender;
  description: string;
  descriptionFormat: 'plain' | 'html';
  opening: string;
  background: string;
  backgroundPublic: boolean;
  exampleDialogue: string;
  authorNote: string;
  conversationStyle: string;
  visibility: 'public' | 'private';
  /** Tag names or IDs, resolved against `npc/list_ugc_tags` before sending. */
  tags: string[];
  voice: VoiceSpec | null;
  cover: ImageInput | null;
  avatar: ImageInput | null;
};

export class SpecError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'SpecError';
  }
}

const KEYS = new Set([
  'name',
  'gender',
  'description',
  'description_format',
  'opening',
  'opening_message',
  'background',
  'background_public',
  'example_dialogue',
  'author_note',
  'creator_note',
  'conversation_style',
  'visibility',
  'tags',
  'voice',
  'cover',
  'avatar',
]);

const GENDERS: Record<string, Gender> = {
  male: 'male',
  m: 'male',
  男: 'male',
  female: 'female',
  f: 'female',
  女: 'female',
  'non-binary': 'non-binary',
  nonbinary: 'non-binary',
  non_binary: 'non-binary',
  非二元: 'non-binary',
};

export const GENDER_WIRE: Record<Gender, number> = { male: 1, female: 2, 'non-binary': 3 };
export const GENDER_LABEL: Record<Gender, string> = {
  male: '男',
  female: '女',
  'non-binary': '非二元',
};

export function emptySpec(): CharacterSpec {
  return {
    source: '',
    name: '',
    gender: '' as Gender,
    description: '',
    descriptionFormat: 'plain',
    opening: '',
    background: '',
    backgroundPublic: false,
    exampleDialogue: '',
    authorNote: '',
    conversationStyle: 'Natural',
    visibility: 'public',
    tags: [],
    voice: null,
    cover: null,
    avatar: null,
  };
}

/** Reads a YAML / JSON character file. Image paths are taken relative to the file. */
export function loadSpecFile(path: string): CharacterSpec {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch {
    throw new SpecError([`读不到角色文件：${path}`]);
  }
  let data: unknown;
  try {
    data = extname(absolute).toLowerCase() === '.json' ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    throw new SpecError([`角色文件格式错误：${error instanceof Error ? error.message : ''}`]);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new SpecError(['角色文件的顶层必须是键值对象']);
  return specFromObject(data as Record<string, unknown>, absolute);
}

function textField(
  data: Record<string, unknown>,
  key: string,
  problems: string[],
  fallback = '',
): string {
  const value = data[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') {
    problems.push(`${key} 必须是文本`);
    return fallback;
  }
  return value;
}

function imageField(value: unknown, base: string, key: string, problems: string[]) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      problems.push(`${key} 请给本地图片路径，或 { upload_id } / { asset_id }`);
      return null;
    }
    return { kind: 'file' as const, path: isAbsolute(value) ? value : resolve(base, value) };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const ref = value as Record<string, unknown>;
    const upload = ref.upload_id === undefined ? '' : String(ref.upload_id);
    const asset = ref.asset_id === undefined ? '' : String(ref.asset_id);
    if (upload && /^[1-9][0-9]{0,18}$/.test(upload) && !asset)
      return { kind: 'upload' as const, uploadId: upload };
    if (asset && /^[1-9][0-9]{0,18}$/.test(asset) && !upload)
      return { kind: 'asset' as const, assetId: asset };
    if (typeof ref.path === 'string' && !upload && !asset)
      return imageField(ref.path, base, key, problems);
  }
  problems.push(`${key} 只能是图片路径，或只含 upload_id / asset_id 之一的对象`);
  return null;
}

function voiceField(value: unknown, problems: string[]): VoiceSpec | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string')
    return { voices: [{ id: value, weight: 100 }], pitch: 1, speed: 1 };
  if (typeof value !== 'object' || Array.isArray(value)) {
    problems.push('voice 只能是声音 ID，或 { voices, pitch, speed }');
    return null;
  }
  const raw = value as Record<string, unknown>;
  const list = Array.isArray(raw.voices) ? raw.voices : raw.id ? [raw] : null;
  if (!list) {
    problems.push('voice.voices 必须是列表');
    return null;
  }
  const voices = list.map((item) => {
    if (typeof item === 'string') return { id: item, weight: 100 };
    const entry = (item ?? {}) as Record<string, unknown>;
    return {
      id: typeof entry.id === 'string' ? entry.id : String(entry.voice_id ?? ''),
      weight: entry.weight === undefined ? 100 : Number(entry.weight),
    };
  });
  return {
    voices,
    pitch: raw.pitch === undefined ? 1 : Number(raw.pitch),
    speed: raw.speed === undefined ? 1 : Number(raw.speed),
  };
}

export function specFromObject(data: Record<string, unknown>, source = ''): CharacterSpec {
  const problems: string[] = [];
  for (const key of Object.keys(data))
    if (!KEYS.has(key)) problems.push(`不认识的字段 ${key}（拼写错误？）`);
  const base = source ? dirname(source) : process.cwd();
  const spec = emptySpec();
  spec.source = source;
  spec.name = textField(data, 'name', problems);
  const gender = textField(data, 'gender', problems).trim().toLowerCase();
  spec.gender = (GENDERS[gender] ?? gender) as Gender;
  spec.description = textField(data, 'description', problems);
  const format = textField(data, 'description_format', problems, 'plain').trim().toLowerCase();
  if (format !== 'plain' && format !== 'html')
    problems.push('description_format 只能是 plain 或 html');
  else spec.descriptionFormat = format;
  spec.opening =
    textField(data, 'opening', problems) || textField(data, 'opening_message', problems);
  spec.background = textField(data, 'background', problems);
  spec.backgroundPublic = data.background_public === true;
  if (data.background_public !== undefined && typeof data.background_public !== 'boolean')
    problems.push('background_public 只能是 true 或 false');
  spec.exampleDialogue = textField(data, 'example_dialogue', problems);
  spec.authorNote =
    textField(data, 'author_note', problems) || textField(data, 'creator_note', problems);
  spec.conversationStyle = textField(data, 'conversation_style', problems, 'Natural') || 'Natural';
  const visibility = textField(data, 'visibility', problems, 'public').trim().toLowerCase();
  spec.visibility = (
    visibility === '私密' ? 'private' : visibility === '公开' ? 'public' : visibility
  ) as 'public' | 'private';
  const tags = data.tags;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) problems.push('tags 必须是列表');
    else spec.tags = tags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  spec.voice = voiceField(data.voice, problems);
  spec.cover = imageField(data.cover, base, 'cover', problems);
  spec.avatar = imageField(data.avatar, base, 'avatar', problems);
  if (problems.length) throw new SpecError(problems);
  return spec;
}

/**
 * The app's checks, then what `contentForSubmission` requires: every problem at once, in the
 * form's order.
 */
export function validateSpec(spec: CharacterSpec): string[] {
  const problems: string[] = [];
  const field = (label: string, value: string, limit: number, required = true) => {
    if (required && !value.trim()) problems.push(`${label}不能为空`);
    else if (countText(value) > limit)
      problems.push(`${label}最多 ${limit} 个字符（现在 ${countText(value)}）`);
  };
  if (!spec.avatar) problems.push('缺少头像 avatar（1:1 图片）');
  if (!spec.cover) problems.push('缺少形象图 cover（1:2 图片）');
  field('名字 name ', spec.name, LIMITS.name);
  if (!(spec.gender in GENDER_WIRE)) problems.push('性别 gender 只能是 male、female 或 non-binary');
  field(
    '简介 description ',
    spec.description,
    spec.descriptionFormat === 'html' ? LIMITS.descriptionHtml : LIMITS.description,
  );
  field('开场白 opening ', spec.opening, LIMITS.opening);
  field('背景 background ', spec.background, LIMITS.background, false);
  field('对话示例 example_dialogue ', spec.exampleDialogue, LIMITS.exampleDialogue, false);
  field('作者寄语 author_note ', spec.authorNote, LIMITS.authorNote, false);
  const voice = spec.voice;
  if (!voice || voice.voices.length === 0)
    problems.push('缺少声音 voice（用 yomi voices 查看可选声音）');
  else {
    const ids = voice.voices.map((item) => item.id);
    if (voice.voices.length > LIMITS.voices) problems.push(`声音最多混合 ${LIMITS.voices} 个`);
    if (new Set(ids).size !== ids.length) problems.push('声音不能重复');
    for (const item of voice.voices) {
      if (!item.id.trim() || item.id.length > 128 || item.id.includes('\u0000'))
        problems.push(`声音 ID 不合法：${item.id}`);
      if (!Number.isInteger(item.weight) || item.weight < 0 || item.weight > 100)
        problems.push(`声音权重必须是 0–100 的整数：${item.id}`);
    }
    if (!voice.voices.some((item) => item.weight > 0)) problems.push('至少一个声音的权重要大于 0');
    for (const [label, value] of [
      ['音调 pitch', voice.pitch],
      ['语速 speed', voice.speed],
    ] as const)
      if (!Number.isFinite(value) || value < 0.5 || value > 1.5)
        problems.push(`${label} 必须在 0.5–1.5 之间`);
  }
  if (spec.visibility !== 'public' && spec.visibility !== 'private')
    problems.push('可见性 visibility 只能是 public 或 private');
  if (spec.tags.length > LIMITS.tags) problems.push(`标签最多 ${LIMITS.tags} 个`);
  if (new Set(spec.tags).size !== spec.tags.length) problems.push('标签不能重复');
  return problems;
}
