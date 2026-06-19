import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../api/client';
import type { ChatSseMessage } from '../api/sse';
import type { CharacterCard, Message, Session, SessionRuntimeAssets, StHostRenderPayload, WorldBook } from '../api/types';
import { ChatSurfaceIframe } from './st-runtime/ChatSurfaceIframe';
import { createStRuntimeStore } from './st-runtime/store';
import { installStGlobals, uninstallStGlobals } from './st-runtime/globals';
import { normalizeTavernHelperScripts } from './st-runtime/tavern-helper-scripts';
import '../styles/chat.css';
import '../styles/st-host.css';

const EMPTY_RUNTIME_ASSETS: SessionRuntimeAssets = {
  regex_scripts: [],
  tavern_helper_scripts: [],
};

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((first, second) => {
    if (first.turn_number !== second.turn_number) {
      return first.turn_number - second.turn_number;
    }
    return new Date(first.created_at).getTime() - new Date(second.created_at).getTime();
  });
}

function parsedGreetings(card: CharacterCard | null): string[] {
  if (!card) return [];
  return [card.first_mes, ...(card.alternate_greetings ?? [])].filter(
    item => typeof item === 'string' && item.trim().length > 0,
  );
}

function resolveOpeningIndex(card: CharacterCard | null, messages: Message[]): number {
  const greetings = parsedGreetings(card);
  if (greetings.length === 0) return 0;
  const opening = messages.find(message => message.turn_number === 0 && message.role === 'assistant');
  if (!opening) return 0;
  const index = greetings.findIndex(item => item.trim() === opening.content.trim());
  return index >= 0 ? index : 0;
}

function messageFingerprint(messages: Message[]): string {
  return messages.map(message => `${message.id}:${message.variant_index}:${message.content.length}`).join('|');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch);
}

// One chat-surface message as HTML. Mirrors the old .st-host-message article, but
// uses the cx-* classes defined inside ChatSurfaceIframe's srcdoc stylesheet.
// `bodyHtml` for assistant messages is already HTML (backend-rendered card markup);
// for user messages it is an escaped cx-plain box.
function messageHtml(name: string, bodyHtml: string, isUser: boolean): string {
  const cls = isUser ? 'cx-msg cx-msg-user' : 'cx-msg cx-msg-assistant';
  return `<div class="${cls}"><div class="cx-msg-role">${escapeHtml(name)}</div><div class="cx-msg-body">${bodyHtml}</div></div>`;
}

