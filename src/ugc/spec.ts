import { readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { tr } from '../core/i18n.js';
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
  get male() {
    return tr('男', 'male', 'masculino', 'masculino');
  },
  get female() {
    return tr('女', 'female', 'femenino', 'feminino');
  },
  get 'non-binary'() {
    return tr('非二元', 'non-binary', 'no binario', 'não binário');
  },
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
    throw new SpecError([
      tr(
        `读不到角色文件：${path}`,
        `Cannot read the character file: ${path}`,
        `No se puede leer el archivo del personaje: ${path}`,
        `Não é possível ler o arquivo do personagem: ${path}`,
      ),
    ]);
  }
  let data: unknown;
  try {
    data = extname(absolute).toLowerCase() === '.json' ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new SpecError([
      tr(
        `角色文件格式错误：${detail}`,
        `The character file could not be parsed: ${detail}`,
        `No se pudo analizar el archivo del personaje: ${detail}`,
        `Não foi possível analisar o arquivo do personagem: ${detail}`,
      ),
    ]);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new SpecError([
      tr(
        '角色文件的顶层必须是键值对象',
        'The top level of the character file must be a key-value map',
        'El nivel superior del archivo del personaje debe ser un mapa de clave-valor',
        'O nível superior do arquivo do personagem deve ser um mapa de chave-valor',
      ),
    ]);
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
    problems.push(
      tr(
        `${key} 必须是文本`,
        `${key} must be text`,
        `${key} debe ser texto`,
        `${key} deve ser texto`,
      ),
    );
    return fallback;
  }
  return value;
}

function imageField(value: unknown, base: string, key: string, problems: string[]) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      problems.push(
        tr(
          `${key} 请给本地图片路径，或 { upload_id } / { asset_id }`,
          `${key}: use a local image path, or { upload_id } / { asset_id }`,
          `${key}: usa una ruta de imagen local, o { upload_id } / { asset_id }`,
          `${key}: use um caminho de imagem local, ou { upload_id } / { asset_id }`,
        ),
      );
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
  problems.push(
    tr(
      `${key} 只能是图片路径，或只含 upload_id / asset_id 之一的对象`,
      `${key} must be an image path, or an object with only one of upload_id / asset_id`,
      `${key} debe ser una ruta de imagen, o un objeto con solo uno de upload_id / asset_id`,
      `${key} deve ser um caminho de imagem, ou um objeto com apenas um de upload_id / asset_id`,
    ),
  );
  return null;
}

