import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import type { Preset, Session, WorldBook } from '../api/types';
import { applyUserPersonaToConfig, loadGlobalSessionDefaults, loadUserPersonaPresets, type UserPersonaPreset } from '../settings/sessionDefaults';
import '../styles/session-list.css';

export default function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('multi_agent');
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [selectedWorldBookId, setSelectedWorldBookId] = useState('');
  const [filterWorldBookId, setFilterWorldBookId] = useState<string>('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [userPresets, setUserPresets] = useState<UserPersonaPreset[]>([]);
  const [selectedUserPresetId, setSelectedUserPresetId] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    loadSessions();
    api.listWorldBooks().then(d => setWorldBooks(d.items)).catch(() => {});
    api.listPresets().then(d => setPresets(d.items)).catch(() => {});
    setUserPresets(loadUserPersonaPresets());
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
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
      let defaults = loadGlobalSessionDefaults();
      if (selectedUserPresetId) {
        const preset = userPresets.find(p => p.id === selectedUserPresetId);
        if (preset) defaults = applyUserPersonaToConfig(defaults, preset.persona);
      }
      if (selectedPresetId) {
        defaults = { ...defaults, active_preset_id: selectedPresetId };
      }
      const session = await api.createSession(title || undefined, mode, selectedWorldBookId || undefined, defaults);
      setTitle('');
      setSelectedWorldBookId('');
      setSelectedPresetId('');
      setSelectedUserPresetId('');
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

  function handleWorldBookSelect(worldBookId: string) {
    setSelectedWorldBookId(worldBookId);
    setFilterWorldBookId(worldBookId || 'none');
  }

  function handleWorldBookFilter(worldBookId: string) {
    setFilterWorldBookId(worldBookId);
    setSelectedWorldBookId(worldBookId === 'none' ? '' : worldBookId);
  }

  if (loading) return <div className="loading">加载中...</div>;

  const filteredSessions = filterWorldBookId === ''
    ? sessions
    : filterWorldBookId === 'none'
      ? sessions.filter(s => !s.world_pack_id)
      : sessions.filter(s => s.world_pack_id === filterWorldBookId);

  return (
    <div className="session-list">
      <h1>小祥舞台</h1>

      <div className="top-actions">
        <button className="settings-btn" onClick={() => navigate('/worldbooks')}>世界书</button>
        <button className="settings-btn" onClick={() => navigate('/presets')}>预设</button>
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
          <option value="multi_agent">多 Agent</option>
        </select>
        {presets.length > 0 && (
          <select value={selectedPresetId} onChange={e => setSelectedPresetId(e.target.value)}>
            <option value="">不选择预设</option>
            {presets.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        {worldBooks.length > 0 && (
          <select value={selectedWorldBookId} onChange={e => handleWorldBookSelect(e.target.value)}>
            <option value="">不选择世界书</option>
            {worldBooks.map(wb => (
              <option key={wb.id} value={wb.id}>{wb.name} ({wb.entry_count}条)</option>
            ))}
          </select>
        )}
        {userPresets.length > 0 && (
          <select value={selectedUserPresetId} onChange={e => setSelectedUserPresetId(e.target.value)}>
            <option value="">User：当前全局默认</option>
            {userPresets.map(p => <option key={p.id} value={p.id}>User：{p.title}</option>)}
          </select>
        )}
        <button onClick={handleCreate}>新建会话</button>
      </div>

      {/* World Book filter tabs */}
      {worldBooks.length > 0 && (
        <div className="filter-tabs">
          <button
            className={`filter-tab ${filterWorldBookId === '' ? 'active' : ''}`}
            onClick={() => handleWorldBookFilter('')}
          >全部</button>
          {worldBooks.map(wb => (
            <button
              key={wb.id}
              className={`filter-tab ${filterWorldBookId === wb.id ? 'active' : ''}`}
              onClick={() => handleWorldBookFilter(wb.id)}
            >{wb.name}</button>
          ))}
          <button
            className={`filter-tab ${filterWorldBookId === 'none' ? 'active' : ''}`}
            onClick={() => handleWorldBookFilter('none')}
          >无世界书</button>
        </div>
      )}

      <div className="sessions">
        {filteredSessions.length === 0 ? (
          <p className="empty">暂无会话，点击上方按钮创建。</p>
        ) : (
          filteredSessions.map(session => (
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
                  <h3>
                    {session.title || '未命名会话'}
                    {session.status === 'processing' && <span className="processing-spinner" title="正在生成中" />}
                  </h3>
                )}
                <span className="meta">
                  第 {session.current_turn} 轮 · {session.mode}
                  {session.world_pack_id && (() => {
                    const wb = worldBooks.find(w => w.id === session.world_pack_id);
                    return wb ? ` · ${wb.name}` : '';
                  })()}
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
