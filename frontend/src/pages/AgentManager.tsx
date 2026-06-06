import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import type { SubAgent } from '../api/client';
import type { ProviderConfig } from '../api/types';

const STATUS_COLORS: Record<string, string> = {
  active: '#5B8A5E',
  cooldown: '#B89A5B',
  retired: '#6B5E78',
  dead: '#C92546',
};

const AGENT_TYPES = ['npc', 'writer', 'director', 'parser', 'state', 'user'];

export default function AgentManager() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newType, setNewType] = useState('npc');
  const [newLabel, setNewLabel] = useState('');
  const [newContext, setNewContext] = useState('');
  const [newModel, setNewModel] = useState('');
  const [newModelSource, setNewModelSource] = useState<'default' | 'provider' | 'custom'>('default');

  // Edit modal state
  const [editingAgent, setEditingAgent] = useState<SubAgent | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editContext, setEditContext] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editModelSource, setEditModelSource] = useState<'default' | 'provider' | 'custom'>('default');

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      setError('无效的会话 ID，请从正确的入口进入此页面。');
      return;
    }
    loadAgents();
    loadProviders();
  }, [sessionId]);

  async function loadProviders() {
    try {
      const data = await api.listProviders();
      setProviders(data.items || []);
    } catch (err) {
      console.error('Failed to load providers:', err);
    }
  }

  async function loadAgents() {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAgents(sessionId);
      setAgents(Array.isArray(data?.items) ? data.items : []);
    } catch (err: any) {
      const message = err?.message || '加载 Agent 列表失败，请稍后重试。';
      setError(message);
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleCooldown(agentId: string) {
    try {
      await api.cooldownAgent(sessionId!, agentId);
      loadAgents();
    } catch (err: any) {
      setError(err?.message || '冷却 Agent 失败');
    }
  }

  async function handleRestore(agentId: string) {
    try {
      await api.restoreAgent(sessionId!, agentId);
      loadAgents();
    } catch (err: any) {
      setError(err?.message || '恢复 Agent 失败');
    }
  }

  async function handleDelete(agentId: string) {
    if (!confirm('确定要删除此 Agent？')) return;
    try {
      await api.deleteAgent(sessionId!, agentId);
      loadAgents();
    } catch (err: any) {
      setError(err?.message || '删除 Agent 失败');
    }
  }

  function resolveModel(source: 'default' | 'provider' | 'custom', value: string): string | undefined {
    if (source === 'default') return undefined;
    if (source === 'custom') return value || undefined;
    // provider: value is the provider id, find its model
    const provider = providers.find(p => p.id === value);
    return provider?.model || undefined;
  }

  async function handleCreate() {
    try {
      await api.createAgent(sessionId!, {
        agent_type: newType,
        label: newLabel || undefined,
        context: newContext || undefined,
        model: resolveModel(newModelSource, newModel),
      });
      setShowCreate(false);
      setNewLabel('');
      setNewContext('');
      setNewModel('');
      setNewModelSource('default');
      loadAgents();
    } catch (err: any) {
      setError(err?.message || '创建 Agent 失败');
    }
  }

  function openEdit(agent: SubAgent) {
    setEditingAgent(agent);
    setEditLabel(agent.label || '');
    setEditContext(agent.context_preview || '');
    const agentModel = agent.config?.model || '';
    if (!agentModel) {
      setEditModelSource('default');
      setEditModel('');
    } else {
      const matchingProvider = providers.find(p => p.model === agentModel);
      if (matchingProvider) {
        setEditModelSource('provider');
        setEditModel(matchingProvider.id);
      } else {
        setEditModelSource('custom');
        setEditModel(agentModel);
      }
    }
  }

  async function handleSaveEdit() {
    if (!editingAgent) return;
    try {
      const resolvedModel = resolveModel(editModelSource, editModel);
      const newConfig = { ...editingAgent.config };
      if (resolvedModel) {
        newConfig.model = resolvedModel;
      } else {
        delete newConfig.model;
      }
      await api.updateAgent(sessionId!, editingAgent.id, {
        label: editLabel || undefined,
        context: editContext || undefined,
        config: newConfig,
      });
      setEditingAgent(null);
      loadAgents();
    } catch (err: any) {
      setError(err?.message || '更新 Agent 失败');
    }
  }

  if (loading) return <div className="loading">加载中...</div>;

  if (error) {
    return (
      <div className="agent-manager">
        <div className="agent-header">
          <button className="back-btn" onClick={() => navigate(-1)}>返回</button>
          <h2>Agent 管理</h2>
        </div>
        <div className="error-state" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--danger)', marginBottom: '1rem' }}>加载失败: {error}</p>
          <button onClick={loadAgents}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-manager">
      <div className="agent-header">
        <button className="back-btn" onClick={() => navigate(`/chat/${sessionId}`)}>返回对话</button>
        <h2>Agent 管理</h2>
        <button className="create-btn" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? '取消' : '+ 创建 Agent'}
        </button>
      </div>

      {showCreate && (
        <div className="create-agent-form">
          <div className="form-row">
            <label>类型:</label>
            <select value={newType} onChange={e => setNewType(e.target.value)}>
              {AGENT_TYPES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>标签:</label>
            <input
              type="text"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="显示名称（如 角色名）"
            />
          </div>
          <div className="form-row">
            <label>模型:</label>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <select
                value={newModelSource === 'provider' ? newModel : newModelSource}
                onChange={e => {
                  const val = e.target.value;
                  if (val === 'default') {
                    setNewModelSource('default');
                    setNewModel('');
                  } else if (val === 'custom') {
                    setNewModelSource('custom');
                    setNewModel('');
                  } else {
                    setNewModelSource('provider');
                    setNewModel(val);
                  }
                }}
              >
                <option value="default">使用 session 默认模型</option>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name} — {p.model}{p.is_default ? ' (默认)' : ''}</option>
                ))}
                <option value="custom">自定义模型名称...</option>
              </select>
              {newModelSource === 'custom' && (
                <input
                  type="text"
                  value={newModel}
                  onChange={e => setNewModel(e.target.value)}
                  placeholder="输入模型名称，如 gpt-4o"
                />
              )}
            </div>
          </div>
          <div className="form-row">
            <label>上下文:</label>
            <textarea
              value={newContext}
              onChange={e => setNewContext(e.target.value)}
              placeholder="Agent 专属上下文（角色档案、世界观片段等）"
              rows={4}
            />
          </div>
          <button onClick={handleCreate}>创建</button>
        </div>
      )}

      <div className="agent-grid">
        {agents.length === 0 ? (
          <p className="empty">暂无 Agent。创建一个多 Agent 会话后，系统会自动初始化默认 Agent。</p>
        ) : (
          agents.map(agent => (
            <div key={agent.id} className="agent-card">
              <div className="agent-card-header">
                <span className="agent-type-badge">{agent.agent_type}</span>
                <span
                  className="agent-status-badge"
                  style={{ backgroundColor: STATUS_COLORS[agent.status] || '#666' }}
                >
                  {agent.status}
                </span>
              </div>
              <h3 className="agent-label">{agent.label || agent.id.slice(0, 8)}</h3>
              {agent.config?.model && (
                <p className="agent-model">模型: {agent.config.model}</p>
              )}
              {agent.character_id && (
                <p className="agent-char-id">角色: {agent.character_id}</p>
              )}
              <p className="agent-context">{agent.context_preview || '(无上下文)'}</p>
              <p className="agent-turn">最后活跃: 第 {agent.last_active_turn} 轮</p>
              <div className="agent-actions">
                <button className="edit-btn" onClick={() => openEdit(agent)}>编辑</button>
                {agent.status === 'active' && agent.agent_type === 'npc' && (
                  <button className="cooldown-btn" onClick={() => handleCooldown(agent.id)}>冷却</button>
                )}
                {agent.status === 'cooldown' && (
                  <button className="restore-btn" onClick={() => handleRestore(agent.id)}>恢复</button>
                )}
                {(agent.status === 'active' || agent.status === 'cooldown') && (
                  <button className="delete-btn" onClick={() => handleDelete(agent.id)}>删除</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {editingAgent && (
        <div className="modal-overlay" onClick={() => setEditingAgent(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>编辑 Agent: {editingAgent.label || editingAgent.id.slice(0, 8)}</h3>
            <div className="form-row">
              <label>标签:</label>
              <input
                type="text"
                value={editLabel}
                onChange={e => setEditLabel(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>模型:</label>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <select
                  value={editModelSource === 'provider' ? editModel : editModelSource}
                  onChange={e => {
                    const val = e.target.value;
                    if (val === 'default') {
                      setEditModelSource('default');
                      setEditModel('');
                    } else if (val === 'custom') {
                      setEditModelSource('custom');
                      setEditModel('');
                    } else {
                      setEditModelSource('provider');
                      setEditModel(val);
                    }
                  }}
                >
                  <option value="default">使用 session 默认模型</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name} — {p.model}{p.is_default ? ' (默认)' : ''}</option>
                  ))}
                  <option value="custom">自定义模型名称...</option>
                </select>
                {editModelSource === 'custom' && (
                  <input
                    type="text"
                    value={editModel}
                    onChange={e => setEditModel(e.target.value)}
                    placeholder="输入模型名称"
                  />
                )}
              </div>
            </div>
            <div className="form-row">
              <label>上下文:</label>
              <textarea
                value={editContext}
                onChange={e => setEditContext(e.target.value)}
                rows={6}
              />
            </div>
            <div className="modal-actions">
              <button onClick={handleSaveEdit}>保存</button>
              <button onClick={() => setEditingAgent(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
