import { useMemo, useState, useEffect } from 'react';
import type { MouseEvent } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import * as api from '../api/client';
import type { Preset, Session, WorldBook } from '../api/types';
import type { AppShellOutletContext } from '../components/AppShell';
import { NewSessionDialog, type NewSessionDraft } from '../components/NewSessionDialog';
import { loadGlobalSessionDefaults } from '../settings/sessionDefaults';
import { useToast } from '../components/Toast';

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60_000) return '刚刚';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return dateStr.slice(0, 10);
}

export default function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [selectedWorldBookId, setSelectedWorldBookId] = useState<string | null>(null);
  const [dialogWorldBookId, setDialogWorldBookId] = useState<string | null | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { registerOpenNewSessionDialog } = useOutletContext<AppShellOutletContext>();
  const toast = useToast();
  const defaultConfig = useMemo(() => loadGlobalSessionDefaults(), [dialogWorldBookId]);

  useEffect(() => {
    loadSessions();
    api.listWorldBooks().then(d => setWorldBooks(d.items)).catch(() => {});
    api.listPresets()
      .then(d => setPresets(d.items))
      .catch(err => {
        console.error('Failed to load presets:', err);
        toast.error('加载预设失败');
      })
      .finally(() => setPresetsLoading(false));
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [toast]);

  useEffect(() => {
    registerOpenNewSessionDialog?.(() => setDialogWorldBookId(null));
    return () => registerOpenNewSessionDialog?.(null);
  }, [registerOpenNewSessionDialog]);

  async function loadSessions() {
    try {
      const data = await api.listSessions();
      setSessions(data.items);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string, e: MouseEvent) {
    e.stopPropagation();
    try {
      await api.deleteSession(id);
      setSessions(sessions.filter(s => s.id !== id));
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }

  async function handleRename(id: string) {
    const newTitle = renameValue.trim();
    setRenamingId(null);
    if (!newTitle) return;
    try {
      await api.updateSession(id, { title: newTitle });
      setSessions(sessions.map(s => s.id === id ? { ...s, title: newTitle } : s));
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  }

  function handleWorldBookCardClick(wbId: string | null) {
    setSelectedWorldBookId(prev => prev === wbId ? null : wbId);
  }

  function openNewSessionDialog(worldBookId: string | null) {
    setDialogWorldBookId(worldBookId);
  }

  async function handleCreateSession(draft: NewSessionDraft) {
    if (creating) return;
    setCreating(true);
    try {
      const config = {
        ...loadGlobalSessionDefaults(),
        active_preset_id: draft.presetId || undefined,
      };
      const worldBookId = dialogWorldBookId || undefined;
      const session = await api.createSession(undefined, draft.mode, worldBookId, config);
      setSessions(prev => [session, ...prev.filter(s => s.id !== session.id)]);
      setDialogWorldBookId(undefined);
      navigate(`/chat/${session.id}`);
    } catch (err) {
      console.error('Failed to create session:', err);
      toast.error(err instanceof Error ? err.message : '新建会话失败');
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="loading">加载中...</div>;

  // Recent sessions: sorted by updated_at descending, take first 6
  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 6);

  // Build world book session counts (including "none" for sessions without a world book)
  const wbSessionCounts = new Map<string | null, number>();
  for (const s of sessions) {
    const key = s.world_pack_id || null;
    wbSessionCounts.set(key, (wbSessionCounts.get(key) || 0) + 1);
  }

  // Sessions for the selected world book
  const selectedWbSessions = selectedWorldBookId === null
    ? sessions.filter(s => !s.world_pack_id)
    : sessions.filter(s => s.world_pack_id === selectedWorldBookId);

  const selectedWbName = selectedWorldBookId === null
    ? '无世界书'
    : worldBooks.find(w => w.id === selectedWorldBookId)?.name || '未知世界书';

  return (
    <div className="sl-page">
      {/* Recent Sessions */}
      <div className="sl-section-title">最近会话</div>
      {recentSessions.length === 0 ? (
        <p className="sl-recent-empty">还没有会话</p>
      ) : (
        <div className="sl-recent-grid">
          {recentSessions.map(session => {
            const wb = session.world_pack_id
              ? worldBooks.find(w => w.id === session.world_pack_id)
              : undefined;
            return (
              <div
                key={session.id}
                className="sl-recent-card"
                onClick={() => navigate(`/chat/${session.id}`)}
              >
                <div className="recent-avatar">
                  {wb?.character_card_avatar && wb.character_card_avatar !== 'none' ? (
                    <img src={wb.character_card_avatar} alt="" />
                  ) : (
                    <span className="recent-avatar-fallback">🎭</span>
                  )}
                </div>
                <div className="recent-info">
                  <div className="recent-title">{session.title || '未命名会话'}</div>
                  <div className="recent-meta">第{session.current_turn}轮 · {relativeTime(session.updated_at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* World Book Grid */}
      <div className="sl-section-title">世界书</div>
      <div className="sl-wb-grid">
        {worldBooks.map(wb => (
          <div
            key={wb.id}
            className={`sl-wb-card ${selectedWorldBookId === wb.id ? 'selected' : ''}`}
            onClick={() => handleWorldBookCardClick(wb.id)}
          >
            <div className="wb-avatar">
              {wb.character_card_avatar && wb.character_card_avatar !== 'none' ? (
                <img src={wb.character_card_avatar} alt="" />
              ) : (
                <span className="wb-avatar-fallback">🎭</span>
              )}
            </div>
            <div className="wb-info">
              <div className="wb-name">{wb.name}</div>
              <div className="wb-count">{wbSessionCounts.get(wb.id) || 0} 个会话</div>
            </div>
          </div>
        ))}
        {/* "No world book" card */}
        {(wbSessionCounts.get(null) || 0) > 0 && (
          <div
            className={`sl-wb-card ${selectedWorldBookId === null ? 'selected' : ''}`}
            onClick={() => handleWorldBookCardClick(null)}
          >
            <div className="wb-avatar">
              <span className="wb-avatar-fallback">📭</span>
            </div>
            <div className="wb-info">
              <div className="wb-name">无世界书</div>
              <div className="wb-count">{wbSessionCounts.get(null) || 0} 个会话</div>
            </div>
          </div>
        )}
      </div>

      {/* Selected World Book Sessions */}
      {selectedWorldBookId !== null && (
        <div className="sl-wb-sessions">
          <div className="sl-section-title">
            {selectedWbName}
            <button
              className="sl-action-btn"
              onClick={() => openNewSessionDialog(selectedWorldBookId)}
            >
              + 新建
            </button>
          </div>
          <div className="sl-sessions">
            {selectedWbSessions.length === 0 ? (
              <p className="sl-empty">暂无会话</p>
            ) : (
              selectedWbSessions.map(session => (
                <div
                  key={session.id}
                  className="sl-card"
                  onClick={() => navigate(`/chat/${session.id}`)}
                >
                  {session.world_pack_id && (() => {
                    const wb = worldBooks.find(w => w.id === session.world_pack_id);
                    if (!wb) return null;
                    return (
                      <div className="session-avatar">
                        {wb.character_card_avatar && wb.character_card_avatar !== 'none' ? (
                          <img src={wb.character_card_avatar} alt="" />
                        ) : (
                          <span className="session-avatar-fallback">🎭</span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="session-info">
                    {renamingId === session.id ? (
                      <input
                        className="rename-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={() => handleRename(session.id)}
                        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleRename(session.id); if (e.key === 'Escape') setRenamingId(null); }}
                        onClick={e => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <h3>
                        {session.title || '未命名会话'}
                        {session.status === 'processing' && <span className="processing-spinner" title="正在生成中" />}
                      </h3>
                    )}
                    <span className="meta">
                      第 {session.current_turn} 轮 · {session.mode}
                    </span>
                  </div>
                  <div className="session-actions">
                    <button
                      className="rename-btn"
                      onClick={e => { e.stopPropagation(); setRenamingId(session.id); setRenameValue(session.title); }}
                      title="重命名"
                    >
                      重命名
                    </button>
                    <button
                      className="delete-btn"
                      onClick={e => handleDelete(session.id, e)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <NewSessionDialog
        open={dialogWorldBookId !== undefined}
        worldBook={dialogWorldBookId ? worldBooks.find(w => w.id === dialogWorldBookId) || null : null}
        presets={presets}
        loadingPresets={presetsLoading}
        submitting={creating}
        defaultConfig={defaultConfig}
        onClose={() => {
          if (!creating) setDialogWorldBookId(undefined);
        }}
        onSubmit={handleCreateSession}
      />
    </div>
  );
}
