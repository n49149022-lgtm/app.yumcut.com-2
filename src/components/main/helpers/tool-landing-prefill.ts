import { LIMITS } from '@/shared/constants/limits';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_CODES,
  type TargetLanguageCode,
  normalizeLanguageList,
} from '@/shared/constants/languages';
import type { LanguageVoiceMap } from '@/shared/types';
import { normalizeLanguageVoiceMap } from '@/shared/voices/language-voice-map';

const TOOL_PREFILL_STORAGE_KEY = 'yc_tool_prefill_v1';
const TOOL_PREFILL_QUERY_KEYS = ['yc_t', 'yc_p', 'yc_l', 'yc_v', 'yc_d'] as const;
const LANGUAGE_CODE_SET = new Set<TargetLanguageCode>(LANGUAGE_CODES);

export const TOOL_PREFILL_MAX_TEXT_CHARS = LIMITS.promptMax;

export type ToolLandingPrefill = {
  sourceToolSlug?: string;
  text?: string;
  languages?: TargetLanguageCode[];
  languageVoices?: LanguageVoiceMap;
  durationSeconds?: number | null;
};

function parseToolLanguages(raw: string | null): TargetLanguageCode[] {
  if (!raw) return [];

  const values = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is TargetLanguageCode => LANGUAGE_CODE_SET.has(value as TargetLanguageCode));

  return Array.from(new Set(values));
}

function parseToolVoiceMap(raw: string | null): LanguageVoiceMap {
  if (!raw) return {};

  const entries = raw.split('|');
  const parsed: LanguageVoiceMap = {};

  for (const entry of entries) {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex <= 0) continue;

    const language = entry.slice(0, separatorIndex).trim().toLowerCase();
    const voiceId = entry.slice(separatorIndex + 1).trim();
    if (!LANGUAGE_CODE_SET.has(language as TargetLanguageCode)) continue;
    if (!voiceId) continue;

    parsed[language as TargetLanguageCode] = voiceId;
  }

  return normalizeLanguageVoiceMap(parsed);
}

function normalizeToolPrefill(input: Partial<ToolLandingPrefill> | null | undefined): ToolLandingPrefill | null {
  const normalizedText =
    typeof input?.text === 'string'
      ? input.text.trim().slice(0, TOOL_PREFILL_MAX_TEXT_CHARS)
      : '';
  const rawLanguages = Array.isArray(input?.languages) ? input.languages : [];
  const normalizedLanguages =
    rawLanguages.length > 0 ? normalizeLanguageList(rawLanguages, DEFAULT_LANGUAGE) : [];
  const normalizedVoiceMap = normalizeLanguageVoiceMap(input?.languageVoices ?? null);
  const normalizedDuration =
    typeof input?.durationSeconds === 'number' && Number.isFinite(input.durationSeconds)
      ? Math.max(1, Math.round(input.durationSeconds))
      : null;
  const normalizedSourceToolSlug =
    typeof input?.sourceToolSlug === 'string' ? input.sourceToolSlug.trim() : '';

  if (
    !normalizedText &&
    normalizedLanguages.length === 0 &&
    Object.keys(normalizedVoiceMap).length === 0 &&
    !normalizedDuration &&
    !normalizedSourceToolSlug
  ) {
    return null;
  }

  return {
    sourceToolSlug: normalizedSourceToolSlug || undefined,
    text: normalizedText || undefined,
    languages: normalizedLanguages.length > 0 ? normalizedLanguages : undefined,
    languageVoices: Object.keys(normalizedVoiceMap).length > 0 ? normalizedVoiceMap : undefined,
    durationSeconds: normalizedDuration,
  };
}

export function readToolPrefillFromQuery(): ToolLandingPrefill | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  const durationRaw = params.get('yc_d');
  const durationValue = durationRaw ? Number.parseInt(durationRaw, 10) : Number.NaN;

  return normalizeToolPrefill({
    sourceToolSlug: params.get('yc_t')?.trim() ?? '',
    text: params.get('yc_p')?.trim() ?? '',
    languages: parseToolLanguages(params.get('yc_l')),
    languageVoices: parseToolVoiceMap(params.get('yc_v')),
    durationSeconds: Number.isFinite(durationValue) ? Math.max(1, durationValue) : null,
  });
}

export function removeToolPrefillQueryParams() {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  let changed = false;

  for (const key of TOOL_PREFILL_QUERY_KEYS) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    changed = true;
  }

  if (!changed) return;
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, '', next);
}

export function readStoredToolPrefill(): ToolLandingPrefill | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(TOOL_PREFILL_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as ToolLandingPrefill;
    return normalizeToolPrefill(parsed);
  } catch {
    return null;
  }
}

export function storeToolPrefill(payload: ToolLandingPrefill) {
  if (typeof window === 'undefined') return;

  const normalizedPayload = normalizeToolPrefill(payload);
  if (!normalizedPayload) return;

  try {
    window.localStorage.setItem(TOOL_PREFILL_STORAGE_KEY, JSON.stringify(normalizedPayload));
  } catch {}
}

export function clearStoredToolPrefill() {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(TOOL_PREFILL_STORAGE_KEY);
  } catch {}
}
