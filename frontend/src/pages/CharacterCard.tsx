import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import { useToast } from '../components/Toast';
import type { CharacterCard } from '../api/types';
import '../styles/character-card.css';

export default function CharacterCardPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [card, setCard] = useState<CharacterCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedGreeting, setExpandedGreeting] = useState<number | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (id) loadCard(id);
  }, [id]);

  async function loadCard(cardId: string) {
    try {
      const data = await api.getCharacterCard(cardId);
      setCard(data);
    } catch (err) {
      console.error('Failed to load character card:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveField(field: string) {
    if (!card) return;
    try {
      await api.updateCharacterCard(card.id, { [field]: editValue });
      setCard({ ...card, [field]: editValue });
      setEditingSection(null);
    } catch (err) {
      toast.error('保存失败');
    }
  }

  function startEdit(field: string, currentValue: string) {
    setEditingSection(field);
    setEditValue(currentValue);
  }

  if (loading) return <div className="loading">加载中...</div>;
  if (!card) return <div className="loading">角色卡未找到</div>;

  const displayGreeting = (text: string, maxLen = 120) =>
    text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

  const sections = [
    { key: 'description', icon: '📖', title: '角色描述' },
    { key: 'personality', icon: '🎭', title: '性格特征' },
    { key: 'scenario', icon: '🌍', title: '世界场景' },
    { key: 'system_prompt', icon: '⚙️', title: '系统提示词' },
    { key: 'post_history_instructions', icon: '📝', title: '历史后指令' },
    { key: 'creator_notes', icon: '💬', title: '作者笔记' },
    { key: 'mes_example', icon: '💬', title: '对话示例' },
  ];

  return (
    <div className="cc-page">
      {/* Header with gradient banner */}
      <div className="cc-banner">
        <div className="cc-banner-actions">
          <button className="cc-back-btn" onClick={() => navigate(-1)}>← 返回</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="cc-spec-badge">{card.spec}</span>
            <button className="cc-link-btn" onClick={() => navigate('/worldbooks')}>📚 世界书</button>
            <button className="btn-import-card" onClick={() => navigate('/charactercards/import')}>📦 导入角色卡</button>
          </div>
        </div>
      </div>

      {/* Profile section */}
      <div className="cc-profile">
        <div className="cc-avatar-large">
          {card.avatar && card.avatar !== 'none'
            ? <img src={card.avatar} alt={card.name} />
            : <span>{card.name.charAt(0)}</span>
          }
        </div>
        <div className="cc-profile-info">
          {editingSection === 'name' ? (
            <div className="cc-edit-inline">
              <input value={editValue} onChange={e => setEditValue(e.target.value)} autoFocus
                onKeyDown={e => e.key === 'Enter' && handleSaveField('name')} />
              <button onClick={() => handleSaveField('name')}>✓</button>
              <button onClick={() => setEditingSection(null)}>✕</button>
            </div>
          ) : (
            <h1 className="cc-name-large" onClick={() => startEdit('name', card.name)}>
              {card.name}
              <span className="cc-edit-hint">✏️</span>
            </h1>
          )}
          <div className="cc-meta-row">
            {card.creator && <span className="cc-meta-item">👤 {card.creator}</span>}
            {card.character_version && <span className="cc-meta-item">🏷️ v{card.character_version}</span>}
          </div>
          {card.tags.length > 0 && (
            <div className="cc-tags">
              {card.tags.map((tag, i) => <span key={i} className="cc-tag">{tag}</span>)}
            </div>
          )}
        </div>
      </div>

      {/* Personality quick view */}
      {card.personality && (
        <div className="cc-personality-bar">
          <span className="cc-personality-label">🎭 性格</span>
          <span className="cc-personality-text">{card.personality}</span>
        </div>
      )}

      {/* First message */}
      {card.first_mes && (
        <div className="cc-first-mes-section">
          <div className="cc-section-label">💬 开场白</div>
          <div className="cc-first-mes-bubble">
            <div className="cc-mes-avatar">{card.name.charAt(0)}</div>
            <div className="cc-mes-content">{card.first_mes}</div>
          </div>
        </div>
      )}

      {/* Alternate greetings */}
      {card.alternate_greetings.length > 0 && (
        <div className="cc-greetings-section">
          <div className="cc-section-label">🔀 可选开场白 ({card.alternate_greetings.length})</div>
          <div className="cc-greetings-list">
            {card.alternate_greetings.map((g, i) => (
              <div key={i} className={`cc-greeting-card ${expandedGreeting === i ? 'expanded' : ''}`}
                onClick={() => setExpandedGreeting(expandedGreeting === i ? null : i)}>
                <div className="cc-greeting-header">
                  <span className="cc-greeting-num">#{i + 1}</span>
                  <span className="cc-greeting-preview">
                    {expandedGreeting === i ? '收起' : displayGreeting(g)}
                  </span>
                  <span className="cc-greeting-arrow">{expandedGreeting === i ? '▲' : '▼'}</span>
                </div>
                {expandedGreeting === i && (
                  <div className="cc-greeting-full">{g}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collapsible detail sections */}
      <div className="cc-detail-sections">
        {sections.map(({ key, icon, title }) => {
          const content = (card as any)[key] as string;
          if (!content && editingSection !== key) return null;
          return (
            <CollapsibleSection
              key={key}
              icon={icon}
              title={title}
              content={content || ''}
              editing={editingSection === key}
              editValue={editValue}
              onStartEdit={() => startEdit(key, content || '')}
              onChange={setEditValue}
              onSave={() => handleSaveField(key)}
              onCancel={() => setEditingSection(null)}
            />
          );
        })}
      </div>

      {/* Extensions */}
      {typeof card.extensions?.world === 'string' && (
        <div className="cc-ext-section">
          <div className="cc-section-label">🌐 关联世界</div>
          <p className="cc-ext-text">{card.extensions.world}</p>
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({ icon, title, content, editing, editValue, onStartEdit, onChange, onSave, onCancel }: {
  icon: string; title: string; content: string;
  editing: boolean; editValue: string;
  onStartEdit: () => void; onChange: (v: string) => void;
  onSave: () => void; onCancel: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`cc-detail-card ${expanded ? 'expanded' : ''}`}>
      <div className="cc-detail-header" onClick={() => !editing && setExpanded(!expanded)}>
        <span className="cc-detail-icon">{icon}</span>
        <span className="cc-detail-title">{title}</span>
        {content && <span className="cc-detail-len">{content.length} 字</span>}
        <span className="cc-detail-arrow">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && !editing && (
        <div className="cc-detail-body">
          <pre className="cc-detail-content">{content}</pre>
          <button className="cc-detail-edit-btn" onClick={(e) => { e.stopPropagation(); onStartEdit(); }}>✏️ 编辑</button>
        </div>
      )}
      {editing && (
        <div className="cc-detail-body">
          <textarea className="cc-detail-textarea" value={editValue} onChange={e => onChange(e.target.value)} rows={8} autoFocus />
          <div className="cc-detail-edit-actions">
            <button onClick={onSave}>保存</button>
            <button className="cancel-btn" onClick={onCancel}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
