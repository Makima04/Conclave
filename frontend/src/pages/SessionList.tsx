import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import type { Session } from '../api/types';

export default function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('single_agent');
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    loadSessions();
  }, []);

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

  async function handleCreate() {
    try {
      const session = await api.createSession(title || undefined, mode);
      setTitle('');
      navigate(`/chat/${session.id}`);
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
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

  if (loading) return <div className="loading">加载中...</div>;

  return (
    <div className="session-list">
      <h1>Conclave</h1>
      <p className="subtitle">多 Agent RP / 写作平台</p>

      <div className="top-actions">
        <button className="settings-btn" onClick={() => navigate('/settings')}>设置</button>
      </div>

      <div className="create-session">
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="会话标题（可选）"
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <select value={mode} onChange={e => setMode(e.target.value)}>
          <option value="single_agent">单 Agent</option>
          <option value="strict_director">严格导演</option>
          <option value="collaborative_director">协作导演</option>
          <option value="multi_npc_scene">多 NPC 场景</option>
        </select>
        <button onClick={handleCreate}>新建会话</button>
      </div>

      <div className="sessions">
        {sessions.length === 0 ? (
          <p className="empty">暂无会话，点击上方按钮创建。</p>
        ) : (
          sessions.map(session => (
            <div
              key={session.id}
              className="session-card"
              onClick={() => navigate(`/chat/${session.id}`)}
            >
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
                  <h3>{session.title || '未命名会话'}</h3>
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
  );
}
