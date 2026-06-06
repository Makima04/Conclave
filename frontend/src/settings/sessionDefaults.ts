import { DEFAULT_SESSION_CONFIG } from '../api/types';
import type { RenderMode, SessionConfig, UserPersona } from '../api/types';

export const GLOBAL_SESSION_DEFAULTS_KEY = 'global_session_defaults_v1';

export type GlobalSessionDefaults = SessionConfig;

export const EMPTY_USER_PERSONA: UserPersona = {
  name: '',
  avatar: '',
  address: '',
  background: '',
  style: '',
};

export function normalizeRenderMode(value: unknown): RenderMode {
  return value === 'schema' || value === 'sandbox' || value === 'text' ? value : 'auto';
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

export function normalizeSessionConfig(value: unknown): SessionConfig {
  const source = value && typeof value === 'object' ? value as Partial<SessionConfig> : {};
  return {
    ...DEFAULT_SESSION_CONFIG,
    ...source,
    system_prompt: source.system_prompt || '',
    render_mode: normalizeRenderMode(source.render_mode),
    user_persona: normalizeUserPersona(source.user_persona),
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