export default function StHost() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const storeRef = useRef(createStRuntimeStore());
  const streamAbortRef = useRef<AbortController | null>(null);
  // Tracks the sessionId we've already attempted to reconnect for, so a remount
  // (navigate away and back) reattempts exactly once but a normal post-turn
  // reload does not spuriously reattach.
  const reconnectSessionRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [worldBooks, setWorldBooks] = useState<WorldBook[]>([]);
  const [characterCard, setCharacterCard] = useState<CharacterCard | null>(null);
  const [runtimeAssets, setRuntimeAssets] = useState<SessionRuntimeAssets>(EMPTY_RUNTIME_ASSETS);
  const [renderPayload, setRenderPayload] = useState<StHostRenderPayload | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [openingIndex, setOpeningIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [input, setInput] = useState('');
  const [collapseThreshold, setCollapseThreshold] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);

  const greetings = useMemo(() => {
    if (renderPayload) {
      return [renderPayload.first_message, ...(renderPayload.greetings || [])].filter(
        item => typeof item === 'string' && item.trim().length > 0,
      );
    }
    return parsedGreetings(characterCard);
  }, [characterCard, renderPayload]);
  const renderedGreetings = useMemo(
    () => renderPayload ? [renderPayload.rendered_html, ...(renderPayload.rendered_greetings || [])] : [],
    [renderPayload],
  );
  const renderedMessageById = useMemo(
    () => new Map((renderPayload?.messages || []).map(message => [message.id, message.rendered_html])),
    [renderPayload],
  );
  const sortedMessages = useMemo(() => sortMessages(messages), [messages]);
  const userName = session?.config?.user_persona?.name?.trim() || '你';
  const activeWorldBookId = session?.world_pack_id || '';
  const runtimeAssetHostScripts = useMemo(
    () => normalizeTavernHelperScripts(runtimeAssets.tavern_helper_scripts),
    [runtimeAssets],
  );
  const hasStarted = sortedMessages.some(message => message.turn_number > 0);
  const canApplyOpening = Boolean(characterCard && !hasStarted);
  const openingContent = greetings[openingIndex] || greetings[0] || '';
  const openingRenderedHtml = renderedGreetings[openingIndex] || renderedGreetings[0] || '';
  const showOpeningPreview = Boolean(characterCard && !hasStarted && openingContent && openingRenderedHtml);
  const displayMessages = useMemo(
    () => hasStarted
      ? sortedMessages
      : sortedMessages.filter(message => !(message.turn_number === 0 && message.role === 'assistant')),
    [hasStarted, sortedMessages],
  );
  const messagesHtml = useMemo(() => {
    if (!characterCard) return '';
    if (showOpeningPreview) {
      return messageHtml(characterCard.name, openingRenderedHtml, false);
    }
    return displayMessages.map(message => {
      const isUser = message.role === 'user';
      const name = isUser ? userName : (characterCard.name || 'assistant');
      const rendered = isUser ? '' : (renderedMessageById.get(message.id) || '');
      const body = isUser || !rendered
        ? `<div class="cx-plain">${escapeHtml(message.content)}</div>`
        : rendered;
      return messageHtml(name, body, isUser);
    }).join('');
  }, [characterCard, showOpeningPreview, openingRenderedHtml, displayMessages, renderedMessageById, userName]);
  const streamingHtml = useMemo(() => {
    if (!streaming || !streamText || !characterCard) return null;
    return messageHtml(characterCard.name, `<div class="cx-plain">${escapeHtml(streamText)}</div>`, false);
  }, [streaming, streamText, characterCard]);

  const refreshRuntimeStore = useCallback(async (
    card: CharacterCard | null,
    assets: SessionRuntimeAssets,
  ) => {
    if (!sessionId || !card) {
      uninstallStGlobals();
      setRuntimeReady(false);
      return;
    }

    await storeRef.current.load(sessionId, card, assets);
    installStGlobals(storeRef.current);
    setRuntimeReady(true);
  }, [sessionId]);

  const loadAll = useCallback(async (showSpinner = false) => {
    if (!sessionId) return;
    if (showSpinner) setLoading(true);
    setError(null);

    try {
      const sessionData = await api.getSession(sessionId);
      const [
        worldBookData,
        messageData,
        runtimeAssetData,
        cardData,
        renderData,
      ] = await Promise.all([
        api.listWorldBooks().catch(errorValue => {
          console.error('[StHost] failed to load worldbooks:', errorValue);
          return { items: [] };
        }),
        api.listMessages(sessionId).catch(errorValue => {
          console.error('[StHost] failed to load messages:', errorValue);
          return { items: [] };
        }),
        api.getSessionRuntimeAssets(sessionId).catch(errorValue => {
          console.error('[StHost] failed to load runtime assets:', errorValue);
          return EMPTY_RUNTIME_ASSETS;
        }),
        sessionData.world_pack_id
          ? api.getWorldBookCharacterCard(sessionData.world_pack_id).catch(errorValue => {
            console.warn('[StHost] no character card for worldbook:', errorValue);
            return null;
          })
          : Promise.resolve(null),
        sessionData.world_pack_id
          ? api.getSessionStHostRender(sessionId).catch(errorValue => {
            console.warn('[StHost] failed to load backend rendered HTML:', errorValue);
            return null;
          })
          : Promise.resolve(null),
      ]);

      const nextMessages = sortMessages(messageData.items || []);
      const nextAssets = {
        regex_scripts: Array.isArray(runtimeAssetData.regex_scripts) ? runtimeAssetData.regex_scripts : [],
        tavern_helper_scripts: Array.isArray(runtimeAssetData.tavern_helper_scripts) ? runtimeAssetData.tavern_helper_scripts : [],
      };

      setSession(sessionData);
      setWorldBooks(worldBookData.items || []);
      setMessages(nextMessages);
      setRuntimeAssets(nextAssets);
      setCharacterCard(cardData);
      setRenderPayload(renderData);
      setOpeningIndex(resolveOpeningIndex(cardData, nextMessages));

      if (cardData) {
        await refreshRuntimeStore(cardData, nextAssets);
      } else {
        uninstallStGlobals();
        setRuntimeReady(false);
      }
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [refreshRuntimeStore, sessionId]);

  useEffect(() => {
    void loadAll(true);
  }, [loadAll]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      storeRef.current.dispose();
      uninstallStGlobals();
    };
  }, []);

  // Shared SSE handlers for both a fresh send and a reconnect — same event shapes.
  const handleStreamMessage = useCallback((message: ChatSseMessage) => {
    if (message.event === 'message_delta') {
      setStreamText(current => current + message.data.content);
    } else if (message.event === 'turn_end') {
      setStreamText(message.data.message_content);
    } else if (message.event === 'stream_error') {
      setError(message.data.error);
    } else if (message.event === 'turn_ready') {
      void loadAll(false);
    }
  }, [loadAll]);

  const finishTurn = useCallback((options: { clearInput?: boolean } = {}) => {
    if (options.clearInput) setInput('');
    setStreaming(false);
    setStreamText('');
    // Reload chat variables after the turn: the variable tool agent writes
    // canonical state (the MVU variable tree) into session_variables during
    // the turn, and card UI / MVU read it via store.chatVariables. Without
    // this reload, variable updates never reach the rendered UI.
    void loadAll(false).then(() => {
      void storeRef.current?.reloadChatVariables();
    });
  }, [loadAll]);

  const startReconnect = useCallback(() => {
    if (!sessionId) return;
    setStreamText('');
    setError(null);
    streamAbortRef.current = api.reconnectStream(sessionId, {
      onActive: () => setStreaming(true),
      onMessage: handleStreamMessage,
      onError: errorValue => {
        setError(errorValue.message);
        setStreaming(false);
      },
      onDone: () => finishTurn(),
    });
  }, [sessionId, handleStreamMessage, finishTurn]);

  // On mount / return-from-another-page: if the session is mid-generation,
  // reattach to its running stream so the UI keeps showing "running". Runs at
  // most once per session per mount (a normal post-turn reload sees status=idle
  // and is a no-op).
  useEffect(() => {
    if (!sessionId || !session) return;
    if (reconnectSessionRef.current === sessionId) return;
    reconnectSessionRef.current = sessionId;
    if (session.status === 'processing' && !streaming) {
      startReconnect();
    }
  }, [sessionId, session, streaming, startReconnect]);

  useEffect(() => {
    if (!runtimeReady || !characterCard) return;
    void refreshRuntimeStore(characterCard, runtimeAssets);
  }, [messageFingerprint(sortedMessages), runtimeReady, characterCard?.id, runtimeAssets, refreshRuntimeStore]);

  async function applyOpening(index: number) {
    if (!sessionId || !characterCard || !canApplyOpening) return;
    const content = greetings[index] || greetings[0] || '';
    if (!content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.applyOpeningMessage(sessionId, content);
      await loadAll(false);
      await storeRef.current.reloadChatVariables();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '应用开场失败');
    } finally {
      setSaving(false);
    }
  }

  async function changeOpening(delta: number) {
    if (greetings.length <= 1) return;
    const next = (openingIndex + delta + greetings.length) % greetings.length;
    setOpeningIndex(next);
  }

  async function selectWorldBook(worldBookId: string) {
    if (!sessionId || !worldBookId || worldBookId === activeWorldBookId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateSession(sessionId, { world_pack_id: worldBookId });
      setSession(updated);
      setCharacterCard(null);
      setRuntimeAssets(EMPTY_RUNTIME_ASSETS);
      setRenderPayload(null);
      setMessages([]);
      setOpeningIndex(0);
      setRuntimeReady(false);
      uninstallStGlobals();
      await loadAll(false);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '切换世界书失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleImportFile(file: File) {
    if (!sessionId || importing) return;
    setImporting(true);
    setError(null);
    try {
      const draft = await api.importCharacterCardFile(file);
      const confirmed = await api.confirmCharacterCardImport(draft.import_id);
      await api.updateSession(sessionId, { world_pack_id: confirmed.world_pack_id });
      await loadAll(false);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '导入失败');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleSend(event?: React.FormEvent) {
    event?.preventDefault();
    if (!sessionId || streaming) return;
    const content = input.trim();
    if (!content) return;

    setStreaming(true);
    setStreamText('');
    setError(null);

    try {
      if (showOpeningPreview && openingContent.trim()) {
        await api.applyOpeningMessage(sessionId, openingContent);
      }

      streamAbortRef.current = api.sendMessageStream(
        sessionId,
        content,
        handleStreamMessage,
        errorValue => {
          setError(errorValue.message);
          setStreaming(false);
        },
        () => finishTurn({ clearInput: true }),
        session?.config?.stream ?? true,
      );
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : '发送失败');
      setStreaming(false);
    }
  }

  if (loading) {
    return <div className="st-host-loading">正在加载 ST Host...</div>;
  }

  return (
    <div className="st-host-page">
      <header className="st-host-header">
        <div className="st-host-brand">
          <h1 title={characterCard?.name || session?.title || 'Conclave'}>
            {characterCard?.name || session?.title || 'Conclave'}
          </h1>
          <span className="st-host-badge">ST Host</span>
        </div>
        <div className="st-host-actions">
          <button type="button" onClick={() => navigate(`/chat/${sessionId}`)}>
            返回聊天
          </button>
          <button type="button" onClick={() => void loadAll(true)} disabled={saving || importing}>
            重新加载
          </button>
          <label className={importing ? 'is-disabled' : ''}>
            导入 JSON/PNG
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.png,application/json,image/png"
              disabled={importing}
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                if (file) void handleImportFile(file);
              }}
            />
          </label>
        </div>
      </header>

      <div className="st-host-workspace">
        <aside className="st-host-sidebar">
          <div className="st-host-sidebar-title">已导入世界书</div>
          <div className="st-host-worldbook-list">
            {worldBooks.length === 0 ? (
              <div className="st-host-empty">尚未导入世界书</div>
            ) : (
              worldBooks.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`st-host-worldbook${item.id === activeWorldBookId ? ' is-active' : ''}`}
                  disabled={saving || importing}
                  onClick={() => void selectWorldBook(item.id)}
                >
                  <span>{item.character_card_name || item.name}</span>
                  <small>{item.entry_count} 条 · {item.id === activeWorldBookId ? '当前' : '可切换'}</small>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="st-host-render-pane">
          <div className="st-host-chat-surface">
            {!characterCard ? (
              <div className="st-host-empty-state">
                当前会话没有绑定可渲染的角色卡。请从左侧切换世界书，或导入 JSON/PNG。
              </div>
            ) : !runtimeReady ? (
              <div className="st-host-empty-state">正在初始化渲染运行时…</div>
            ) : (
              <ChatSurfaceIframe
                cardKey={`${sessionId}:${characterCard.id}:${runtimeAssetHostScripts.length}`}
                messagesHtml={messagesHtml}
                tavernHelperScripts={runtimeAssetHostScripts}
                streamingHtml={streamingHtml}
                collapseThreshold={collapseThreshold}
              />
            )}
          </div>

          {error && <div className="st-host-error">{error}</div>}

          {greetings.length > 1 && canApplyOpening && (
            <div className="st-host-opening-controls">
              <button type="button" onClick={() => void changeOpening(-1)} disabled={saving || streaming}>
                上一条
              </button>
              <span>{openingIndex + 1} / {greetings.length}</span>
              <button type="button" onClick={() => void changeOpening(1)} disabled={saving || streaming}>
                下一条
              </button>
              <button type="button" onClick={() => void applyOpening(openingIndex)} disabled={saving || streaming}>
                应用开场
              </button>
            </div>
          )}

          <form className="st-host-input" onSubmit={event => void handleSend(event)}>
            <textarea
              value={input}
              placeholder="输入消息... (Enter 发送)"
              rows={1}
              disabled={streaming || !characterCard}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button type="submit" disabled={streaming || !input.trim() || !characterCard}>
              {streaming ? '发送中' : '发送'}
            </button>
          </form>

          <div className="st-host-collapse-control">
            <label htmlFor="st-host-collapse-input">保留最近轮数（更早折叠）</label>
            <input
              id="st-host-collapse-input"
              type="number"
              min={0}
              step={1}
              value={collapseThreshold}
              onChange={event => {
                const value = Number(event.target.value);
                setCollapseThreshold(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
              }}
            />
            <span className="st-host-collapse-hint">0 = 不折叠</span>
          </div>
        </main>
      </div>
    </div>
  );
}
