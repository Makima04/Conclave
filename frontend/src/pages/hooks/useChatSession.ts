// useChatSession — session lifecycle, data loading, config management
// Extracted from Chat.tsx GROUP 30 + GROUP 31

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../../api/client';
import type { CharacterCard, Message, Preset, RenderMode, SessionConfig, SessionRuntimeAssets, UserPersona, UserSettingMergeStrategy, WorldBook } from '../../api/types';
import { DEFAULT_SESSION_CONFIG } from '../../api/types';
import { loadGlobalSessionDefaults, loadUserPersonaPresets, normalizeRenderMode, normalizeSessionConfig, saveGlobalSessionDefaults, type UserPersonaPreset } from '../../settings/sessionDefaults';
import { useProviders } from '../../contexts/AppContext';
import { cleanCardDisplayText } from '../card-content';

function getParsedGreetings(card: CharacterCard | null): string[] {
  if (!card) return [];
  return [card.first_mes, ...(card.alternate_greetings ?? [])];
}

const HTML_APP_TRIGGER_RE = /(?:^|\n)\s*(?:\[attachment\]|\[开局\]|【GameStart】|【游戏开始】)\s*(?:\n|$)/gi;

function cleanComparableMessageText(content: string): string {
  return cleanCardDisplayText(content)
    .replace(HTML_APP_TRIGGER_RE, '\n')
    .replace(/\s+/g, '')
    .trim();
}

