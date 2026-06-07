// useMessageStream — message sending, SSE streaming, message operations
// Extracted from Chat.tsx GROUP 32

import { useState, useRef } from 'react';
import * as api from '../../api/client';
import type { CharacterCard, Message, SessionConfig } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import type { RenderMode } from '../../api/types';
import { hasStatusRenderer } from '../card-content';
import type { useStreamRecovery } from './useStreamRecovery';

type RecoveryApi = ReturnType<typeof useStreamRecovery>;

export type SandboxSubmissionState = {
  status: 'pending' | 'streaming' | 'finalizing' | 'error';
  sourceMessageId: string | null;
  userMessage: string;
  assistantMessage: string;
  error: string | null;
  updatedAt: number;
};

export function useMessageStream({
  sessionId,
  messages,
  setMessages,
  config,
  configDirty,
  characterCard,
  selectedGreetingIndex,
  setSelectedGreetingIndex,
  saveConfig,
  loadMessages,
  loadSessionState,
  // from useStreamRecovery
  recovering,
  failedContent,
  setFailedContent,
  memoryPending,
  setMemoryBusy,
  agentStatuses,
  setAgentStatuses,
  streamText,
  setStreamText,
  streamError,
  setStreamError,
  setPending,
  clearPending,
  startRecovery,
  stopRecovery,
  recoveringRef,
  streamHadErrorRef,
  streamTextRef,
  memoryPendingRef,
  streamingRef,
}: {
  sessionId: string | undefined;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  config: SessionConfig;
  configDirty: boolean;
  characterCard: CharacterCard | null;
  selectedGreetingIndex: number;
  setSelectedGreetingIndex: (value: React.SetStateAction<number>) => void;
  saveConfig: () => Promise<void>;
  loadMessages: () => Promise<Message[] | undefined>;
  loadSessionState: () => Promise<void>;
  recovering: boolean;
  failedContent: string | null;
  setFailedContent: (value: string | null) => void;
  memoryPending: boolean;
  setMemoryBusy: (value: boolean) => void;
  agentStatuses: Array<{ agent_type: string; label: string; status: string }>;
  setAgentStatuses: React.Dispatch<React.SetStateAction<Array<{ agent_type: string; label: string; status: string }>>>;
  streamText: string;
  setStreamText: React.Dispatch<React.SetStateAction<string>>;
  streamError: string | null;
  setStreamError: (value: string | null) => void;
  setPending: (turnNumber: number) => void;
  clearPending: () => void;
  startRecovery: (initialMsgCount: number) => Promise<void>;
  stopRecovery: () => void;
  recoveringRef: React.MutableRefObject<boolean>;
  streamHadErrorRef: React.MutableRefObject<boolean>;
  streamTextRef: React.MutableRefObject<string>;
  memoryPendingRef: React.MutableRefObject<boolean>;
  streamingRef: React.MutableRefObject<boolean>;
}) {
  // --- local state ---
  const [streaming, setStreaming] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [regenerateErrors, setRegenerateErrors] = useState<Record<string, string>>({});
  const [rawViewIds, setRawViewIds] = useState<Set<string>>(new Set());
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [input, setInput] = useState('');
  const [sandboxActionLog, setSandboxActionLog] = useState<Array<{ time: number; action: string; payload: any }>>([]);
  const [sandboxSubmission, setSandboxSubmission] = useState<SandboxSubmissionState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sandboxDraftRef = useRef('');
  const sandboxSubmitRef = useRef<{ content: string; time: number } | null>(null);

  // --- derived ---
  const inputLocked = streaming || recovering || memoryPending;

  // --- greeting helpers ---

  function selectedGreetingText(): string {
    if (!characterCard) return '';
    if (selectedGreetingIndex >= 0) {
      return characterCard.alternate_greetings[selectedGreetingIndex] || '';
    }
    return characterCard.first_mes || '';
  }

  function greetingLabel(text: string, fallback: string): string {
    const boldTitle = text.match(/\*\*([^*]+)\*\*/)?.[1];
    if (boldTitle) return boldTitle;
    const triggerLine = text.split(/\r?\n/).map(line => line.trim()).find(line =>
      /^【[^】]{1,40}】$/.test(line)
    );
    if (triggerLine) return triggerLine;
    const cleaned = text
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/<inner>[\s\S]*?<\/inner>/gi, '')
      .trim();
    const titleLine = cleaned.split(/\r?\n/).map(line => line.trim()).find(line =>
      line
        && !line.startsWith('<')
        && !line.startsWith('{{')
        && !line.startsWith('（')
        && line.length <= 64
        && /(?:开场|方向|GameStart|卷首|地志|轮盘)/i.test(line)
    );
    if (titleLine) return shortText(titleLine, 42);
    const dialogueLine = cleaned.match(/【([^】]{1,24})】\s*[：:]/)?.[1];
    if (dialogueLine) return `${fallback} · ${dialogueLine}`;
    const settingLine = cleaned.split(/\r?\n/).map(line => line.trim()).find(line =>
      line && !line.startsWith('<') && !line.startsWith('{{') && line.length <= 42
    );
    if (settingLine) return shortText(settingLine, 42);
    const firstLine = cleaned.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    return firstLine ? shortText(firstLine, 42) : fallback;
  }

  function shortText(value: string, max = 180): string {
    const text = value.trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
  }

  // --- send / stream ---

  async function handleSend(overrideContent?: string, options?: { sandboxSourceMessageId?: string | null }) {
    const content = overrideContent ?? input.trim();
    if (!content || streaming || recovering || memoryPending || !sessionId) return;
    const sandboxSourceMessageId = options?.sandboxSourceMessageId || null;
    sandboxDraftRef.current = '';
    setFailedContent(null);
    setStreamError(null);
    streamHadErrorRef.current = false;
    setMemoryBusy(false);
    if (sandboxSourceMessageId) {
      setSandboxSubmission({
        status: 'pending',
        sourceMessageId: sandboxSourceMessageId,
        userMessage: content,
        assistantMessage: '',
        error: null,
        updatedAt: Date.now(),
      });
    } else {
      setSandboxSubmission(null);
    }

    if (configDirty) {
      await saveConfig();
    }

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      session_id: sessionId,
      turn_number: messages.length + 1,
      role: 'user',
      content,
      variants: '[]',
      variant_index: -1,
      created_at: new Date().toISOString(),
    };
    if (!sandboxSourceMessageId) {
      setMessages(prev => [...prev, userMsg]);
    }
    setInput('');
    setStreaming(true);
    streamingRef.current = true;
    setStreamText('');
    streamTextRef.current = '';
    stopRecovery();
    setPending(messages.length + 1);

    abortRef.current = api.sendMessageStream(
      sessionId,
      content,
      message => {
        switch (message.event) {
          case 'agent_status':
            if (message.data.status === 'working') {
              setAgentStatuses(prev => [...prev.filter(s => s.agent_type !== message.data.agent_type), message.data]);
            } else {
              setAgentStatuses(prev => prev.filter(s => s.agent_type !== message.data.agent_type));
            }
            break;
          case 'message_delta':
            if (message.data.content) {
              setAgentStatuses([]);
              setStreamError(null);
              streamHadErrorRef.current = false;
              setStreamText(prev => {
                const next = prev + message.data.content;
                streamTextRef.current = next;
                if (sandboxSourceMessageId) {
                  setSandboxSubmission(current => current?.sourceMessageId === sandboxSourceMessageId
                    ? { ...current, status: 'streaming', assistantMessage: next, error: null, updatedAt: Date.now() }
                    : current);
                }
                return next;
              });
            }
            break;
          case 'stream_error':
            streamHadErrorRef.current = true;
            setStreamError(message.data.error || '生成出现错误，正在重试...');
            if (sandboxSourceMessageId) {
              setSandboxSubmission(current => current?.sourceMessageId === sandboxSourceMessageId
                ? { ...current, status: 'error', error: message.data.error || '生成出现错误，正在重试...', updatedAt: Date.now() }
                : current);
            }
            break;
          case 'state_update':
            break;
          case 'memory_start':
            setMemoryBusy(true);
            break;
          case 'memory_error':
            setStreamError(message.data.error || '记忆整理失败，已允许继续');
            break;
          case 'turn_end': {
            if (streamHadErrorRef.current) return;
            setAgentStatuses([]);
            setStreamError(null);
            const messageContent = message.data.message_content || streamTextRef.current;
            const assistantMsg: Message = {
              id: `assistant-${Date.now()}`,
              session_id: sessionId,
              turn_number: message.data.turn_number,
              role: 'assistant',
              content: messageContent,
              variants: '[]',
              variant_index: -1,
              created_at: new Date().toISOString(),
            };
            if (!sandboxSourceMessageId) {
              setMessages(prev => [...prev, assistantMsg]);
            }
            if (sandboxSourceMessageId) {
              setSandboxSubmission(current => current?.sourceMessageId === sandboxSourceMessageId
                ? { ...current, status: 'finalizing', assistantMessage: messageContent, error: null, updatedAt: Date.now() }
                : current);
            }
            setStreamText('');
            streamTextRef.current = '';
            setMemoryBusy(true);
            void loadMessages();
            break;
          }
          case 'turn_ready':
            setAgentStatuses([]);
            setMemoryBusy(false);
            setStreaming(false);
            streamingRef.current = false;
            clearPending();
            void loadMessages().then(() => {
              setSandboxSubmission(null);
            });
            loadSessionState();
            break;
        }
      },
      (error) => {
        console.error('Stream error:', error);
        setStreaming(false);
        streamingRef.current = false;
        setMemoryBusy(false);
        setStreamText('');
        setAgentStatuses([]);
        clearPending();
        setFailedContent(content);
        if (sandboxSourceMessageId) {
          setSandboxSubmission(current => current?.sourceMessageId === sandboxSourceMessageId
            ? { ...current, status: 'error', error: error.message || '发送失败', updatedAt: Date.now() }
            : current);
        }
      },
      () => {
        // Safety net: always clear streaming state
        const wasStreaming = streamingRef.current;
        streamingRef.current = false;
        setStreaming(false);
        setMemoryBusy(false);
        setAgentStatuses([]);

        if (wasStreaming) {
          clearPending();
        }

        if (streamHadErrorRef.current) {
          setFailedContent(content);
          setStreamText('');
          streamTextRef.current = '';
          streamHadErrorRef.current = false;
          return;
        }

        if (streamTextRef.current) {
          void loadMessages();
          setStreamText('');
          streamTextRef.current = '';
        }
        if (!streamHadErrorRef.current && sandboxSourceMessageId) {
          setSandboxSubmission(null);
        }
      },
      config.stream,
    );
  }

  // --- greeting / opening ---

  async function handleApplyGreeting(canApplyOpening: boolean) {
    if (!canApplyOpening) {
      setStreamError('对话开始后不能切换开场白');
      return;
    }
    const greeting = selectedGreetingText();
    await applyOpeningContent(greeting, '应用开场白失败', canApplyOpening);
  }

  async function applyOpeningContent(greeting: string, errorMessage: string, canApplyOpening: boolean) {
    const cardHasStatus = hasStatusRenderer(characterCard);
    const content = cardHasStatus && !greeting.includes('<StatusPlaceHolderImpl/>')
      ? `${greeting.trim()}\n\n<StatusPlaceHolderImpl/>`
      : greeting;
    if (!content || inputLocked || !sessionId || !canApplyOpening) return;
    try {
      const opening = await api.applyOpeningMessage(sessionId, content);
      setMessages(prev => {
        const withoutOpening = prev.filter(msg => !(msg.turn_number === 0 && msg.role === 'assistant'));
        return [opening, ...withoutOpening].sort((a, b) => {
          if (a.turn_number !== b.turn_number) return a.turn_number - b.turn_number;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
      });
      loadSessionState();
      setStreamError(null);
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : errorMessage);
    }
  }

  async function applyOpeningSwipe(swipeId: number, canApplyOpening: boolean) {
    if (!characterCard) return;
    if (!canApplyOpening) {
      setStreamError('对话开始后不能切换开场白');
      return;
    }
    const index = swipeId - 1;
    const greeting = index >= 0
      ? characterCard.alternate_greetings[index]
      : characterCard.first_mes;
    if (!greeting) {
      setStreamError(`找不到开场白 swipe ${swipeId}`);
      return;
    }
    setSelectedGreetingIndex(index);
    await applyOpeningContent(greeting, '切换开场白失败', canApplyOpening);
  }

  // --- sandbox action routing ---

  function sendFromSandbox(content: string, sourceMessageId?: string | number | null) {
    const text = content.trim();
    if (!text) return;
    const now = Date.now();
    const last = sandboxSubmitRef.current;
    if (last && last.content === text && now - last.time < 1200) return;
    sandboxSubmitRef.current = { content: text, time: now };
    handleSend(text, { sandboxSourceMessageId: sourceMessageId == null ? null : String(sourceMessageId) });
  }

  function handleSandboxAction(event: SandboxCardAction, canApplyOpening: boolean, setShowVariableDebug?: (value: boolean) => void) {
    setSandboxActionLog(prev => [{ time: Date.now(), action: event.action, payload: event.payload }, ...prev].slice(0, 80));
    if (event.action === 'diagnostic' || event.action === 'sandboxResize' || event.action === 'runtimeError' || event.action === 'missingApi') {
      return;
    }
    if (event.action === 'openStatusPanel') {
      setShowVariableDebug?.(true);
      return;
    }
    if (event.action === 'applyGreeting') {
      const index = Number(event.payload?.index);
      if (Number.isInteger(index)) {
        setSelectedGreetingIndex(index);
      }
      return;
    }
    if (event.action === 'applyOpeningSwipe') {
      const swipeId = Number(event.payload?.swipeId);
      if (Number.isInteger(swipeId)) {
        applyOpeningSwipe(swipeId, canApplyOpening);
      }
      return;
    }
    if (event.action === 'submitText') {
      sendFromSandbox(String(event.payload?.message || ''), event.payload?.sourceMessageId);
      return;
    }
    if (event.action === 'submitFreeStart' || event.action === 'formSubmit') {
      const values = event.payload && typeof event.payload === 'object'
        ? Object.entries(event.payload)
            .filter(([, value]) => String(value ?? '').trim())
            .map(([key, value]) => `${key}: ${String(value).trim()}`)
        : [];
      if (values.length > 0) {
        sendFromSandbox(values.join('\n'), event.payload?.sourceMessageId);
      }
      return;
    }
    if (event.action === 'setChatMessage') {
      const message = String(event.payload?.message || '').trim();
      const swipeId = Number(event.payload?.swipeId);
      if (Number.isInteger(swipeId)) {
        applyOpeningSwipe(swipeId, canApplyOpening);
        return;
      }
      if (message) {
        sandboxDraftRef.current = message;
        setInput(message);
      }
      return;
    }
    if (event.action === 'triggerSlash') {
      const command = String(event.payload?.command || '').trim();
      const sendMatch = command.match(/^\/?(?:send|继续书写)\s+([\s\S]+)$/i);
      if (sendMatch?.[1]?.trim()) {
        sendFromSandbox(sendMatch[1].trim(), event.payload?.sourceMessageId);
        return;
      }
      const draft = sandboxDraftRef.current.trim() || input.trim();
      if (command && draft) {
        sendFromSandbox(draft, event.payload?.sourceMessageId);
        return;
      }
      console.debug('Card sandbox slash command:', event.payload);
      return;
    }
    if (event.action === 'uiClick') {
      console.debug('Card sandbox click:', event.payload);
    }
  }

  // --- message operations ---

  async function handleRetry() {
    if (!failedContent || streaming || memoryPending || !sessionId) return;
    setMessages(prev => {
      const idx = [...prev].reverse().findIndex(m => m.role === 'user' && m.content === failedContent);
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      return prev.filter((_, i) => i !== realIdx);
    });
    setInput('');
    handleSend(failedContent);
  }

  async function handleRegenerate(msgId: string) {
    if (streaming || memoryPending || regeneratingId || !sessionId) return;
    setRegeneratingId(msgId);
    setRegenerateErrors(prev => {
      const next = { ...prev };
      delete next[msgId];
      return next;
    });
    try {
      const result = await api.regenerateMessage(sessionId, msgId);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: -1 } : m
      ));
    } catch (err) {
      console.error('Regenerate failed:', err);
      setRegenerateErrors(prev => ({
        ...prev,
        [msgId]: err instanceof Error ? err.message : '重新生成失败',
      }));
    } finally {
      setRegeneratingId(null);
    }
  }

  async function handleSwitchVariant(msgId: string, index: number) {
    if (streaming || memoryPending || regeneratingId || !sessionId) return;
    try {
      const result = await api.switchVariant(sessionId, msgId, index);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: result.content, variants: result.variants, variant_index: result.variant_index } : m
      ));
    } catch (err) {
      console.error('Switch variant failed:', err);
    }
  }

  // --- editing ---

  function handleEdit(msgId: string, content: string) {
    setEditingId(msgId);
    setEditContent(content);
  }

  async function handleSaveEdit(msgId: string) {
    const content = editContent.trim();
    if (!content || !sessionId) return;
    try {
      const result = await api.editMessage(sessionId, msgId, content);
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
    if (!confirm('确定删除这条消息？') || !sessionId) return;
    try {
      await api.deleteMessage(sessionId, msgId);
      setMessages(prev => prev.filter(m => m.id !== msgId));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  // --- misc UI ---

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

  return {
    // state
    streaming,
    input,
    setInput,
    regeneratingId,
    regenerateErrors,
    rawViewIds,
    copiedMsgId,
    editingId,
    editContent,
    setEditContent,
    sandboxActionLog,
    sandboxSubmission,
    inputLocked,
    // actions
    handleSend,
    handleKeyDown,
    handleApplyGreeting,
    applyOpeningSwipe,
    handleSandboxAction,
    handleRetry,
    handleRegenerate,
    handleSwitchVariant,
    handleEdit,
    handleSaveEdit,
    handleCancelEdit,
    handleDelete,
    getVariants,
    toggleRawView,
    handleCopyMsg,
    selectedGreetingText,
    greetingLabel,
  };
}
