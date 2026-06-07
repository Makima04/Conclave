import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import * as api from '../api/client';
import { useToast } from '../components/Toast';
import type { Preset, PresetDetail, PresetModule } from '../api/types';
import '../styles/presets.css';

const AGENT_LABELS: Record<string, string> = {
  writer: '写手',
  director: '导演',
  master: '总控',
  compression: '摘要',
  state: '状态',
  parser: '解析',
  inject_all: '全局',
  discard: '丢弃',
};

export default function Presets() {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as any)?.from || '/';
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [presets, setPresets] = useState<Preset[]>([]);
  const [selected, setSelected] = useState<PresetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [expandedModule, setExpandedModule] = useState<string | null>(null);

  const openPresetDetail = (detail: PresetDetail) => {
    setSelected(detail);
    setEditingName(false);
    setNameInput(detail.name);
    setExpandedModule(null);
  };

  const closePresetDetail = () => {
    setSelected(null);
    setEditingName(false);
    setNameInput('');
    setExpandedModule(null);
  };

  const loadPresets = async () => {
    try {
      const res = await api.listPresets();
      setPresets(res.items);
    } catch (e) {
      console.error('Failed to load presets', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadPresets(); }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const result = await api.importPreset(json, undefined, file.name);
      openPresetDetail(result);
      loadPresets();
    } catch (err: any) {
      toast.error('导入失败: ' + (err.message || err));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSelect = async (id: string) => {
    try {
      const detail = await api.getPreset(id);
      openPresetDetail(detail);
    } catch (e) {
      console.error('Failed to load preset', e);
    }
  };

  const handleDelete = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!confirm('确定删除此预设？')) return;
    await api.deletePreset(id);
    if (selected?.id === id) closePresetDetail();
    loadPresets();
  };

  const handleParse = async () => {
    if (!selected) return;
    setParsing(true);
    try {
      await api.parsePreset(selected.id);
      const detail = await api.getPreset(selected.id);
      openPresetDetail(detail);
      loadPresets();
    } catch (e: any) {
      toast.error('解析失败: ' + (e.message || e));
    } finally {
      setParsing(false);
    }
  };

  const handleRename = async () => {
    if (!selected || !nameInput.trim()) return;
    await api.updatePreset(selected.id, { name: nameInput.trim() });
    setSelected({ ...selected, name: nameInput.trim() });
    setEditingName(false);
    loadPresets();
  };

  const handleToggleModule = async (mod: PresetModule) => {
    if (!selected) return;
    await api.updatePresetModule(selected.id, mod.id, { enabled: !mod.enabled });
    setSelected({
      ...selected,
      modules: selected.modules.map(m =>
        m.id === mod.id ? { ...m, enabled: !m.enabled } : m
      ),
    });
  };

  const handleUpdateTargets = async (mod: PresetModule, agent: string) => {
    if (!selected) return;
    const newTargets = mod.target_agents.includes(agent)
      ? mod.target_agents.filter(a => a !== agent)
      : [...mod.target_agents, agent];
    await api.updatePresetModule(selected.id, mod.id, { target_agents: newTargets });
    setSelected({
      ...selected,
      modules: selected.modules.map(m =>
        m.id === mod.id ? { ...m, target_agents: newTargets, classification: 'manual' } : m
      ),
    });
  };

  if (loading) return <div className="loading">加载中...</div>;

  // Detail view
  if (selected) {
    const enabledCount = selected.modules.filter(m => m.enabled).length;
    const classifiedCount = selected.modules.filter(m => m.classification === 'llm' || m.classification === 'manual').length;

    return (
      <div className="worldbooks">
        <div className="chat-header">
          <button className="back-btn" onClick={closePresetDetail}>&larr; 返回</button>
          {editingName ? (
            <div className="rename-inline">
              <input
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleRename()}
                autoFocus
              />
              <button onClick={handleRename}>保存</button>
              <button onClick={() => { setNameInput(selected.name); setEditingName(false); }}>取消</button>
            </div>
          ) : (
            <h2
              onClick={() => { setNameInput(selected.name); setEditingName(true); }}
              style={{ flex: 1, cursor: 'pointer' }}
            >
              {selected.name}
            </h2>
          )}
          <span className={`parse-badge ${
            selected.parse_status === 'done' ? 'done' :
            selected.parse_status === 'parsing' ? 'parsing' :
            selected.parse_status === 'error' ? 'error' : 'none'
          }`}>
            {selected.parse_status === 'done' ? '已解析' :
             selected.parse_status === 'parsing' ? '解析中...' :
             selected.parse_status === 'error' ? '解析失败' : '未解析'}
          </span>
          <button className="action-btn" onClick={handleParse} disabled={parsing}>
            {parsing ? '解析中...' : selected.parse_status === 'done' ? '重新解析' : 'LLM 解析'}
          </button>
          <button className="action-btn danger" onClick={() => handleDelete(selected.id)}>删除</button>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0' }}>
          <span className="meta">{selected.modules.length} 个模块</span>
          <span className="meta">{enabledCount} 启用</span>
          <span className="meta">{classifiedCount} 已分类</span>
        </div>

        {/* Model params summary */}
        {Object.keys(selected.model_params).length > 0 && (
          <div className="detail-section">
            <h3>模型参数</h3>
            <div className="param-grid">
              {Object.entries(selected.model_params).map(([k, v]) => (
                <div key={k} className="param-item">
                  <span className="param-label">{k}</span>
                  <span className="param-value">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Modules list */}
        <div className="detail-section">
          <h3>模块列表</h3>
          <div className="module-list">
            {selected.modules.map(mod => (
              <div
                key={mod.id}
                className={`module-row ${!mod.enabled ? 'module-disabled' : ''}`}
              >
                <div className="module-header" onClick={() => setExpandedModule(
                  expandedModule === mod.id ? null : mod.id
                )}>
                  <label className="module-toggle" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={mod.enabled}
                      onChange={() => handleToggleModule(mod)}
                    />
                  </label>
                  <span className="module-name">{mod.name || mod.identifier}</span>
                  <span className="module-role">{mod.role}</span>
                  <div className="module-agents">
                    {['writer', 'director', 'master', 'compression', 'state', 'inject_all'].map(agent => (
                      <button
                        key={agent}
                        className={`agent-tag ${mod.target_agents.includes(agent) ? 'agent-active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); handleUpdateTargets(mod, agent); }}
                        title={AGENT_LABELS[agent] || agent}
                      >
                        {AGENT_LABELS[agent] || agent}
                      </button>
                    ))}
                  </div>
                  {mod.classification === 'llm' && <span className="badge badge-sm badge-info">LLM</span>}
                  {mod.classification === 'manual' && <span className="badge badge-sm badge-warning">手动</span>}
                </div>

                {expandedModule === mod.id && (
                  <div className="module-detail">
                    {mod.reason && <p className="module-reason">💡 {mod.reason}</p>}
                    <pre className="module-content">{mod.content || '(空内容)'}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="worldbooks">
      <div className="chat-header">
        <button className="back-btn" onClick={() => navigate(returnTo)}>&larr;</button>
        <h2 style={{ flex: 1 }}>预设管理</h2>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="import-input-hidden"
          id="preset-import"
          onChange={handleFileSelect}
        />
        <button className="import-btn" onClick={() => fileInputRef.current?.click()} disabled={importing}>
          {importing ? '导入中...' : '导入'}
        </button>
      </div>

      <div className="worldbook-list">
        {presets.map(p => (
          <div key={p.id} className="worldbook-card" onClick={() => handleSelect(p.id)}>
            <div className="worldbook-info" style={{ cursor: 'pointer', flex: 1 }}>
              <h4>
                {p.name}
                <span className="format-badge">{p.source_format}</span>
                <span className={`parse-badge ${
                  p.parse_status === 'done' ? 'done' :
                  p.parse_status === 'parsing' ? 'parsing' :
                  p.parse_status === 'error' ? 'error' : 'none'
                }`}>
                  {p.parse_status === 'done' ? '已解析' :
                   p.parse_status === 'parsing' ? '解析中' :
                   p.parse_status === 'error' ? '解析失败' : '未解析'}
                </span>
              </h4>
              <span className="meta">{p.module_count} 个模块 &middot; {new Date(p.created_at).toLocaleDateString()}</span>
            </div>
            <div className="worldbook-actions">
              <button className="action-btn danger" onClick={(e) => handleDelete(p.id, e)}>删除</button>
            </div>
          </div>
        ))}
        {presets.length === 0 && (
          <p className="meta" style={{ padding: 20, textAlign: 'center' }}>
            暂无预设，导入 SillyTavern 系统预设 JSON 文件开始使用。
          </p>
        )}
      </div>
    </div>
  );
}