export function useChatSession() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { providers } = useProviders();

  // --- state ---
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionTitle, setSessionTitle] = useState('');
  const [config, setConfig] = useState<SessionConfig>({ ...DEFAULT_SESSION_CONFIG });
  const [configDirty, setConfigDirty] = useState(false);
  const [characterCard, setCharacterCard] = useState<CharacterCard | null>(null);
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeWorldBookId, setActiveWorldBookId] = useState('');
  const [sessionResourceSaving, setSessionResourceSaving] = useState<'worldbook' | 'preset' | null>(null);
  const [renderMode, setRenderMode] = useState<RenderMode>('auto');
  const [userPersona, setUserPersona] = useState<UserPersona>({ name: '', avatar: '', address: '', background: '', style: '' });
  const [userPresets, setUserPresets] = useState<UserPersonaPreset[]>([]);
  const [sessionMode, setSessionMode] = useState<string>('single_agent');
  const [selectedGreetingIndex, setSelectedGreetingIndex] = useState(-1);
  const [sessionState, setSessionState] = useState<any>({});
  const [runtimeAssets, setRuntimeAssets] = useState<SessionRuntimeAssets>({ regex_scripts: [], tavern_helper_scripts: [] });
  const [showVariableDebug, setShowVariableDebug] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // --- loaders ---

  async function loadSessionResources() {
    try {
      const [worldBookData, presetData] = await Promise.all([
        api.listWorldBooks(),
        api.listPresets(),
      ]);
      setWorldBooks(worldBookData.items || []);
      setPresets(presetData.items || []);
    } catch (err) {
      console.error('Failed to load session resources:', err);
    }
  }

  async function loadSession() {
    if (!sessionId) return;
    try {
      const session = await api.getSession(sessionId);
      setSessionTitle(session.title || '未命名会话');
      setSessionMode(session.mode || 'single_agent');
      setActiveWorldBookId(session.world_pack_id || '');
      setCharacterCard(null);
      setSelectedGreetingIndex(-1);
      if (session.world_pack_id) {
        loadCharacterCard(session.world_pack_id);
      }
      if (session.config) {
        const nextConfig = normalizeSessionConfig(session.config);
        setConfig(nextConfig);
        setRenderMode(nextConfig.render_mode);
        setUserPersona(nextConfig.user_persona);
        setConfigDirty(false);
      }
    } catch (err) {
      console.error('Failed to load session:', err);
    }
  }

  async function loadCharacterCard(worldBookId: string) {
    try {
      const card = await api.getWorldBookCharacterCard(worldBookId);
      setCharacterCard(card);
      setSelectedGreetingIndex(-1);
    } catch (err) {
      setCharacterCard(null);
      setSelectedGreetingIndex(-1);
      console.warn('No character card for this world book, using world book directly');
    }
  }

  async function loadMessages(): Promise<Message[] | undefined> {
    if (!sessionId) return undefined;
    try {
      const data = await api.listMessages(sessionId);
      setMessages(data.items);
      return data.items;
    } catch (err) {
      console.error('Failed to load messages:', err);
      return undefined;
    }
  }

  async function loadSessionState() {
    if (!sessionId) return;
    try {
      const value = await api.getSessionState(sessionId);
      setSessionState(value || {});
    } catch (err) {
      console.error('Failed to load session state:', err);
    }
  }

  async function loadRuntimeAssets() {
    if (!sessionId) return;
    try {
      const value = await api.getSessionRuntimeAssets(sessionId);
      setRuntimeAssets({
        regex_scripts: Array.isArray(value.regex_scripts) ? value.regex_scripts : [],
        tavern_helper_scripts: Array.isArray(value.tavern_helper_scripts) ? value.tavern_helper_scripts : [],
      });
    } catch (err) {
      setRuntimeAssets({ regex_scripts: [], tavern_helper_scripts: [] });
      console.error('Failed to load runtime assets:', err);
    }
  }

  // --- config persistence ---

  async function persistConfig(nextConfig: SessionConfig): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const updated = await api.updateSession(sessionId, { config: normalizeSessionConfig(nextConfig) });
      const savedConfig = normalizeSessionConfig(updated.config);
      setConfig(savedConfig);
      setRenderMode(savedConfig.render_mode);
      setUserPersona(savedConfig.user_persona);
      setConfigDirty(false);
      return true;
    } catch (err) {
      console.error('Failed to save config:', err);
      return false;
    }
  }

  async function saveConfig() {
    await persistConfig({
      ...config,
      render_mode: renderMode,
      user_persona: userPersona,
    });
  }

  function updateConfig<K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }));
    setConfigDirty(true);
  }

  function updateRenderMode(value: RenderMode) {
    setRenderMode(normalizeRenderMode(value));
    setConfigDirty(true);
  }

  function updateUserPersona(key: keyof UserPersona, value: string) {
    setUserPersona(prev => ({ ...prev, [key]: value }));
    setConfigDirty(true);
  }

  function updateUserSettingMergeStrategy(value: UserSettingMergeStrategy) {
    updateConfig('user_setting_merge_strategy', value);
  }

  async function updateSessionWorldBook(worldBookId: string) {
    if (!sessionId || sessionResourceSaving) return;
    const nextWorldBookId = worldBookId || '';
    const previousWorldBookId = activeWorldBookId;
    setActiveWorldBookId(nextWorldBookId);
    setSessionResourceSaving('worldbook');
    setStreamError(null);
    try {
      const updated = await api.updateSession(sessionId, {
        config: normalizeSessionConfig({
          ...config,
          render_mode: renderMode,
          user_persona: userPersona,
        }),
        world_pack_id: nextWorldBookId || null,
      });
      const savedConfig = normalizeSessionConfig(updated.config);
      setConfig(savedConfig);
      setRenderMode(savedConfig.render_mode);
      setUserPersona(savedConfig.user_persona);
      setConfigDirty(false);
      setActiveWorldBookId(updated.world_pack_id || '');
      if (updated.world_pack_id) {
        await loadCharacterCard(updated.world_pack_id);
      } else {
        setCharacterCard(null);
        setSelectedGreetingIndex(-1);
      }
      await loadSessionState();
      await loadRuntimeAssets();
    } catch (err) {
      setActiveWorldBookId(previousWorldBookId);
      setStreamError(err instanceof Error ? err.message : '切换世界书失败');
      console.error('Failed to update session world book:', err);
    } finally {
      setSessionResourceSaving(null);
    }
  }

  async function updateSessionPreset(presetId: string) {
    if (!sessionId || sessionResourceSaving) return;
    const nextConfig = normalizeSessionConfig({
      ...config,
      render_mode: renderMode,
      user_persona: userPersona,
      active_preset_id: presetId || undefined,
    });
    setConfig(nextConfig);
    setConfigDirty(true);
    setSessionResourceSaving('preset');
    setStreamError(null);
    try {
      const ok = await persistConfig(nextConfig);
      if (!ok) {
        setStreamError('保存预设设置失败');
      } else {
        await loadRuntimeAssets();
      }
    } finally {
      setSessionResourceSaving(null);
    }
  }

  async function applyUserPersonaPreset(value: string) {
    if (!value) return;
    const persona = value === 'global'
      ? loadGlobalSessionDefaults().user_persona
      : userPresets.find(p => p.id === value)?.persona;
    if (!persona) return;

    const nextConfig = normalizeSessionConfig({
      ...config,
      render_mode: renderMode,
      user_persona: persona,
    });
    setUserPersona(persona);
    setConfig(nextConfig);
    setConfigDirty(true);
    await persistConfig(nextConfig);
  }

  async function applyGlobalDefaultsToSession() {
    if (!sessionId) return;
    const nextConfig = loadGlobalSessionDefaults();
    setConfig(nextConfig);
    setRenderMode(nextConfig.render_mode);
    setUserPersona(nextConfig.user_persona);
    try {
      const updated = await api.updateSession(sessionId, { config: nextConfig });
      const savedConfig = normalizeSessionConfig(updated.config);
      setConfig(savedConfig);
      setRenderMode(savedConfig.render_mode);
      setUserPersona(savedConfig.user_persona);
      setConfigDirty(false);
    } catch (err) {
      console.error('Failed to apply global defaults:', err);
    }
  }

  function saveCurrentSessionAsGlobalDefaults() {
    saveGlobalSessionDefaults({
      ...config,
      render_mode: renderMode,
      user_persona: userPersona,
    });
  }

  // --- greeting / opening helpers ---

  function selectedGreetingText(): string {
    if (!characterCard) return '';
    const greetings = getParsedGreetings(characterCard);
    return greetings[selectedGreetingIndex + 1] || greetings[0] || '';
  }

  useEffect(() => {
    if (!characterCard) {
      setSelectedGreetingIndex(prev => (prev === -1 ? prev : -1));
      return;
    }
    const openingMessage = messages.find(msg => msg.turn_number === 0 && msg.role === 'assistant');
    if (!openingMessage) {
      setSelectedGreetingIndex(prev => (prev === -1 ? prev : -1));
      return;
    }

    const comparableOpening = cleanComparableMessageText(openingMessage.content);
    const greetings = getParsedGreetings(characterCard);
    const matchedGreetingIndex = greetings.findIndex((greeting: string) =>
      cleanComparableMessageText(greeting) === comparableOpening
    );
    const nextIndex = matchedGreetingIndex >= 0 ? matchedGreetingIndex - 1 : -1;
    setSelectedGreetingIndex(prev => (prev === nextIndex ? prev : nextIndex));
  }, [characterCard, messages]);

  return {
    sessionId,
    // data
    messages,
    setMessages,
    sessionTitle,
    setSessionTitle,
    config,
    setConfig,
    configDirty,
    setConfigDirty,
    characterCard,
    setCharacterCard,
    providers,
    worldBooks,
    presets,
    activeWorldBookId,
    setActiveWorldBookId,
    sessionResourceSaving,
    renderMode,
    setRenderMode,
    userPersona,
    setUserPersona,
    userPresets,
    setUserPresets,
    sessionMode,
    setSessionMode,
    selectedGreetingIndex,
    setSelectedGreetingIndex,
    sessionState,
    setSessionState,
    runtimeAssets,
    setRuntimeAssets,
    showVariableDebug,
    setShowVariableDebug,
    titleInput,
    setTitleInput,
    editingTitle,
    setEditingTitle,
    streamError,
    setStreamError,
    titleInputRef,
    // loaders
    loadSessionResources,
    loadSession,
    loadCharacterCard,
    loadMessages,
    loadSessionState,
    loadRuntimeAssets,
    // config
    persistConfig,
    saveConfig,
    updateConfig,
    updateRenderMode,
    updateUserPersona,
    updateUserSettingMergeStrategy,
    updateSessionWorldBook,
    updateSessionPreset,
    applyUserPersonaPreset,
    applyGlobalDefaultsToSession,
    saveCurrentSessionAsGlobalDefaults,
    selectedGreetingText,
  };
}
