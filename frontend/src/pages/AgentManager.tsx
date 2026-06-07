import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import type { SubAgent } from '../api/client';
import { useProviders } from '../contexts/AppContext';
import { describeModelRef, ModelPicker } from '../settings/modelSelection';
import '../styles/agent-manager.css';

const STATUS_COLORS: Record<string, string> = {
  active: '#5B8A5E',
  cooldown: '#B89A5B',
  retired: '#6B5E78',
  dead: '#C92546',
};

const AGENT_TYPES = ['npc', 'writer', 'director', 'parser', 'state'];

function sortAgents(a: SubAgent, b: SubAgent) {
  if (a.agent_type === 'user' && b.agent_type !== 'user') return -1;
  if (b.agent_type === 'user' && a.agent_type !== 'user') return 1;
  return a.agent_type.localeCompare(b.agent_type) || a.label.localeCompare(b.label);
}

export default function AgentManager() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { providers } = useProviders();
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newType, setNewType] = useState('npc');
  const [newLabel, setNewLabel] = useState('');
  const [newContext, setNewContext] = useState('');
  const [newModel, setNewModel] = useState('');

  // Edit modal state
  const [editingAgent, setEditingAgent] = useState<SubAgent | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editContext, setEditContext] = useState('');
  const [editModel, setEditModel] = useState('');

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      setError('无效的会话 ID，请从正确的入口进入此页面。');
      return;
    }
    loadAgents();
  }, [sessionId]);

  async function loadAgents() {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAgents(sessionId);
      setAgents(Array.isArray(data?.items) ? [...data.items].sort(sortAgents) : []);
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

  async function handleCreate() {
    try {
      await api.createAgent(sessionId!, {
        agent_type: newType,
        label: newLabel || undefined,
        context: newContext || undefined,
        model: newModel || undefined,
      });
      setShowCreate(false);
      setNewLabel('');
      setNewContext('');
      setNewModel('');
      loadAgents();
    } catch (err: any) {
      setError(err?.message || '创建 Agent 失败');
    }
  }

  function openEdit(agent: SubAgent) {
    setEditingAgent(agent);
    setEditLabel(agent.label || '');
    setEditContext(agent.context || '');
    setEditModel(agent.config?.model || '');
  }

  async function handleSaveEdit() {
    if (!editingAgent) return;
    try {
      const newConfig = { ...editingAgent.config };
      if (editModel) {
        newConfig.model = editModel;
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
            <ModelPicker value={newModel} providers={providers} defaultText="使用 session 默认模型" onChange={setNewModel} />
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
            <div key={agent.id} className={`agent-card ${agent.fixed ? 'agent-card-fixed' : ''}`}>
              <div className="agent-card-header">
                <span className="agent-type-badge">{agent.agent_type}</span>
                {agent.fixed && <span className="agent-type-badge">fixed</span>}
                <span
                  className="agent-status-badge"
                  style={{ backgroundColor: STATUS_COLORS[agent.status] || '#666' }}
                >
                  {agent.status}
                </span>
              </div>
              <h3 className="agent-label">{agent.label || agent.id.slice(0, 8)}</h3>
              {agent.config?.model && (
                <p className="agent-model">模型: {describeModelRef(agent.config.model, providers)}</p>
              )}
              {agent.character_id && (
                <p className="agent-char-id">角色: {agent.character_id}</p>
              )}
              <p className="agent-context">{agent.context_preview || '(无上下文)'}</p>
              <p className="agent-turn">最后活跃: 第 {agent.last_active_turn} 轮</p>
              <div className="agent-actions">
                <button className="edit-btn" onClick={() => openEdit(agent)}>编辑</button>
                {agent.status === 'active' && agent.agent_type === 'npc' && !agent.fixed && (
                  <button className="cooldown-btn" onClick={() => handleCooldown(agent.id)}>冷却</button>
                )}
                {agent.status === 'cooldown' && !agent.fixed && (
                  <button className="restore-btn" onClick={() => handleRestore(agent.id)}>恢复</button>
                )}
                {(agent.status === 'active' || agent.status === 'cooldown') && !agent.fixed && (
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
              <ModelPicker value={editModel} providers={providers} defaultText="使用 session 默认模型" onChange={setEditModel} />
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
