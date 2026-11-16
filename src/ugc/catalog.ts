import type { Gateway } from '../core/api.js';
import { currentLanguage } from '../core/device.js';
import { type Json, idOf, object } from '../core/json.js';
import { call, UgcFailure, wireIds } from './api.js';

/** Voices and tags the form picks from. */

export type Voice = { id: string; name: string; gender: string; description: string };
export type VoiceCatalog = { version: string; voices: Voice[] };

/** The locale the voice routes speak (`Locale.current` with a hyphen). */
export const voiceLocale = () => (currentLanguage() === 'zh-Hans' ? 'zh-Hans' : 'en-US');

export async function loadVoiceCatalog(gateway: Gateway): Promise<VoiceCatalog> {
  const result = await call(gateway, 'ugc/voice/catalog', { locale: voiceLocale() });
  const version = typeof result.catalog_version === 'string' ? result.catalog_version : '';
  const items = Array.isArray(result.voices) ? result.voices : null;
  if (!version || !items || items.length > 500)
    throw new UgcFailure('PROTOCOL', '声音目录回包不完整');
  const voices: Voice[] = [];
  const seen = new Set<string>();
  for (const value of items) {
    const item = value as Json;
    const id = typeof item.voice_id === 'string' ? item.voice_id : '';
    const name = typeof item.display_name === 'string' ? item.display_name : '';
    if (!id || seen.has(id) || !name || name.length > 100)
      throw new UgcFailure('PROTOCOL', '声音目录里有不合法的条目');
    seen.add(id);
    voices.push({
      id,
      name,
      gender: typeof item.gender === 'string' ? item.gender : '',
      description: typeof item.description === 'string' ? item.description : '',
    });
  }
  return { version, voices };
}

export type Tag = { id: string; name: string };
export type TagPage = { tags: Tag[]; nextCursor: string; hasMore: boolean; maxSelect: number };

/** `npc/list_ugc_tags`, 50 a page. */
export async function loadTagPage(gateway: Gateway, cursor = '', query = ''): Promise<TagPage> {
  const body: Json = { query, limit: 50 };
  if (cursor) body.cursor = cursor;
  const result = await call(gateway, 'npc/list_ugc_tags', wireIds(body));
  const tags = (Array.isArray(result.tags) ? result.tags : []).map((value) => {
    const tag = object(value);
    return { id: idOf(tag.tag_id), name: typeof tag.name === 'string' ? tag.name : '' };
  });
  const max = typeof result.max_select === 'number' ? result.max_select : 10;
  return {
    tags: tags.filter((tag) => tag.id && tag.id !== '0' && tag.name),
    nextCursor: typeof result.next_cursor === 'string' ? result.next_cursor : '',
    hasMore: result.has_more === true,
    maxSelect: Math.min(10, Math.max(1, max)),
  };
}

/** Every tag (at most 20 pages, as a cursor seen twice stops). */
export async function loadAllTags(gateway: Gateway): Promise<{ tags: Tag[]; maxSelect: number }> {
  const tags: Tag[] = [];
  const seen = new Set<string>();
  let cursor = '';
  let maxSelect = 10;
  for (let page = 0; page < 20; page++) {
    const result = await loadTagPage(gateway, cursor);
    maxSelect = result.maxSelect;
    tags.push(...result.tags);
    if (!result.hasMore || !result.nextCursor || seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return { tags, maxSelect };
}

/** Tag names or IDs from a file → catalog IDs; every unknown one is reported at once. */
export function resolveTags(
  wanted: string[],
  catalog: Tag[],
): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const item of wanted) {
    const lowered = item.toLowerCase();
    const tag =
      catalog.find((entry) => entry.id === item) ??
      catalog.find((entry) => entry.name.toLowerCase() === lowered);
    if (tag) ids.push(tag.id);
    else unknown.push(item);
  }
  return { ids, unknown };
}
