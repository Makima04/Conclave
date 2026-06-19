import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api/client';
import type {
  CharacterCard,
  Message,
  Session,
  SessionConfig,
  SessionRuntimeAssets,
  StHostRenderPayload,
} from '../../api/types';
import { createStRuntimeStore } from '../../pages/st-runtime/store';
import { installStGlobals, uninstallStGlobals } from '../../pages/st-runtime/globals';
import { resolveOpeningIndex, sortMessages } from './helpers';

export const EMPTY_RUNTIME_ASSETS: SessionRuntimeAssets = {
  regex_scripts: [],
  tavern_helper_scripts: [],
};

export interface ChatSessionState {
  session: Session | null;
  characterCard: CharacterCard | null;
  runtimeAssets: SessionRuntimeAssets;
  renderPayload: StHostRenderPayload | null;
  messages: Message[];
  openingIndex: number;
  runtimeReady: boolean;
  loading: boolean;
  error: string | null;
  configSaving: boolean;
}

export interface UseChatSessionStateResult extends ChatSessionState {
  store: ReturnType<typeof createStRuntimeStore>;
  reload: (showSpinner?: boolean) => Promise<void>;
  setOpeningIndex: (index: number) => void;
  setError: (error: string | null) => void;
  /** Optimistic + debounced session-config patch (no per-keystroke reload). */
  patchConfig: (patch: Partial<SessionConfig>) => void;
}

/**
 * Loads and holds the chat session state: session, character card, runtime
 * assets, backend-rendered payload, messages, and the ST runtime store.
 * Extracted from pages/StHost.tsx so both StHost and /chat pages can share it.
 */
export function useChatSessionState(sessionId: string | undefined): UseChatSessionStateResult {
  const storeRef = useRef(createStRuntimeStore());
  const [session, setSession] = useState<Session | null>(null);
  const [characterCard, setCharacterCard] = useState<CharacterCard | null>(null);
  const [runtimeAssets, setRuntimeAssets] = useState<SessionRuntimeAssets>(EMPTY_RUNTIME_ASSETS);
  const [renderPayload, setRenderPayload] = useState<StHostRenderPayload | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [openingIndex, setOpeningIndex] = useState(0);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounced config persistence: optimistic local update + a single PUT after
  // typing settles, instead of a PUT + full reload() per keystroke.
  const configRef = useRef<SessionConfig | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [configSaving, setConfigSaving] = useState(false);

  const refreshRuntimeStore = useCallback(
    async (card: CharacterCard | null, assets: SessionRuntimeAssets) => {
      if (!sessionId || !card) {
        uninstallStGlobals();
        setRuntimeReady(false);
        return;
      }
      await storeRef.current.load(sessionId, card, assets);
      installStGlobals(storeRef.current);
      setRuntimeReady(true);
    },
    [sessionId],
  );

  const reload = useCallback(
    async (showSpinner = false) => {
      if (!sessionId) return;
      if (showSpinner) setLoading(true);
      setError(null);
      try {
        const sessionData = await api.getSession(sessionId);
        const [, messageData, runtimeAssetData, cardData, renderData] = await Promise.all([
          api.getSession(sessionId),
          api.listMessages(sessionId).catch(e => {
            console.error('[ChatSession] failed to load messages:', e);
            return { items: [] };
          }),
          api.getSessionRuntimeAssets(sessionId).catch(e => {
            console.error('[ChatSession] failed to load runtime assets:', e);
            return EMPTY_RUNTIME_ASSETS;
          }),
          sessionData.world_pack_id
            ? api.getWorldBookCharacterCard(sessionData.world_pack_id).catch(e => {
                console.warn('[ChatSession] no character card for worldbook:', e);
                return null;
              })
            : Promise.resolve(null),
          sessionData.world_pack_id
            ? api.getSessionStHostRender(sessionId).catch(e => {
                console.warn('[ChatSession] failed to load rendered HTML:', e);
                return null;
              })
            : Promise.resolve(null),
        ]);

        const nextMessages = sortMessages(messageData.items || []);
        const nextAssets = {
          regex_scripts: Array.isArray(runtimeAssetData.regex_scripts) ? runtimeAssetData.regex_scripts : [],
          tavern_helper_scripts: Array.isArray(runtimeAssetData.tavern_helper_scripts)
            ? runtimeAssetData.tavern_helper_scripts
            : [],
        };

        setSession(sessionData);
        setMessages(nextMessages);
        setRuntimeAssets(nextAssets);
        setCharacterCard(cardData);

        // IMPORTANT: populate the ST runtime store (_chat) BEFORE setting
        // renderPayload. Card status-bar JS runs `getChatMessages(...)` on
        // iframe document-ready — once, with no retry. If _chat is still
        // empty when the iframe mounts, it throws "无法加载状态数据" and
        // never recovers (values stay blank). store.load is awaited here so
        // _chat is ready before React commits the render that mounts the
        // message iframes.
        if (cardData) {
          await refreshRuntimeStore(cardData, nextAssets);
        } else {
          uninstallStGlobals();
          setRuntimeReady(false);
        }

        setRenderPayload(renderData);
        setOpeningIndex(resolveOpeningIndex(cardData, nextMessages));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (showSpinner) setLoading(false);
      }
    },
    [refreshRuntimeStore, sessionId],
  );

  // Keep a ref of the latest merged config so the debounced save persists the
  // full config, not just the most recent single-field patch.
  useEffect(() => {
    configRef.current = session?.config ?? null;
  }, [session]);

  // Apply the patch to local session state immediately (so inputs feel instant),
  // then persist it with a single debounced PUT. No reload — a config change
  // does not affect messages or rendered HTML until the next turn.
  const patchConfig = useCallback(
    (patch: Partial<SessionConfig>) => {
      if (!sessionId) return;
      setSession(prev => (prev ? { ...prev, config: { ...prev.config, ...patch } } : prev));
      setConfigSaving(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const cfg = configRef.current;
        if (!cfg) {
          setConfigSaving(false);
          return;
        }
        try {
          await api.updateSession(sessionId, { config: cfg });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setConfigSaving(false);
        }
      }, 400);
    },
    [sessionId, setError],
  );

  useEffect(() => {
    void reload(true);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      storeRef.current.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return {
    session,
    characterCard,
    runtimeAssets,
    renderPayload,
    messages,
    openingIndex,
    runtimeReady,
    loading,
    error,
    configSaving,
    store: storeRef.current,
    reload,
    setOpeningIndex,
    setError,
    patchConfig,
  };
}
