import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import type { WorldBook, WorldBookDetail, WorldBookEntry, ParsedWorldBookEntry } from '../api/types';

export default function WorldBooks() {
  const [books, setBooks] = useState<WorldBook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorldBookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parsedEntries, setParsedEntries] = useState<ParsedWorldBookEntry[] | null>(null);
  const [showParsed, setShowParsed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => { loadBooks(); }, []);

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
    } catch (err) {
      console.error('Failed to load world book detail:', err);
    }
  }

  /** Parse PNG text chunks and extract embedded character card JSON. */
  async function extractFromPng(buffer: ArrayBuffer): Promise<any | null> {
    const view = new Uint8Array(buffer);
    const dataView = new DataView(buffer);
    // PNG signature check
    if (view[0] !== 0x89 || view[1] !== 0x50 || view[2] !== 0x4E || view[3] !== 0x47) {
      return null;
    }

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
      } catch {
        return null;
      }
    };

    const tryCardJson = (keyword: string, text: string): any | null => {
      if (keyword !== 'chara' && keyword !== 'ccv3') return null;

      // SillyTavern PNG cards usually store base64 JSON in tEXt chunks.
      const fromBase64 = decodeBase64Json(text);
      if (fromBase64?.data?.character_book) return fromBase64;

      // Some tools store plain JSON in iTXt chunks.
      try {
        const plain = JSON.parse(text);
        if (plain?.data?.character_book) return plain;
      } catch {
        // Ignore malformed card chunks and continue scanning.
      }
      return null;
    };

    let offset = 8; // skip signature
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
          let pos = keywordEnd + 3; // compression method follows the flag.
          while (pos < chunkData.length && chunkData[pos++] !== 0) {
            // language tag
          }
          while (pos < chunkData.length && chunkData[pos++] !== 0) {
            // translated keyword
          }
          let textBytes = chunkData.slice(pos);
          if (compressionFlag === 1 && compressionMethod === 0) {
            const stream = new Blob([textBytes]).stream().pipeThrough(new DecompressionStream('deflate'));
            textBytes = new Uint8Array(await new Response(stream).arrayBuffer());
          } else if (compressionFlag !== 0) {
            offset += 12 + length;
            continue;
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
          if (!ctx) {
            resolve('');
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.clearRect(0, 0, maxSize, maxSize);
          ctx.drawImage(img, sourceX, sourceY, size, size, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取 PNG 头像'));
      };
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
          if (!json) {
            alert('PNG 文件中未找到角色卡数据');
            return;
          }
          const imageDataUrl = await createAvatarDataUrl(file);
          if (imageDataUrl && (!json.avatar || json.avatar === 'none')) {
            json.avatar = imageDataUrl;
          }
          setImporting(true);
          const result = await api.importWorldBook(json);
          setBooks(prev => [{
            id: result.id,
            name: result.name,
            description: result.description,
            original_format: result.original_format,
            entry_count: result.entries.length,
            has_character_card: result.has_character_card,
            created_at: result.created_at,
            updated_at: result.updated_at,
          }, ...prev]);
        } catch (err) {
          alert('导入失败: ' + (err instanceof Error ? err.message : '未知错误'));
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
            id: result.id,
            name: result.name,
            description: result.description,
            original_format: result.original_format,
            entry_count: result.entries.length,
            has_character_card: result.has_character_card,
            created_at: result.created_at,
            updated_at: result.updated_at,
          }, ...prev]);
        } catch (err) {
          alert('导入失败: ' + (err instanceof Error ? err.message : '未知错误'));
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
      a.href = url;
      a.download = `${book.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('导出失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除这个世界书？')) return;
    try {
      await api.deleteWorldBook(id);
      setBooks(prev => prev.filter(b => b.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (err) {
      alert('删除失败: ' + (err instanceof Error ? err.message : '未知错误'));
    }
  }

  async function handleRename() {
    if (!detail || !nameValue.trim()) return;
    try {
      await api.updateWorldBook(detail.id, { name: nameValue.trim() });
      setDetail({ ...detail, name: nameValue.trim() });
      setBooks(prev => prev.map(b => b.id === detail.id ? { ...b, name: nameValue.trim() } : b));
      setEditingName(false);
    } catch (err) {
      alert('重命名失败');
    }
  }

  async function handleUpdateEntry(entryId: string, data: any) {
    if (!detail) return;
    try {
      await api.updateWorldBookEntry(detail.id, entryId, data);
      setDetail({
        ...detail,
        entries: detail.entries.map(e => e.id === entryId ? { ...e, ...data } : e),
      });
      setEditingEntryId(null);
    } catch (err) {
      alert('更新失败');
    }
  }

  async function handleDeleteEntry(entryId: string) {
    if (!detail) return;
    if (!confirm('确定删除此条目？')) return;
    try {
      await api.deleteWorldBookEntry(detail.id, entryId);
      setDetail({
        ...detail,
        entries: detail.entries.filter(e => e.id !== entryId),
      });
    } catch (err) {
      alert('删除失败');
    }
  }

  async function handleParse() {
    if (!detail) return;
    setParsing(true);
    try {
      const result = await api.parseWorldBook(detail.id);
      setParsedEntries(result.entries);
      setShowParsed(true);
      setDetail({ ...detail, parse_status: 'done' });
    } catch (err) {
      alert('解析失败: ' + (err instanceof Error ? err.message : '未知错误'));
      setDetail({ ...detail, parse_status: 'error' });
    } finally {
      setParsing(false);
    }
  }

  if (loading) return <div className="loading">加载中...</div>;

  // Detail view
  if (selectedId && detail) {
    return (
      <div className="worldbooks">
        <div className="chat-header">
          <button className="back-btn" onClick={() => { setSelectedId(null); setDetail(null); setEditingEntryId(null); }}>&larr; 返回</button>
          {editingName ? (
            <div className="rename-inline">
              <input value={nameValue} onChange={e => setNameValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRename()} autoFocus />
              <button onClick={handleRename}>保存</button>
              <button onClick={() => setEditingName(false)}>取消</button>
            </div>
          ) : (
            <h2 onClick={() => { setNameValue(detail.name); setEditingName(true); }} style={{ flex: 1, cursor: 'pointer' }}>
              {detail.name}
            </h2>
          )}
          <span className="format-badge">{detail.original_format}</span>
          <span className={`parse-badge ${detail.parse_status || 'none'}`}>
            {detail.parse_status === 'done' ? '已解析' : detail.parse_status === 'parsing' ? '解析中' : detail.parse_status === 'error' ? '解析失败' : '未解析'}
          </span>
          {detail.has_character_card && detail.character_card_id && (
            <button className="action-btn" onClick={() => navigate(`/charactercards/${detail.character_card_id}`)}>角色卡</button>
          )}
          <button className="action-btn" onClick={handleParse} disabled={parsing}>
            {parsing ? '解析中...' : detail.parse_status === 'done' ? '重新解析' : '解析为多Agent'}
          </button>
          <button className="action-btn" onClick={() => handleExport(detail)}>导出</button>
          <button className="action-btn danger" onClick={() => handleDelete(detail.id)}>删除</button>
        </div>

        {detail.description && <p className="wb-description">{detail.description}</p>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <span className="meta">{detail.entries.length} 个条目</span>
          {parsedEntries && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={`filter-tab ${!showParsed ? 'active' : ''}`} onClick={() => setShowParsed(false)}>原始条目</button>
              <button className={`filter-tab ${showParsed ? 'active' : ''}`} onClick={() => setShowParsed(true)}>多Agent解析</button>
            </div>
          )}
        </div>

        {showParsed && parsedEntries ? (
          <div className="entry-list">
            {parsedEntries.map((entry, i) => (
              <div key={i} className="parsed-entry-row">
                <span className={`parsed-category-badge ${entry.category.startsWith('npc:') ? 'npc' : entry.category}`}>
                  {entry.category}
                </span>
                <div className="parsed-entry-content">
                  <div className="parsed-entry-comment">{entry.comment || '(无标签)'}</div>
                  <div className="parsed-entry-preview">{entry.content.slice(0, 150)}{entry.content.length > 150 ? '...' : ''}</div>
                  <div className="parsed-entry-reason">{entry.reason}</div>
                </div>
                <span className={`parse-badge ${entry.visibility === 'public' ? 'done' : entry.visibility === 'gm_only' ? 'error' : 'parsing'}`}>
                  {entry.visibility}
                </span>
              </div>
            ))}
          </div>
        ) : (
        <div className="entry-list">
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
          {detail.entries.length === 0 && <p className="meta" style={{ padding: 20 }}>暂无条目</p>}
        </div>
        )}
      </div>
    );
  }

  // List view
  return (
    <div className="worldbooks">
      <div className="chat-header">
        <button className="back-btn" onClick={() => navigate('/')}>&larr;</button>
        <h2 style={{ flex: 1 }}>世界书</h2>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.png"
          className="import-input-hidden"
          id="wb-import"
          onChange={handleFileSelect}
        />
        <button className="import-btn" onClick={() => fileInputRef.current?.click()} disabled={importing}>
          {importing ? '导入中...' : '导入'}
        </button>
      </div>

      <div className="worldbook-list">
        {books.map(book => (
          <div key={book.id} className="worldbook-card">
            <div className="worldbook-info" onClick={() => loadDetail(book.id)} style={{ cursor: 'pointer', flex: 1 }}>
              <h4>
                {book.name}
                <span className="format-badge">{book.original_format}</span>
                {book.has_character_card && <span className="format-badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>角色卡</span>}
              </h4>
              <span className="meta">{book.entry_count} 个条目 &middot; {new Date(book.created_at).toLocaleDateString()}</span>
            </div>
            <div className="worldbook-actions">
              <button className="action-btn" onClick={() => handleExport(book)}>导出</button>
              <button className="action-btn danger" onClick={() => handleDelete(book.id)}>删除</button>
            </div>
          </div>
        ))}
        {books.length === 0 && <p className="meta" style={{ padding: 20, textAlign: 'center' }}>暂无世界书，导入 SillyTavern JSON 文件开始使用。</p>}
      </div>
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
      <div className="entry-edit-form">
        <div className="form-row">
          <label>标签</label>
          <input value={comment} onChange={e => setComment(e.target.value)} />
        </div>
        <div className="form-row">
          <label>触发词（逗号分隔）</label>
          <input value={keysStr} onChange={e => setKeysStr(e.target.value)} />
        </div>
        <div className="form-row">
          <label>内容</label>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={6} />
        </div>
        <div className="form-row-inline">
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
          <div className="form-row">
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
        <div className="form-actions">
          <button className="action-btn" onClick={() => onSave({
            comment, content,
            keys: keysStr.split(',').map(s => s.trim()).filter(Boolean),
            secondary_keys: secKeysStr.split(',').map(s => s.trim()).filter(Boolean),
            priority, enabled, constant, position, selective, selective_logic: selectiveLogic,
          })}>保存</button>
          <button className="action-btn" onClick={onCancel}>取消</button>
          <button className="action-btn danger" onClick={onDelete} style={{ marginLeft: 'auto' }}>删除</button>
        </div>
      </div>
    );
  }

  return (
    <div className="entry-row" onClick={onEdit}>
      <div className="entry-status-col">
        <span className={`entry-status ${entry.enabled ? 'enabled' : 'disabled'}`} />
      </div>
      <div className="entry-label-col">
        <strong>{entry.comment || '(无标签)'}</strong>
        {entry.constant && <span className="constant-badge">常驻</span>}
      </div>
      <div className="entry-keys-col">
        <span className="keys-preview">{entry.keys.join(', ')}</span>
      </div>
      <div className="entry-content-col">
        <span className="content-preview">{entry.content.slice(0, 120)}{entry.content.length > 120 ? '...' : ''}</span>
      </div>
      <div className="entry-priority-col">
        <span className="meta">{entry.priority}</span>
      </div>
    </div>
  );
}
