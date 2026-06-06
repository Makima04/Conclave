import { DEFAULT_SESSION_CONFIG } from '../api/types';
import type { RenderMode, SessionConfig, UserPersona, UserSettingMergeStrategy } from '../api/types';

export const GLOBAL_SESSION_DEFAULTS_KEY = 'global_session_defaults_v1';
export const USER_PERSONA_PRESETS_KEY = 'user_persona_presets_v1';
export const DEFAULT_USER_PERSONA_PRESET_ID_KEY = 'default_user_persona_preset_id_v1';

export type GlobalSessionDefaults = SessionConfig;

export const EMPTY_USER_PERSONA: UserPersona = {
  name: '',
  avatar: '',
  address: '',
  background: '',
  style: '',
};

export interface UserPersonaPreset {
  id: string;
  title: string;
  persona: UserPersona;
}

export function normalizeRenderMode(value: unknown): RenderMode {
  return value === 'schema' || value === 'sandbox' || value === 'text' ? value : 'auto';
}

export function normalizeUserSettingMergeStrategy(value: unknown): UserSettingMergeStrategy {
  return value === 'worldbook_overrides_user' ? value : 'user_overrides_worldbook';
}

export function normalizeUserPersona(value: unknown): UserPersona {
  const source = value && typeof value === 'object' ? value as Partial<UserPersona> : {};
  return {
    name: String(source.name || ''),
    avatar: String(source.avatar || ''),
    address: String(source.address || ''),
    background: String(source.background || ''),
    style: String(source.style || ''),
  };
}

export function normalizeUserPersonaPreset(value: unknown): UserPersonaPreset {
  const source = value && typeof value === 'object' ? value as Partial<UserPersonaPreset> : {};
  const persona = normalizeUserPersona(source.persona);
  const title = String(source.title || persona.name || '未命名用户');
  return {
    id: String(source.id || `user-${Date.now()}`),
    title,
    persona,
  };
}

export function normalizeSessionConfig(value: unknown): SessionConfig {
  const source = value && typeof value === 'object' ? value as Partial<SessionConfig> : {};
  return {
    ...DEFAULT_SESSION_CONFIG,
    ...source,
    system_prompt: source.system_prompt || '',
    render_mode: normalizeRenderMode(source.render_mode),
    user_persona: normalizeUserPersona(source.user_persona),
    user_setting_merge_strategy: normalizeUserSettingMergeStrategy(source.user_setting_merge_strategy),
  };
}

export function loadGlobalSessionDefaults(): GlobalSessionDefaults {
  try {
    return normalizeSessionConfig(JSON.parse(localStorage.getItem(GLOBAL_SESSION_DEFAULTS_KEY) || 'null'));
  } catch {
    return normalizeSessionConfig(null);
  }
}

export function saveGlobalSessionDefaults(config: SessionConfig) {
  localStorage.setItem(GLOBAL_SESSION_DEFAULTS_KEY, JSON.stringify(normalizeSessionConfig(config)));
}

export function resetGlobalSessionDefaults(): GlobalSessionDefaults {
  const defaults = normalizeSessionConfig(null);
  saveGlobalSessionDefaults(defaults);
  return defaults;
}

export function loadUserPersonaPresets(): UserPersonaPreset[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(USER_PERSONA_PRESETS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeUserPersonaPreset);
  } catch {
    return [];
  }
}

export function saveUserPersonaPresets(presets: UserPersonaPreset[]) {
  localStorage.setItem(USER_PERSONA_PRESETS_KEY, JSON.stringify(presets.map(normalizeUserPersonaPreset)));
}

export function loadDefaultUserPersonaPresetId(): string {
  return localStorage.getItem(DEFAULT_USER_PERSONA_PRESET_ID_KEY) || '';
}

export function saveDefaultUserPersonaPresetId(id: string) {
  if (id) {
    localStorage.setItem(DEFAULT_USER_PERSONA_PRESET_ID_KEY, id);
  } else {
    localStorage.removeItem(DEFAULT_USER_PERSONA_PRESET_ID_KEY);
  }
}

export function getDefaultUserPersonaPreset(): UserPersonaPreset | null {
  const presets = loadUserPersonaPresets();
  const defaultId = loadDefaultUserPersonaPresetId();
  return presets.find(p => p.id === defaultId) || presets[0] || null;
}

export function applyUserPersonaToConfig(config: SessionConfig, persona: UserPersona): SessionConfig {
  return normalizeSessionConfig({ ...config, user_persona: normalizeUserPersona(persona) });
}
