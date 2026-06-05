import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import * as api from '../api/client';
import type { Message, SessionConfig } from '../api/types';
import { DEFAULT_SESSION_CONFIG } from '../api/types';

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const codeStr = String(children).replace(/\n$/, '');

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(codeStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (match) {
    return (
      <div className="code-block-container">
        <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div" customStyle={{ margin: '8px 0', borderRadius: '6px', fontSize: '13px', overflow: 'auto' }}>
          {codeStr}
        </SyntaxHighlighter>
        <button className="code-copy-float" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    );
  }
  return <code className={className}>{children}</code>;
}

export default function Chat() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [config, setConfig] = useState<SessionConfig>({ ...DEFAULT_SESSION_CONFIG });
  const [showConfig, setShowConfig] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [rawViewIds, setRawViewIds] = useState<Set<string>>(new Set());
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamTextRef = useRef('');

  useEffect(() => {
    if (!sessionId) return;
    loadMessages();
    loadSession();
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  async function loadSession() {
    try {
      const session = await api.getSession(sessionId!);
      setSessionTitle(session.title || '未命名会话');
      if (session.config) {
        setConfig({
          ...DEFAULT_SESSION_CONFIG,
          ...session.config,
          system_prompt: session.config.system_prompt || '',
        });
      }
    } catch (err) {
      console.error('Failed to load session:', err);
    }
  }

  async function loadMessages() {
    try {
      const data = await api.listMessages(sessionId!);
      setMessages(data.items);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }

  async function saveConfig() {
    try {
      await api.updateSession(sessionId!, { config });
      setConfigDirty(false);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  function updateConfig<K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }));
    setConfigDirty(true);
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || streaming) return;

    if (configDirty) {
      await saveConfig();
    }

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      session_id: sessionId!,
      turn_number: messages.length + 1,
      role: 'user',
      content,
      variants: '[]',
      variant_index: -1,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setStreamText('');
    streamTextRef.current = '';

    abortRef.current = api.sendMessageStream(
      sessionId!,
      content,
      (event, data) => {
        if (event === 'message_delta' && data.content) {
          setStreamText(prev => {
            const next = prev + data.content;
            streamTextRef.current = next;
            return next;
          });
        }
        if (event === 'turn_end') {
          const assistantMsg: Message = {
            id: `assistant-${Date.now()}`,
            session_id: sessionId!,
            turn_number: data.turn_number,
            role: 'assistant',
            content: data.message_content,
            variants: '[]',
            variant_index: -1,
            created_at: new Date().toISOString(),
          };
          setMessages(prev => [...prev, assistantMsg]);
          setStreamText('');
          streamTextRef.current = '';
          setStreaming(false);
          // Refresh session title after first turn (auto-generated title via background LLM call)
          if (data.turn_number === 1) {
            (async () => {
              for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                  const s = await api.getSession(sessionId!);
                  if (s.title) {
                    setSessionTitle(s.title);
                    return;
                  }
                } catch {}
              }
            })();
          }
        }
      },
      (error) => {
        console.error('Stream error:', error);
        setStreaming(false);
        setStreamText('');
      },
      () => {
        setStreaming(false);
        // Persist accumulated streamText if turn_end was never received
        if (streamTextRef.current) {
          const fallbackMsg: Message = {
            id: `assistant-${Date.now()}`,
            session_id: sessionId!,
            turn_number: messages.length + 1,
            role: 'assistant',
            content: streamTextRef.current,
            variants: '[]',
            variant_index: -1,
            created_at: new Date().toISOString(),
          };
          setMessages(prev => [...prev, fallbackMsg]);
          setStreamText('');
          streamTextRef.current = '';
        }
      },
      config.stream,
    );
  }

  async function handleRegenerate(msgId: string) {
    if (streaming || regeneratingId) return;
    setRegeneratingId(msgId);
    try {
      const result = await api.regenerateMessage(sessionId!, msgId);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: -1 } : m
      ));
    } catch (err) {
      console.error('Regenerate failed:', err);
    } finally {
      setRegeneratingId(null);
    }
  }

  async function handleSwitchVariant(msgId: string, index: number) {
    if (streaming || regeneratingId) return;
    try {
      const result = await api.switchVariant(sessionId!, msgId, index);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: result.variant_index } : m
      ));
    } catch (err) {
      console.error('Switch variant failed:', err);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function getVariants(msg: Message): string[] {
    try { return JSON.parse(msg.variants || '[]'); } catch { return []; }
  }

  function toggleRawView(msgId: string) {
    setRawViewIds(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }

  function handleCopyMsg(msgId: string, content: string) {
    navigator.clipboard.writeText(content);
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId(null), 1500);
  }

  function handleEdit(msgId: string, content: string) {
    setEditingId(msgId);
    setEditContent(content);
  }

  async function handleSaveEdit(msgId: string) {
    const content = editContent.trim();
    if (!content) return;
    try {
      const result = await api.editMessage(sessionId!, msgId, content);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: result.variant_index } : m
      ));
    } catch (err) {
      console.error('Edit failed:', err);
    }
    setEditingId(null);
    setEditContent('');
  }

  function handleCancelEdit() {
    setEditingId(null);
    setEditContent('');
  }

  async function handleDelete(msgId: string) {
    if (!confirm('确定删除这条消息？')) return;
    try {
      await api.deleteMessage(sessionId!, msgId);
      setMessages(prev => prev.filter(m => m.id !== msgId));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  function startRename() {
    setTitleInput(sessionTitle);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  async function commitRename() {
    const newTitle = titleInput.trim();
    setEditingTitle(false);
    if (newTitle && newTitle !== sessionTitle) {
      setSessionTitle(newTitle);
      try {
        await api.updateSession(sessionId!, { title: newTitle });
      } catch (err) {
        console.error('Failed to rename session:', err);
      }
    }
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <button className="back-btn" onClick={() => navigate('/')}>返回</button>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="title-edit-input"
            value={titleInput}
            onChange={e => setTitleInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingTitle(false); }}
            autoFocus
          />
        ) : (
          <h2 className="title-clickable" onClick={startRename} title="点击重命名">{sessionTitle || '未命名会话'}</h2>
        )}
        <button
          className={`config-toggle ${showConfig ? 'active' : ''}`}
          onClick={() => setShowConfig(!showConfig)}
        >
          参数
        </button>
      </div>

      {showConfig && (
        <div className="config-panel">
          <div className="config-grid">
            <div className="config-field">
              <label>上下文轮数</label>
              <input
                type="number"
                value={config.max_context_turns}
                onChange={e => updateConfig('max_context_turns', Number(e.target.value))}
                min={1} max={200}
              />
              <span className="config-hint">发送给模型的历史消息轮数</span>
            </div>

            <div className="config-field">
              <label>流式输出</label>
              <div className="toggle-row">
                <button
                  type="button"
                  className={`toggle-btn ${config.stream ? 'on' : 'off'}`}
                  onClick={() => updateConfig('stream', !config.stream)}
                >
                  {config.stream ? '开启' : '关闭'}
                </button>
              </div>
              <span className="config-hint">开启后逐字显示回复内容</span>
            </div>

            <div className="config-field">
              <label>Temperature</label>
              <input
                type="number"
                value={config.temperature}
                onChange={e => updateConfig('temperature', Number(e.target.value))}
                min={0} max={2} step={0.1}
              />
              <span className="config-hint">越高越随机，越低越确定</span>
            </div>

            <div className="config-field">
              <label>Top P</label>
              <input
                type="number"
                value={config.top_p}
                onChange={e => updateConfig('top_p', Number(e.target.value))}
                min={0} max={1} step={0.05}
              />
              <span className="config-hint">核采样，控制词汇多样性</span>
            </div>

            <div className="config-field">
              <label>最大输出 Token</label>
              <input
                type="number"
                value={config.max_tokens}
                onChange={e => updateConfig('max_tokens', Number(e.target.value))}
                min={1} max={128000}
              />
              <span className="config-hint">单次回复的最大长度</span>
            </div>

            <div className="config-field">
              <label>频率惩罚</label>
              <input
                type="number"
                value={config.frequency_penalty}
                onChange={e => updateConfig('frequency_penalty', Number(e.target.value))}
                min={-2} max={2} step={0.1}
              />
              <span className="config-hint">减少重复用词</span>
            </div>

            <div className="config-field">
              <label>存在惩罚</label>
              <input
                type="number"
                value={config.presence_penalty}
                onChange={e => updateConfig('presence_penalty', Number(e.target.value))}
                min={-2} max={2} step={0.1}
              />
              <span className="config-hint">鼓励谈论新话题</span>
            </div>
          </div>

          <div className="config-field full">
            <label>系统提示词</label>
            <textarea
              value={config.system_prompt}
              onChange={e => updateConfig('system_prompt', e.target.value)}
              placeholder="留空使用默认提示词"
              rows={4}
            />
          </div>

          <div className="config-actions">
            {configDirty && <span className="config-dirty">未保存</span>}
            <button onClick={saveConfig} disabled={!configDirty}>
              保存参数
            </button>
            <button className="reset-btn" onClick={() => { setConfig({ ...DEFAULT_SESSION_CONFIG }); setConfigDirty(true); }}>
              恢复默认
            </button>
          </div>
        </div>
      )}

      <div className="messages">
        {messages.map(msg => {
          const isRaw = rawViewIds.has(msg.id);
          const isEditing = editingId === msg.id;
          return (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="message-role">{msg.role === 'user' ? '你' : '助手'}</div>
              {isEditing ? (
                <div className="edit-area">
                  <textarea
                    className="edit-textarea"
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    rows={4}
                    autoFocus
                  />
                  <div className="edit-actions">
                    <button className="action-btn" onClick={() => handleSaveEdit(msg.id)}>保存</button>
                    <button className="action-btn" onClick={handleCancelEdit}>取消</button>
                  </div>
                </div>
              ) : (
                <div className="message-content">
                  {msg.role === 'assistant' ? (
                    isRaw ? (
                      <pre className="msg-raw">{msg.content}</pre>
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{msg.content}</ReactMarkdown>
                    )
                  ) : (
                    msg.content
                  )}
                </div>
              )}
              {!isEditing && msg.role === 'user' && (
                <div className="message-actions">
                  <button
                    className="action-btn"
                    onClick={() => handleEdit(msg.id, msg.content)}
                    title="编辑"
                  >
                    编辑
                  </button>
                  <button
                    className="action-btn delete-btn"
                    onClick={() => handleDelete(msg.id)}
                    title="删除"
                  >
                    删除
                  </button>
                </div>
              )}
              {!isEditing && msg.role === 'assistant' && (() => {
                const variants = getVariants(msg);
                const total = variants.length + 1;
                const activeIndex = msg.variant_index;
                const displayPos = activeIndex === -1 ? total : activeIndex + 1;
                return (
                  <div className="message-actions">
                    <button
                      className="action-btn"
                      onClick={() => toggleRawView(msg.id)}
                      title={isRaw ? '预览' : '源码'}
                    >
                      {isRaw ? '预览' : '源码'}
                    </button>
                    <button
                      className="action-btn"
                      onClick={() => handleCopyMsg(msg.id, msg.content)}
                      title="复制"
                    >
                      {copiedMsgId === msg.id ? '已复制' : '复制'}
                    </button>
                    <button
                      className="action-btn regenerate-btn"
                      onClick={() => handleRegenerate(msg.id)}
                      disabled={!!regeneratingId || streaming}
                      title="重新生成"
                    >
                      {regeneratingId === msg.id ? '生成中...' : '重新生成'}
                    </button>
                    <button
                      className="action-btn"
                      onClick={() => handleEdit(msg.id, msg.content)}
                      disabled={!!regeneratingId || streaming}
                      title="编辑"
                    >
                      编辑
                    </button>
                    <button
                      className="action-btn delete-btn"
                      onClick={() => handleDelete(msg.id)}
                      disabled={!!regeneratingId || streaming}
                      title="删除"
                    >
                      删除
                    </button>
                    {total > 1 && (
                      <div className="variant-nav">
                        <button
                          className="action-btn variant-btn"
                          onClick={() => handleSwitchVariant(msg.id, activeIndex === -1 ? variants.length - 1 : activeIndex - 1)}
                          disabled={activeIndex === 0 || !!regeneratingId || streaming}
                          title="上一个版本"
                        >
                          {'<'}
                        </button>
                        <span className="variant-count">{displayPos} / {total}</span>
                        <button
                          className="action-btn variant-btn"
                          onClick={() => handleSwitchVariant(msg.id, activeIndex >= variants.length - 1 ? -1 : activeIndex + 1)}
                          disabled={activeIndex === -1 || !!regeneratingId || streaming}
                          title="下一个版本"
                        >
                          {'>'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
        {streamText && (
          <div className="message assistant streaming">
            <div className="message-role">助手</div>
            <div className="message-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>{streamText}</ReactMarkdown>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          rows={3}
          disabled={streaming}
        />
        <button onClick={handleSend} disabled={streaming || !input.trim()}>
          {streaming ? '发送中...' : '发送'}
        </button>
      </div>
    </div>
  );
}
