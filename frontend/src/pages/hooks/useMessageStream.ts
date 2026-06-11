// useMessageStream — message sending, SSE streaming, message operations
// Extracted from Chat.tsx GROUP 32

import { useState, useRef } from 'react';
import * as api from '../../api/client';
import type { CharacterCard, Message, SessionConfig } from '../../api/types';
import type { SandboxCardAction } from '../card-schema-types';
import type { RenderMode } from '../../api/types';
import type { useStreamRecovery } from './useStreamRecovery';

import { cleanCardDisplayText } from '../card-content';

function hasStatusRenderer(card: CharacterCard | null): boolean {
  const extensions = card?.extensions as Record<string, any> | undefined;
  return typeof extensions?.status_replace_string === 'string' && Boolean(extensions.status_replace_string.trim());
}

function cleanComparableMessageText(content: string): string {
  return cleanCardDisplayText(content)
    .replace(/\s+/g, '')
    .trim();
}

  function getParsedGreetings(card: CharacterCard | null): string[] {
    if (!card) return [];
    return [card.first_mes, ...(card.alternate_greetings ?? [])];
  }

type RecoveryApi = ReturnType<typeof useStreamRecovery>;

export type SandboxSubmissionState = {
  status: 'pending' | 'streaming' | 'finalizing' | 'error';
  sourceMessageId: string | null;
  generationId: string | null;
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
    const greetings = getParsedGreetings(characterCard);
    return greetings[selectedGreetingIndex + 1] || greetings[0] || '';
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

  function isHtmlAppCard(): boolean {
    return characterCard?.conclave_package?.ui?.type === 'html_app'
      && Boolean(String(characterCard.conclave_package?.ui?.html || '').trim());
  }

  function hasHtmlAppTrigger(content: string): boolean {
    return /(?:^|\n)\s*(?:\[attachment\]|\[开局\]|【GameStart】|【游戏开始】)\s*(?:\n|$)/i.test(content);
  }

  function prepareOpeningContent(greeting: string): string {
    let content = greeting.trim();
    if (isHtmlAppCard() && content && !hasHtmlAppTrigger(content)) {
      content = `[attachment]\n${content}`;
    }
    const cardHasStatus = hasStatusRenderer(characterCard);
    if (cardHasStatus && !content.includes('<StatusPlaceHolderImpl/>')) {
      content = `${content.trim()}\n\n<StatusPlaceHolderImpl/>`;
    }
    return content;
  }

  async function ensureOpeningMessageBeforeFirstTurn() {
    if (!sessionId || !characterCard) return;
    const hasOpening = messages.some(msg => msg.turn_number === 0 && msg.role === 'assistant');
    const hasStarted = messages.some(msg => msg.turn_number > 0);
    if (hasOpening || hasStarted) return;
    const opening = prepareOpeningContent(selectedGreetingText());
    if (!opening) return;
    try {
      const saved = await api.applyOpeningMessage(sessionId, opening);
      setMessages(prev => {
        if (prev.some(msg => msg.turn_number === 0 && msg.role === 'assistant')) return prev;
        return [saved, ...prev].sort((a, b) => {
          if (a.turn_number !== b.turn_number) return a.turn_number - b.turn_number;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
      });
    } catch (err) {
      console.warn('Failed to auto-apply opening before first turn:', err);
    }
  }

  // --- send / stream ---

  function makeGenerationId(prefix = 'main-chat'): string {
    const random = Math.random().toString(36).slice(2);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function refreshPersistedMessages(delays = [0, 800, 2500]) {
    delays.forEach(delay => {
      window.setTimeout(() => {
        void loadMessages();
      }, delay);
    });
  }

  async function handleSend(overrideContent?: string, options?: { sandboxSourceMessageId?: string | null; generationId?: string | null }) {
    const content = overrideContent ?? input.trim();
    const sandboxSourceMessageId = options?.sandboxSourceMessageId || null;
    const generationId = options?.generationId || (sandboxSourceMessageId ? makeGenerationId('card-gen') : makeGenerationId('main-chat'));
    const isHtmlAppInternalTurn = Boolean(sandboxSourceMessageId);
    const turnMetadata = isHtmlAppInternalTurn
      ? {
          html_app_internal: true,
          source: 'html_app',
          sourceMessageId: sandboxSourceMessageId,
          generationId,
        }
      : undefined;
    if (!content || streaming || recovering || memoryPending || !sessionId) {
      if (sandboxSourceMessageId || generationId) {
        setSandboxSubmission({
          status: 'error',
          sourceMessageId: sandboxSourceMessageId,
          generationId,
          userMessage: content,
          assistantMessage: '',
          error: streaming || recovering || memoryPending ? '当前会话仍在处理上一轮，请稍后重试。' : '发送失败：会话不可用。',
          updatedAt: Date.now(),
        });
      }
      return;
    }
    await ensureOpeningMessageBeforeFirstTurn();
    sandboxDraftRef.current = '';
    setFailedContent(null);
    setStreamError(null);
    streamHadErrorRef.current = false;
    setMemoryBusy(false);
    setSandboxSubmission({
      status: 'pending',
      sourceMessageId: sandboxSourceMessageId,
      generationId,
      userMessage: content,
      assistantMessage: '',
      error: null,
      updatedAt: Date.now(),
    });

    if (configDirty) {
      await saveConfig();
    }

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      session_id: sessionId,
      turn_number: Math.max(0, ...messages.map(message => message.turn_number)) + 1,
      role: 'user',
      content,
      variants: '[]',
      variant_index: -1,
      metadata: turnMetadata ? JSON.stringify(turnMetadata) : '{}',
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
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
                setSandboxSubmission(current => current?.generationId === generationId
                    ? { ...current, status: 'streaming', assistantMessage: next, error: null, updatedAt: Date.now() }
                    : current);
                return next;
              });
            }
            break;
          case 'stream_error':
            streamHadErrorRef.current = true;
            setStreamError(message.data.error || '生成出现错误，正在重试...');
            setSandboxSubmission(current => current?.generationId === generationId
                ? { ...current, status: 'error', error: message.data.error || '生成出现错误，正在重试...', updatedAt: Date.now() }
                : current);
            break;
          case 'state_update':
            break;
          case 'memory_start':
            setMemoryBusy(true);
            break;
          case 'memory_error':
            console.warn('Post-turn state update failed:', message.data.error || '状态整理失败，已允许继续');
            setMemoryBusy(false);
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
              metadata: turnMetadata ? JSON.stringify(turnMetadata) : '{}',
              created_at: new Date().toISOString(),
            };
            setMessages(prev => [...prev, assistantMsg]);
            if (sandboxSourceMessageId) {
              setSandboxSubmission(current => current?.generationId === generationId
                ? { ...current, status: 'finalizing', assistantMessage: messageContent, error: null, updatedAt: Date.now() }
                : current);
            } else {
              setSandboxSubmission({
                status: 'finalizing',
                sourceMessageId: 'main-chat',
                generationId,
                userMessage: content,
                assistantMessage: messageContent,
                error: null,
                updatedAt: Date.now(),
              });
            }
            setStreamText('');
            streamTextRef.current = '';
            setMemoryBusy(true);
            refreshPersistedMessages([0, 500, 1500]);
            break;
          }
          case 'turn_ready':
            setAgentStatuses([]);
            setMemoryBusy(false);
            setStreaming(false);
            streamingRef.current = false;
            clearPending();
            void loadMessages().then(() => {
              setSandboxSubmission(current => {
                if (current?.generationId === generationId && current.status === 'error') {
                  window.setTimeout(() => {
                    setSandboxSubmission(latest => latest?.generationId === generationId ? null : latest);
                  }, 1200);
                  return current;
                }
                return null;
              });
            });
            refreshPersistedMessages([600, 1800]);
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
        setSandboxSubmission(current => current?.generationId === generationId
            ? { ...current, status: 'error', error: error.message || '发送失败', updatedAt: Date.now() }
            : current);
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
          refreshPersistedMessages([0, 800, 2500]);
          setStreamText('');
          streamTextRef.current = '';
        }
        if (sandboxSourceMessageId) {
          refreshPersistedMessages([0, 800, 2500]);
        }
        if (!streamHadErrorRef.current && sandboxSourceMessageId) {
          window.setTimeout(() => {
            setSandboxSubmission(current => current?.generationId === generationId ? null : current);
          }, 1200);
        }
      },
      config.stream,
      turnMetadata,
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
    const content = prepareOpeningContent(greeting);
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
      await loadSessionState();
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
    const greetings = getParsedGreetings(characterCard);
    const greeting = greetings[index + 1] || greetings[0];
    if (!greeting) {
      setStreamError(`找不到开场白 swipe ${swipeId}`);
      return;
    }
    setSelectedGreetingIndex(index);
    await applyOpeningContent(greeting, '切换开场白失败', canApplyOpening);
  }

  function resolveMessageReference(messageRef: unknown): Message | null {
    if (messages.length === 0) return null;
    if (messageRef == null || messageRef === 'latest') return messages[messages.length - 1] || null;
    const text = String(messageRef).trim();
    const byId = messages.find(msg => msg.id === text);
    if (byId) return byId;
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return null;
    if (numeric < 0) {
      const index = messages.length + numeric;
      return messages[index] || null;
    }
    return messages[numeric] || messages.find(msg => msg.turn_number === numeric) || null;
  }

  // --- sandbox action routing ---

  function sendFromSandbox(content: string, sourceMessageId?: string | number | null, generationId?: string | number | null) {
    const text = content.trim();
    if (!text) return;
    const now = Date.now();
    const last = sandboxSubmitRef.current;
    if (last && last.content === text && now - last.time < 1200) return;
    sandboxSubmitRef.current = { content: text, time: now };
    handleSend(text, {
      sandboxSourceMessageId: sourceMessageId == null ? null : String(sourceMessageId),
      generationId: generationId == null ? null : String(generationId),
    });
  }

  async function handleSandboxAction(event: SandboxCardAction, canApplyOpening: boolean, setShowVariableDebug?: (value: boolean) => void) {
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
        if (canApplyOpening) {
          const greetings = getParsedGreetings(characterCard);
          const greeting = greetings[index + 1] || greetings[0];
          if (greeting) {
            await applyOpeningContent(greeting, '应用开场白失败', canApplyOpening);
          }
        }
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
      sendFromSandbox(String(event.payload?.message || ''), event.payload?.sourceMessageId, event.payload?.generationId);
      return;
    }
    if (event.action === 'submitFreeStart' || (event.action === 'formSubmit' && event.payload?.__xrpSubmitChat === true)) {
      const metaKeys = new Set(['sourceMessageId', 'generationId', '__xrpSubmitChat']);
      const entries = event.payload && typeof event.payload === 'object'
        ? Object.entries(event.payload)
            .filter(([key]) => !metaKeys.has(key))
            .filter(([, value]) => String(value ?? '').trim())
        : [];
      const plainMessage = entries.find(([key]) => /^(?:message|text|input|prompt|content)$/i.test(key))?.[1];
      if (plainMessage != null) {
        sendFromSandbox(String(plainMessage), event.payload?.sourceMessageId, event.payload?.generationId);
        return;
      }
      const values = entries
            .map(([key, value]) => `${key}: ${String(value).trim()}`)
      if (values.length > 0) {
        sendFromSandbox(values.join('\n'), event.payload?.sourceMessageId, event.payload?.generationId);
      }
      return;
    }
    if (event.action === 'formSubmit') {
      console.debug('Card sandbox form submit ignored:', event.payload);
      return;
    }
    if (event.action === 'setVariables') {
      const variables = event.payload?.variables && typeof event.payload.variables === 'object'
        ? event.payload.variables
        : {};
      const options = event.payload?.options && typeof event.payload.options === 'object'
        ? event.payload.options
        : {};
      const scope = String(options.type || 'projection');
      if (scope === 'message') {
        const messageId = String(options.message_id ?? options.messageId ?? event.payload?.sourceMessageId ?? '').trim();
        const targetId = messageId && messageId !== 'current' && messageId !== 'latest'
          ? messageId
          : String(event.payload?.sourceMessageId || '');
        if (!targetId || !sessionId) return;
        setMessages(prev => prev.map(message => {
          if (String(message.id) !== targetId && String((message as any).message_id || '') !== targetId) return message;
          let metadata: Record<string, any> = {};
          try { metadata = JSON.parse(message.metadata || '{}'); } catch {}
          const nextMetadata = { ...metadata, variables };
          return { ...message, metadata: JSON.stringify(nextMetadata) };
        }));
        try {
          await api.updateMessageMetadata(sessionId, targetId, { variables });
        } catch (err) {
          console.error('Failed to save message variables:', err);
        }
        return;
      }
      if (scope !== 'chat' && scope !== 'projection') {
        console.debug('Scoped sandbox variables kept in runtime only:', scope, options);
        return;
      }
      if (!sessionId) return;
      try {
        await api.updateSessionVariables(sessionId, variables, options.merge === true);
        await loadSessionState();
      } catch (err) {
        console.error('Failed to save chat variables:', err);
      }
      return;
    }
    if (event.action === 'readVariables') {
      const paths = Array.isArray(event.payload?.paths)
        ? event.payload.paths.map((path: any) => String(path || '').trim()).filter(Boolean)
        : [];
      const options = event.payload?.options && typeof event.payload.options === 'object'
        ? event.payload.options
        : { type: 'projection' };
      const scope = String(options.type || 'projection');
      if (sessionId && (scope === 'canonical' || scope === 'platform' || scope === 'platform_state')) {
        const result = await api.readSessionVariables(sessionId, 'canonical', paths);
        return result?.values || {};
      }
      console.debug('Card sandbox readVariables bridge handled inside runtime:', event.payload);
      return {};
    }
    if (event.action === 'generateRaw') {
      const request = event.payload?.request && typeof event.payload.request === 'object'
        ? event.payload.request
        : (typeof event.payload?.request === 'string' ? { prompt: event.payload.request } : {});
      if (!sessionId) {
        throw new Error('Session not ready for quiet generation');
      }
      const result = await api.quietGenerate(sessionId, request);
      return {
        content: String(result?.content || ''),
        generation_id: result?.generation_id,
        model: result?.model,
      };
    }
    if (event.action === 'writeVariables') {
      const changes = event.payload?.changes;
      const options = event.payload?.options && typeof event.payload.options === 'object'
        ? event.payload.options
        : { type: 'projection' };
      const scope = String(options.type || 'projection');
      if (scope === 'projection' && sessionId && Array.isArray(changes)) {
        try {
          await api.applyProjectionChanges(sessionId, changes.map((change: any) => ({
            path: String(change?.path ?? change?.target ?? '').trim(),
            value: change?.value ?? change?.to ?? null,
          })).filter((change: any) => change.path));
          await loadSessionState();
        } catch (err) {
          console.error('Failed to apply projection changes:', err);
        }
        return;
      }
      if (changes && typeof changes === 'object') {
        await handleSandboxAction({
          action: 'setVariables',
          payload: {
            variables: Array.isArray(changes) ? {} : changes,
            options,
          },
        } as SandboxCardAction, canApplyOpening, setShowVariableDebug);
      }
      return;
    }
    if (event.action === 'setChatMessage') {
      // Card JS follows ST convention: may send swipe_id + message_id without a message body.
      // e.g. {message_id: 0, swipe_id: 1} = switch opening message to alternate greeting 0
      const message = String(event.payload?.message || '').trim();
      const swipeId = Number(event.payload?.swipeId ?? event.payload?.swipe_id ?? event.payload?.options?.swipe_id);
      const messageRef = event.payload?.messageId ?? event.payload?.message_id;
      const targetMessage = resolveMessageReference(messageRef ?? (canApplyOpening ? 0 : 'latest'));
      if (Number.isInteger(swipeId) && targetMessage?.turn_number === 0) {
        applyOpeningSwipe(swipeId, canApplyOpening);
        return;
      }
      if (Number.isInteger(swipeId) && targetMessage?.role === 'assistant' && sessionId) {
        const variantIndex = swipeId <= 0 ? -1 : swipeId - 1;
        try {
          const result = await api.switchVariant(sessionId, targetMessage.id, variantIndex);
          setMessages(prev => prev.map(m =>
            m.id === targetMessage.id ? { ...m, content: result.content, variants: result.variants, variant_index: result.variant_index } : m
          ));
        } catch (err) {
          console.error('Sandbox switch variant failed:', err);
        }
        return;
      }
      if (canApplyOpening && message) {
        const greetings = getParsedGreetings(characterCard);
        const normalizedMessage = cleanComparableMessageText(message);
        const matchedGreetingIndex = greetings.findIndex((greeting: string) =>
          cleanComparableMessageText(greeting) === normalizedMessage
        );
        if (matchedGreetingIndex >= 0) {
          setSelectedGreetingIndex(matchedGreetingIndex - 1);
        }
        await applyOpeningContent(message, '应用开场白失败', canApplyOpening);
        return;
      }
      if (message && targetMessage && sessionId) {
        try {
          const result = await api.editMessage(sessionId, targetMessage.id, message);
          setMessages(prev => prev.map(m =>
            m.id === targetMessage.id ? { ...m, content: result.content, variants: result.variants, variant_index: result.variant_index } : m
          ));
        } catch (err) {
          console.error('Sandbox edit message failed:', err);
        }
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
        sendFromSandbox(sendMatch[1].trim(), event.payload?.sourceMessageId, event.payload?.generationId);
        return;
      }
      const draft = sandboxDraftRef.current.trim() || input.trim();
      if (command && draft) {
        sendFromSandbox(draft, event.payload?.sourceMessageId, event.payload?.generationId);
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
