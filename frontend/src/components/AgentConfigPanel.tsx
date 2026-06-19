import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client';
import type { Session, SessionConfig, WorldBookDetail } from '../api/types';
import { useProviders } from '../contexts/AppContext';
import { AgentManagerPanel } from '../pages/chat/AgentManagerPanel';

/**
 * Inspector「配置」tab 的自包含配置面板：自己取 session + worldbook，再把现有
 * AgentManagerPanel（建/编辑/冷却/模型·参数·上下文 tab + 回退默认模型）原样渲染。
 * 这样独立大页面无需依赖 /chat 的 session context，配置逻辑零重写复用。
 *
 * session 配置变更走乐观更新 + 防抖持久化（同 useChatSessionState.patchConfig 的做法），
 * 避免逐键 PUT + reload 的卡顿。
 */
export function AgentConfigPanel({ sessionId }: { sessionId: string }) {
  const { providers } = useProviders();
  const [session, setSession] = useState<Session | null>(null);
  const [worldBook, setWorldBook] = useState<WorldBookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configRef = useRef<SessionConfig | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep configRef in lockstep with the optimistic session state so the
  // debounced save always persists the latest merged config (mirrors
  // useChatSessionState.patchConfig).
  useEffect(() => {
    configRef.current = session?.config ?? null;
  }, [session]);

  const load = useCallback(async () => {
    try {
      const s = await api.getSession(sessionId);
      setSession(s);
      if (s.world_pack_id) {
        api.getWorldBook(s.world_pack_id).then(setWorldBook).catch(() => {});
      } else {
        setWorldBook(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [load]);

  const onConfigChange = useCallback(
    (patch: Partial<SessionConfig>) => {
      setSession(prev => (prev ? { ...prev, config: { ...prev.config, ...patch } } : prev));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const cfg = configRef.current;
        if (!cfg) return;
        try {
          await api.updateSession(sessionId, { config: cfg });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }, 400);
    },
    [sessionId],
  );

  if (error) return <div className="insp-error">{error}</div>;
  if (!session) return <p className="insp-empty">加载会话…</p>;

  return (
    <AgentManagerPanel
      sessionId={sessionId}
      providers={providers}
      config={session.config}
      onConfigChange={onConfigChange}
      worldBook={worldBook}
    />
  );
}
