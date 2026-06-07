import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import * as api from '../api/client';
import { useToast } from '../components/Toast';
import type { WorldBook, WorldBookDetail, WorldBookEntry, ParsedWorldBookEntry } from '../api/types';
import '../styles/world-books.css';

export default function WorldBooks() {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const returnTo = (location.state as any)?.from || '/';

  const [books, setBooks] = useState<WorldBook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorldBookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [parsingMode, setParsingMode] = useState<'single_agent' | 'multi_agent' | null>(null);
  const [viewMode, setViewMode] = useState<'raw' | 'single_agent' | 'multi_agent'>('raw');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadBooks().then(() => {
      // Auto-load detail if wb query param is present
      const wbId = searchParams.get('wb');
      if (wbId) loadDetail(wbId);
    });
  }, []);

  async function loadBooks() {
    try {
      const data = await api.listWorldBooks();
      setBooks(data.items);
    } catch (err) {
      console.error('Failed to load world books:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(id: string) {
    try {
      const d = await api.getWorldBook(id);
      setDetail(d);
      setSelectedId(id);
      setViewMode('raw');
    } catch (err) {
      console.error('Failed to load world book detail:', err);
    }
  }

  /** Parse PNG text chunks and extract embedded character card JSON. */
  async function extractFromPng(buffer: ArrayBuffer): Promise<any | null> {
    const view = new Uint8Array(buffer);
    const dataView = new DataView(buffer);
    if (view[0] !== 0x89 || view[1] !== 0x50 || view[2] !== 0x4E || view[3] !== 0x47) return null;

    const ascii = (bytes: Uint8Array): string => {
      let result = '';
      for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
      return result;
    };

    const decodeBase64Json = (b64: string): any | null => {
      try {
        const binStr = atob(b64.trim());
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        return JSON.parse(new TextDecoder('utf-8').decode(bytes));
      } catch { return null; }
    };

    const tryCardJson = (keyword: string, text: string): any | null => {
      if (keyword !== 'chara' && keyword !== 'ccv3') return null;
      const fromBase64 = decodeBase64Json(text);
      if (fromBase64?.data?.character_book) return fromBase64;
      try {
        const plain = JSON.parse(text);
        if (plain?.data?.character_book) return plain;
      } catch { /* ignore */ }
      return null;
    };

    let offset = 8;
    while (offset < view.length - 12) {
      const length = dataView.getUint32(offset);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > view.length) break;
      const type = ascii(view.slice(offset + 4, offset + 8));

      if (type === 'tEXt' && length > 0) {
        const chunkData = view.slice(dataStart, dataEnd);
        const nullIdx = chunkData.indexOf(0);
        if (nullIdx > 0) {
          const keyword = ascii(chunkData.slice(0, nullIdx));
          const text = new TextDecoder('latin1').decode(chunkData.slice(nullIdx + 1));
          const json = tryCardJson(keyword, text);
          if (json) return json;
        }
      } else if (type === 'iTXt' && length > 0) {
        const chunkData = view.slice(dataStart, dataEnd);
        const keywordEnd = chunkData.indexOf(0);
        if (keywordEnd > 0 && keywordEnd + 3 < chunkData.length) {
          const keyword = ascii(chunkData.slice(0, keywordEnd));
          const compressionFlag = chunkData[keywordEnd + 1];
          const compressionMethod = chunkData[keywordEnd + 2];
          let pos = keywordEnd + 3;
          while (pos < chunkData.length && chunkData[pos++] !== 0) {} // language tag
          while (pos < chunkData.length && chunkData[pos++] !== 0) {} // translated keyword
          let textBytes = chunkData.slice(pos);
          if (compressionFlag === 1 && compressionMethod === 0) {
            const stream = new Blob([textBytes]).stream().pipeThrough(new DecompressionStream('deflate'));
            textBytes = new Uint8Array(await new Response(stream).arrayBuffer());
          } else if (compressionFlag !== 0) {
            offset += 12 + length; continue;
          }
          const text = new TextDecoder('utf-8').decode(textBytes);
          const json = tryCardJson(keyword, text);
          if (json) return json;
        }
      }
      if (type === 'IEND') break;
      offset += 12 + length;
    }
    return null;
  }

  function createAvatarDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const maxSize = 256;
          const size = Math.min(img.width, img.height);
          const sourceX = Math.max(0, Math.round((img.width - size) / 2));
          const sourceY = Math.max(0, Math.round((img.height - size) * 0.35));
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(''); return; }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.clearRect(0, 0, maxSize, maxSize);
          ctx.drawImage(img, sourceX, sourceY, size, size, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) { reject(err); }
        finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取 PNG 头像')); };
      img.src = url;
    });
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.name.endsWith('.png')) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const buffer = event.target?.result as ArrayBuffer;
          const json = await extractFromPng(buffer);
          if (!json) { toast.error('PNG 文件中未找到角色卡数据'); return; }
          const imageDataUrl = await createAvatarDataUrl(file);
          if (imageDataUrl && (!json.avatar || json.avatar === 'none')) json.avatar = imageDataUrl;
          setImporting(true);
          const result = await api.importWorldBook(json);
          setBooks(prev => [{
            id: result.id, name: result.name, description: result.description,
            original_format: result.original_format, entry_count: result.entries.length,
            has_character_card: result.has_character_card,
            created_at: result.created_at, updated_at: result.updated_at,
          }, ...prev]);
        } catch (err) {
          toast.error('导入失败: ' + (err instanceof Error ? err.message : '未知错误'));
        } finally {
          setImporting(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const json = JSON.parse(event.target?.result as string);
          setImporting(true);
          const result = await api.importWorldBook(json);
          setBooks(prev => [{
            id: result.id, name: result.name, description: result.description,
            original_format: result.original_format, entry_count: result.entries.length,
            has_character_card: result.has_character_card,
            created_at: result.created_at, updated_at: result.updated_at,
          }, ...prev]);
        } catch (err) {
          toast.error('导入失败: ' + (err instanceof Error ? err.message : '未知错误'));
        } finally {
          setImporting(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      };
      reader.readAsText(file);
    }
  }

  async function handleExport(book: WorldBook | WorldBookDetail) {
    try {
      const data = await api.exportWorldBook(book.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${book.name}.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('导出失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除这个世界书？')) return;
    try {
      await api.deleteWorldBook(id);
      setBooks(prev => prev.filter(b => b.id !== id));
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
    } catch (err) {
      toast.error('删除失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  }

  async function handleRename() {
    if (!detail || !nameValue.trim()) return;
    try {
      await api.updateWorldBook(detail.id, { name: nameValue.trim() });
      setDetail({ ...detail, name: nameValue.trim() });
      setBooks(prev => prev.map(b => b.id === detail.id ? { ...b, name: nameValue.trim() } : b));
      setEditingName(false);
    } catch (err) { toast.error('重命名失败'); }
  }

  async function handleUpdateEntry(entryId: string, data: any) {
    if (!detail) return;
    try {
      await api.updateWorldBookEntry(detail.id, entryId, data);
      setDetail({ ...detail, entries: detail.entries.map(e => e.id === entryId ? { ...e, ...data } : e) });
      setEditingEntryId(null);
    } catch (err) { toast.error('更新失败'); }
  }

  async function handleDeleteEntry(entryId: string) {
    if (!detail) return;
    if (!confirm('确定删除此条目？')) return;
    try {
      await api.deleteWorldBookEntry(detail.id, entryId);
      setDetail({ ...detail, entries: detail.entries.filter(e => e.id !== entryId) });
    } catch (err) { toast.error('删除失败'); }
  }

  async function handleParse() {
    if (!detail) return;
    setParsingMode('multi_agent');
    try {
      const result = await api.parseWorldBook(detail.id);
      setViewMode('multi_agent');
      setDetail({ ...detail, parse_status: 'done', parsed_entries: result.entries });
    } catch (err) {
      toast.error('解析失败: ' + (err instanceof Error ? err.message : '未知错误'));
      setDetail({ ...detail, parse_status: 'error' });
    } finally { setParsingMode(null); }
  }

  async function handleParseSingleAgent() {
    if (!detail) return;
    setParsingMode('single_agent');
    try {
      const result = await api.parseWorldBookSingleAgent(detail.id);
      setViewMode('single_agent');
      setDetail({ ...detail, single_agent_parse_status: 'done', single_agent_parsed_entries: result.entries });
    } catch (err) {
      toast.error('解析失败: ' + (err instanceof Error ? err.message : '未知错误'));
      setDetail({ ...detail, single_agent_parse_status: 'error' });
    } finally { setParsingMode(null); }
  }

  if (loading) return <div className="wb-loading"><div className="wb-spinner" /></div>;

  // ── Detail View ──
  if (selectedId && detail) {
    return (
      <div className="wb-page">
        <div className="wb-detail-header">
          <div className="wb-detail-header-top">
            <button className="wb-back-btn" onClick={() => { setSelectedId(null); setDetail(null); setEditingEntryId(null); }}>
              ← 返回列表
            </button>
            <div className="wb-detail-actions">
              <button className="wb-action-btn" onClick={() => handleExport(detail)}>导出</button>
              <button className="wb-action-btn wb-danger" onClick={() => handleDelete(detail.id)}>删除</button>
            </div>
          </div>

          <div className="wb-detail-title-row">
            {editingName ? (
              <div className="wb-rename-inline">
                <input value={nameValue} onChange={e => setNameValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRename()} autoFocus />
                <button className="wb-action-btn" onClick={handleRename}>保存</button>
                <button className="wb-action-btn wb-ghost" onClick={() => setEditingName(false)}>取消</button>
              </div>
            ) : (
              <h1 className="wb-detail-name" onClick={() => { setNameValue(detail.name); setEditingName(true); }}>
                {detail.name}
                <span className="wb-edit-icon">✏️</span>
              </h1>
            )}
          </div>

          <div className="wb-detail-meta-row">
            <span className="wb-format-badge">{detail.original_format}</span>
            <span className={`wb-status-badge ${detail.parse_status || 'none'}`}>
              多Agent {detail.parse_status === 'done' ? '✓ 已解析' : detail.parse_status === 'parsing' ? '⏳ 解析中' : detail.parse_status === 'error' ? '✗ 失败' : '○ 未解析'}
            </span>
            <span className={`wb-status-badge ${detail.single_agent_parse_status || 'none'}`}>
              单Agent {detail.single_agent_parse_status === 'done' ? '✓ 已解析' : detail.single_agent_parse_status === 'parsing' ? '⏳ 解析中' : detail.single_agent_parse_status === 'error' ? '✗ 失败' : '○ 未解析'}
            </span>
            <span className="wb-entry-count">{detail.entries.length} 个条目</span>
          </div>

          {detail.description && <p className="wb-detail-desc">{detail.description}</p>}

          <div className="wb-detail-toolbar">
            {detail.has_character_card && detail.character_card_id && (
              <button className="wb-primary-btn" onClick={() => navigate(`/charactercards/import/${detail.character_card_id}?wb=${detail.id}`)}>
                🎭 角色卡工作台
              </button>
            )}
            <button className="wb-action-btn" onClick={handleParseSingleAgent} disabled={parsingMode !== null}>
              {parsingMode === 'single_agent' ? '⏳ 解析中...' : detail.single_agent_parse_status === 'done' ? '🔄 重新解析单Agent' : '解析为单Agent'}
            </button>
            <button className="wb-action-btn" onClick={handleParse} disabled={parsingMode !== null}>
              {parsingMode === 'multi_agent' ? '⏳ 解析中...' : detail.parse_status === 'done' ? '🔄 重新解析多Agent' : '解析为多Agent'}
            </button>
          </div>
        </div>

        {/* View mode tabs */}
        <div className="wb-tabs">
          <button className={`wb-tab ${viewMode === 'raw' ? 'active' : ''}`} onClick={() => setViewMode('raw')}>原始条目</button>
          <button className={`wb-tab ${viewMode === 'single_agent' ? 'active' : ''}`} onClick={() => setViewMode('single_agent')}>单Agent解析</button>
          <button className={`wb-tab ${viewMode === 'multi_agent' ? 'active' : ''}`} onClick={() => setViewMode('multi_agent')}>多Agent解析</button>
        </div>

        {/* Entries */}
        {viewMode !== 'raw' ? (
          <div className="wb-entry-list">
            {(viewMode === 'single_agent' ? detail.single_agent_parsed_entries : detail.parsed_entries).map((entry, i) => (
              <div key={i} className="wb-parsed-entry">
                <div className="wb-parsed-entry-header">
                  <span className={`wb-category-tag ${entry.category.startsWith('npc:') ? 'npc' : entry.category}`}>
                    {entry.category}
                  </span>
                  <span className={`wb-visibility-tag ${entry.visibility === 'public' ? 'public' : entry.visibility === 'gm_only' ? 'gm' : 'hidden'}`}>
                    {entry.visibility}
                  </span>
                </div>
                <div className="wb-parsed-entry-comment">{entry.comment || '(无标签)'}</div>
                <div className="wb-parsed-entry-content">{entry.content.slice(0, 200)}{entry.content.length > 200 ? '...' : ''}</div>
                <div className="wb-parsed-entry-reason">💡 {entry.reason}</div>
              </div>
            ))}
            {(viewMode === 'single_agent' ? detail.single_agent_parsed_entries : detail.parsed_entries).length === 0 && (
              <div className="wb-empty">暂无解析结果</div>
            )}
          </div>
        ) : (
          <div className="wb-entry-list">
            {detail.entries.map(entry => (
              <EntryRow
                key={entry.id}
                entry={entry}
                editing={editingEntryId === entry.id}
                onEdit={() => setEditingEntryId(entry.id)}
                onCancel={() => setEditingEntryId(null)}
                onSave={(data) => handleUpdateEntry(entry.id, data)}
                onDelete={() => handleDeleteEntry(entry.id)}
              />
            ))}
            {detail.entries.length === 0 && <div className="wb-empty">暂无条目</div>}
          </div>
        )}
      </div>
    );
  }

  // ── List View ──
  return (
    <div className="wb-page">
      <div className="wb-list-header">
        <div className="wb-list-header-top">
          <button className="wb-back-btn" onClick={() => navigate(returnTo)}>←</button>
          <h1 className="wb-page-title">世界书</h1>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.png"
            className="import-input-hidden"
            onChange={handleFileSelect}
          />
          <button className="wb-primary-btn" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            {importing ? '⏳ 导入中...' : '+ 导入'}
          </button>
        </div>
        <p className="wb-page-subtitle">管理世界书和角色卡条目</p>
      </div>

      <div className="wb-grid">
        {books.map(book => (
          <div key={book.id} className="wb-card" onClick={() => loadDetail(book.id)}>
            <div className="wb-card-header">
              <h3 className="wb-card-name">{book.name}</h3>
              <span className="wb-card-format">{book.original_format}</span>
            </div>
            <div className="wb-card-body">
              <span className="wb-card-meta">{book.entry_count} 个条目</span>
              {book.has_character_card && <span className="wb-card-tag">🎭 角色卡</span>}
            </div>
            <div className="wb-card-footer">
              <span className="wb-card-date">{new Date(book.created_at).toLocaleDateString()}</span>
              <div className="wb-card-actions" onClick={e => e.stopPropagation()}>
                <button className="wb-icon-btn" title="导出" onClick={() => handleExport(book)}>📤</button>
                <button className="wb-icon-btn wb-danger-icon" title="删除" onClick={() => handleDelete(book.id)}>🗑️</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {books.length === 0 && (
        <div className="wb-empty-state">
          <div className="wb-empty-icon">📚</div>
          <h3>暂无世界书</h3>
          <p>导入 SillyTavern JSON 或 PNG 文件开始使用</p>
        </div>
      )}
    </div>
  );
}

// ── Entry Row Component ──
function EntryRow({ entry, editing, onEdit, onCancel, onSave, onDelete }: {
  entry: WorldBookEntry;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (data: any) => void;
  onDelete: () => void;
}) {
  const [comment, setComment] = useState(entry.comment);
  const [content, setContent] = useState(entry.content);
  const [keysStr, setKeysStr] = useState(entry.keys.join(', '));
  const [secKeysStr, setSecKeysStr] = useState(entry.secondary_keys.join(', '));
  const [priority, setPriority] = useState(entry.priority);
  const [enabled, setEnabled] = useState(entry.enabled);
  const [constant, setConstant] = useState(entry.constant);
  const [position, setPosition] = useState(entry.position);
  const [selective, setSelective] = useState(entry.selective);
  const [selectiveLogic, setSelectiveLogic] = useState(entry.selective_logic);

  if (editing) {
    return (
      <div className="wb-entry-edit">
        <div className="wb-edit-field">
          <label>标签</label>
          <input value={comment} onChange={e => setComment(e.target.value)} />
        </div>
        <div className="wb-edit-field">
          <label>触发词（逗号分隔）</label>
          <input value={keysStr} onChange={e => setKeysStr(e.target.value)} />
        </div>
        <div className="wb-edit-field">
          <label>内容</label>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={6} />
        </div>
        <div className="wb-edit-options">
          <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 启用</label>
          <label><input type="checkbox" checked={constant} onChange={e => setConstant(e.target.checked)} /> 常驻</label>
          <label><input type="checkbox" checked={selective} onChange={e => setSelective(e.target.checked)} /> 选择性</label>
          <label>优先级 <input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} style={{ width: 60 }} /></label>
          <label>注入位置
            <select value={position} onChange={e => setPosition(e.target.value)}>
              <option value="before_char">角色卡前</option>
              <option value="after_char">角色卡后</option>
              <option value="at_depth">对话深度</option>
            </select>
          </label>
        </div>
        {selective && (
          <div className="wb-edit-field">
            <label>次要触发词（逗号分隔）</label>
            <input value={secKeysStr} onChange={e => setSecKeysStr(e.target.value)} />
            <label>逻辑
              <select value={selectiveLogic} onChange={e => setSelectiveLogic(Number(e.target.value))}>
                <option value={0}>任一匹配 (AND_ANY)</option>
                <option value={1}>非全部 (NOT_ALL)</option>
                <option value={2}>无一匹配 (NOT_ANY)</option>
                <option value={3}>全部匹配 (AND_ALL)</option>
              </select>
            </label>
          </div>
        )}
        <div className="wb-edit-actions">
          <button className="wb-action-btn" onClick={() => onSave({
            comment, content,
            keys: keysStr.split(',').map(s => s.trim()).filter(Boolean),
            secondary_keys: secKeysStr.split(',').map(s => s.trim()).filter(Boolean),
            priority, enabled, constant, position, selective, selective_logic: selectiveLogic,
          })}>保存</button>
          <button className="wb-action-btn wb-ghost" onClick={onCancel}>取消</button>
          <button className="wb-action-btn wb-danger" onClick={onDelete} style={{ marginLeft: 'auto' }}>删除</button>
        </div>
      </div>
    );
  }

  return (
    <div className="wb-entry-row" onClick={onEdit}>
      <span className={`wb-entry-dot ${entry.enabled ? 'on' : 'off'}`} />
      <span className="wb-entry-label">{entry.comment || '(无标签)'}</span>
      {entry.constant && <span className="wb-const-tag">常驻</span>}
      <span className="wb-entry-keys">{entry.keys.join(', ')}</span>
      <span className="wb-entry-preview">{entry.content.slice(0, 120)}{entry.content.length > 120 ? '...' : ''}</span>
      <span className="wb-entry-priority">{entry.priority}</span>
    </div>
  );
}