function voiceField(value: unknown, problems: string[]): VoiceSpec | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string')
    return { voices: [{ id: value, weight: 100 }], pitch: 1, speed: 1 };
  if (typeof value !== 'object' || Array.isArray(value)) {
    problems.push(
      tr(
        'voice 只能是声音 ID，或 { voices, pitch, speed }',
        'voice must be a voice ID, or { voices, pitch, speed }',
        'voice debe ser un ID de voz, o { voices, pitch, speed }',
        'voice deve ser um ID de voz, ou { voices, pitch, speed }',
      ),
    );
    return null;
  }
  const raw = value as Record<string, unknown>;
  const list = Array.isArray(raw.voices) ? raw.voices : raw.id ? [raw] : null;
  if (!list) {
    problems.push(
      tr(
        'voice.voices 必须是列表',
        'voice.voices must be a list',
        'voice.voices debe ser una lista',
        'voice.voices deve ser uma lista',
      ),
    );
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
    if (!KEYS.has(key))
      problems.push(
        tr(
          `不认识的字段 ${key}（拼写错误？）`,
          `Unknown field ${key} (a typo?)`,
          `Campo desconocido ${key} (¿un error de escritura?)`,
          `Campo desconhecido ${key} (erro de digitação?)`,
        ),
      );
  const base = source ? dirname(source) : process.cwd();
  const spec = emptySpec();
  spec.source = source;
  spec.name = textField(data, 'name', problems);
  const gender = textField(data, 'gender', problems).trim().toLowerCase();
  spec.gender = (GENDERS[gender] ?? gender) as Gender;
  spec.description = textField(data, 'description', problems);
  const format = textField(data, 'description_format', problems, 'plain').trim().toLowerCase();
  if (format !== 'plain' && format !== 'html')
    problems.push(
      tr(
        'description_format 只能是 plain 或 html',
        'description_format must be plain or html',
        'description_format debe ser plain o html',
        'description_format deve ser plain ou html',
      ),
    );
  else spec.descriptionFormat = format;
  spec.opening =
    textField(data, 'opening', problems) || textField(data, 'opening_message', problems);
  spec.background = textField(data, 'background', problems);
  spec.backgroundPublic = data.background_public === true;
  if (data.background_public !== undefined && typeof data.background_public !== 'boolean')
    problems.push(
      tr(
        'background_public 只能是 true 或 false',
        'background_public must be true or false',
        'background_public debe ser true o false',
        'background_public deve ser true ou false',
      ),
    );
  spec.exampleDialogue = textField(data, 'example_dialogue', problems);
  spec.authorNote =
    textField(data, 'author_note', problems) || textField(data, 'creator_note', problems);
  spec.conversationStyle = textField(data, 'conversation_style', problems, 'Natural') || 'Natural';
  const visibility = textField(data, 'visibility', problems, 'public').trim().toLowerCase();
  spec.visibility = (
    visibility === '私密' // i18n-ignore
      ? 'private'
      : visibility === '公开' // i18n-ignore
        ? 'public'
        : visibility
  ) as 'public' | 'private';
  const tags = data.tags;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags))
      problems.push(
        tr(
          'tags 必须是列表',
          'tags must be a list',
          'tags debe ser una lista',
          'tags deve ser uma lista',
        ),
      );
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
    if (required && !value.trim())
      problems.push(
        tr(
          `${label}不能为空`,
          `${label} can't be empty`,
          `${label} no puede quedar en blanco`,
          `${label} não pode ficar em branco`,
        ),
      );
    else if (countText(value) > limit)
      problems.push(
        tr(
          `${label}最多 ${limit} 个字符（现在 ${countText(value)}）`,
          `${label} can be at most ${limit} characters (now ${countText(value)})`,
          `${label} puede tener como máximo ${limit} caracteres (ahora ${countText(value)})`,
          `${label} pode ter no máximo ${limit} caracteres (agora ${countText(value)})`,
        ),
      );
  };
  if (!spec.avatar)
    problems.push(
      tr(
        '缺少头像 avatar（1:1 图片）',
        'Missing avatar (a 1:1 image)',
        'Falta el avatar (una imagen 1:1)',
        'Falta o avatar (uma imagem 1:1)',
      ),
    );
  if (!spec.cover)
    problems.push(
      tr(
        '缺少形象图 cover（1:2 图片）',
        'Missing cover (a 1:2 cover image)',
        'Falta la portada (una imagen de portada 1:2)',
        'Falta a capa (uma imagem de capa 1:2)',
      ),
    );
  field(tr('名字 name ', 'Name', 'Nombre', 'Nome'), spec.name, LIMITS.name);
  if (!(spec.gender in GENDER_WIRE))
    problems.push(
      tr(
        '性别 gender 只能是 male、female 或 non-binary',
        'Gender must be male, female or non-binary',
        'El género debe ser male, female o non-binary',
        'O gênero deve ser male, female ou non-binary',
      ),
    );
  field(
    tr('简介 description ', 'Description', 'Descripción', 'Descrição'),
    spec.description,
    spec.descriptionFormat === 'html' ? LIMITS.descriptionHtml : LIMITS.description,
  );
  field(
    tr(
      '开场白 opening ',
      'Opening message (opening)',
      'Mensaje de apertura (opening)',
      'Mensagem de abertura (opening)',
    ),
    spec.opening,
    LIMITS.opening,
  );
  field(
    tr('背景 background ', 'Background', 'Trasfondo', 'Contexto'),
    spec.background,
    LIMITS.background,
    false,
  );
  field(
    tr(
      '对话示例 example_dialogue ',
      'Example dialogue (example_dialogue)',
      'Diálogo de ejemplo (example_dialogue)',
      'Diálogo de exemplo (example_dialogue)',
    ),
    spec.exampleDialogue,
    LIMITS.exampleDialogue,
    false,
  );
  field(
    tr(
      '作者寄语 author_note ',
      'Author note (author_note)',
      'Nota del autor (author_note)',
      'Nota do autor (author_note)',
    ),
    spec.authorNote,
    LIMITS.authorNote,
    false,
  );
  const voice = spec.voice;
  if (!voice || voice.voices.length === 0)
    problems.push(
      tr(
        '缺少声音 voice（用 yomi voices 查看可选声音）',
        'Missing voice (run yomi voices to see the voices you can use)',
        'Falta la voz (ejecuta yomi voices para ver las voces que puedes usar)',
        'Falta a voz (execute yomi voices para ver as vozes que você pode usar)',
      ),
    );
  else {
    const ids = voice.voices.map((item) => item.id);
    if (voice.voices.length > LIMITS.voices)
      problems.push(
        tr(
          `声音最多混合 ${LIMITS.voices} 个`,
          `At most ${LIMITS.voices} voices can be mixed`,
          `Se pueden mezclar como máximo ${LIMITS.voices} voces`,
          `É possível misturar no máximo ${LIMITS.voices} vozes`,
        ),
      );
    if (new Set(ids).size !== ids.length)
      problems.push(
        tr(
          '声音不能重复',
          'Each voice can appear only once',
          'Cada voz puede aparecer solo una vez',
          'Cada voz pode aparecer apenas uma vez',
        ),
      );
    for (const item of voice.voices) {
      if (!item.id.trim() || item.id.length > 128 || item.id.includes('\u0000'))
        problems.push(
          tr(
            `声音 ID 不合法：${item.id}`,
            `Invalid voice ID: ${item.id}`,
            `ID de voz no válido: ${item.id}`,
            `ID de voz inválido: ${item.id}`,
          ),
        );
      if (!Number.isInteger(item.weight) || item.weight < 0 || item.weight > 100)
        problems.push(
          tr(
            `声音权重必须是 0–100 的整数：${item.id}`,
            `A voice weight must be a whole number from 0 to 100: ${item.id}`,
            `El peso de una voz debe ser un número entero de 0 a 100: ${item.id}`,
            `O peso de uma voz deve ser um número inteiro de 0 a 100: ${item.id}`,
          ),
        );
    }
    if (!voice.voices.some((item) => item.weight > 0))
      problems.push(
        tr(
          '至少一个声音的权重要大于 0',
          'At least one voice needs a weight above 0',
          'Al menos una voz necesita un peso mayor que 0',
          'Pelo menos uma voz precisa de um peso maior que 0',
        ),
      );
    for (const [label, value] of [
      [tr('音调 pitch', 'Pitch', 'Tono', 'Tom'), voice.pitch],
      [tr('语速 speed', 'Speed', 'Velocidad', 'Velocidade'), voice.speed],
    ] as const)
      if (!Number.isFinite(value) || value < 0.5 || value > 1.5)
        problems.push(
          tr(
            `${label} 必须在 0.5–1.5 之间`,
            `${label} must be between 0.5 and 1.5`,
            `${label} debe estar entre 0.5 y 1.5`,
            `${label} deve estar entre 0.5 e 1.5`,
          ),
        );
  }
  if (spec.visibility !== 'public' && spec.visibility !== 'private')
    problems.push(
      tr(
        '可见性 visibility 只能是 public 或 private',
        'Visibility must be public or private',
        'La visibilidad debe ser public o private',
        'A visibilidade deve ser public ou private',
      ),
    );
  if (spec.tags.length > LIMITS.tags)
    problems.push(
      tr(
        `标签最多 ${LIMITS.tags} 个`,
        `At most ${LIMITS.tags} tags`,
        `Como máximo ${LIMITS.tags} etiquetas`,
        `No máximo ${LIMITS.tags} tags`,
      ),
    );
  if (new Set(spec.tags).size !== spec.tags.length)
    problems.push(
      tr(
        '标签不能重复',
        'Each tag can appear only once',
        'Cada etiqueta puede aparecer solo una vez',
        'Cada tag pode aparecer apenas uma vez',
      ),
    );
  return problems;
}
