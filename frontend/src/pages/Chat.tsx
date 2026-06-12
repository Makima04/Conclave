import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import {
  cleanCardDisplayText,
  renderCardIframeHtml,
} from './card-content';
import { MessageContent } from './components/MessageContent';
import { cleanupIframeParentRuntimeUi, IframeHtmlRuntimeHost } from './components/IframeHtmlRuntimeHost';
import '../styles/chat.css';
import { ToolRail } from './components/ToolRail';
import { ToolDrawer } from './components/ToolDrawer';
import { InputPanel } from './components/InputPanel';
import type { InspectorTab } from './components/InspectorSidebar';
import type { CharacterCard, Message, Session } from '../api/types';
import { useChatSession } from './hooks/useChatSession';
import { useStreamRecovery } from './hooks/useStreamRecovery';
import { useMessageStream } from './hooks/useMessageStream';
import {
  getOpeningHtmlAppHostContent,
  stripKnownOpeningHtmlTriggers,
} from './st-opening-ui';
import { mergeVariableObjects, parseInitVariables } from './st-init-variables';

// --- inline SandboxRuntime types (replacing deleted sandbox-runtime-types module) ---

interface SandboxRuntimeMessage {
  id: string | number;
  message_id: string;
  swipe_id?: number;
  swipes?: string[];
  swipes_data?: Record<string, any>[];
  swipes_info?: Record<string, any>[];
  role: string;
  name: string;
  message: string;
  content: string;
  created_at?: string;
  send_date?: string;
  turn_number?: number;
  is_user: boolean;
  is_system?: boolean;
  data: Record<string, any>;
  variables?: Record<string, any>;
}

interface SandboxRuntimeSubmission {
  status: string;
  sourceMessageId: string | null;
  generationId: string | null;
  userMessage: string;
  assistantMessage: string;
  error: string | null;
  updatedAt: number;
}

interface SandboxSharedSave {
  saveId: string;
  sessionId: string;
  runId: string;
  meta: Record<string, any>;
  payload: Record<string, any>;
}

interface SandboxRuntimeContext {
  sessionId?: string;
  messages: SandboxRuntimeMessage[];
  currentMessage: SandboxRuntimeMessage | null;
  currentMessageId: string | number | null;
  sharedSaves: SandboxSharedSave[];
  variableContract?: {
    writableProjectionPaths: string[];
    manualReviewPaths: string[];
    writableCanonicalPaths: string[];
  };
  platformState?: Record<string, unknown>;
  writableState?: Record<string, unknown>;
  submission?: SandboxRuntimeSubmission | null;
}

function simpleHash(source: string): string {
  let hash = 5381;
  for (let index = 0; index < source.length; index++) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export default function Chat() {
  const navigate = useNavigate();
  // --- hook: session lifecycle ---
  const session = useChatSession();
  const {
    sessionId, messages, setMessages, sessionTitle, setSessionTitle,
    config, setConfig, configDirty, setConfigDirty, characterCard,
    providers, worldBooks, presets, activeWorldBookId, sessionResourceSaving,
    renderMode, userPersona, userPresets, sessionMode, selectedGreetingIndex,
    setSelectedGreetingIndex, sessionState, runtimeAssets, showVariableDebug, setShowVariableDebug,
    titleInput, setTitleInput, editingTitle, setEditingTitle, streamError,
    titleInputRef, loadSessionResources, loadSession,
    loadMessages, loadSessionState, loadRuntimeAssets, saveConfig, updateConfig, updateRenderMode,
    updateUserPersona, updateUserSettingMergeStrategy, updateSessionWorldBook,
    updateSessionPreset, applyUserPersonaPreset, applyGlobalDefaultsToSession,
    saveCurrentSessionAsGlobalDefaults, selectedGreetingText: selectedGreetingText_,
  } = session;

  // --- hook: stream recovery ---
  const recovery = useStreamRecovery(sessionId, setMessages, loadMessages);
  const {
    recovering, failedContent, setFailedContent, memoryPending, stateUpdating,
    agentStatuses, streamText, setPending, clearPending, getPending,
    startRecovery, stopRecovery, recoveringRef, streamHadErrorRef,
    streamTextRef, memoryPendingRef, streamingRef, setMemoryBusy,
    setStreamText, setStreamError, setAgentStatuses,
  } = recovery;

  // --- hook: message stream ---
  const stream = useMessageStream({
    sessionId, messages, setMessages, config, configDirty, characterCard,
    runtimeAssets,
    selectedGreetingIndex, setSelectedGreetingIndex, saveConfig, loadMessages,
    loadSessionState, recovering, failedContent, setFailedContent, memoryPending,
    setMemoryBusy, agentStatuses, setAgentStatuses,
    streamText, setStreamText, streamError, setStreamError,
    setPending, clearPending, startRecovery, stopRecovery, recoveringRef,
    streamHadErrorRef, streamTextRef, memoryPendingRef, streamingRef,
  });
  const {
    streaming, input, setInput, regeneratingId, regenerateErrors, rawViewIds,
    copiedMsgId, editingId, editContent, setEditContent, sandboxActionLog, sandboxSubmission, inputLocked,
    handleSend, handleKeyDown, handleApplyGreeting, handleSandboxAction,
    handleRetry, handleRegenerate, handleSwitchVariant, handleEdit,
    handleSaveEdit, handleCancelEdit, handleDelete, getVariants, toggleRawView,
    handleCopyMsg, greetingLabel,
  } = stream;
  const selectedGreetingText = selectedGreetingText_();

  // --- local UI state ---
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<InspectorTab>('params');
  const [paramsEditing, setParamsEditing] = useState(false);
  const [userEditing, setUserEditing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const emptyVariables = React.useMemo(() => ({}), []);
  const [peerSharedSaves, setPeerSharedSaves] = useState<SandboxSharedSave[]>([]);

  // --- derived ---
  const cardHasStatusRenderer = React.useMemo(
    () => {
      if (!characterCard) return false;
      const content = characterCard.first_mes || '';
      return /<[a-zA-Z][^>]*>/.test(content);
    },
    [characterCard],
  );
  const hasStarted = React.useMemo(() => messages.some(msg => msg.turn_number > 0), [messages]);
  const canApplyOpening = !hasStarted;
  const visibleMessages = React.useMemo(
    () => messages.filter(message => !isHtmlAppInternalMessage(message)),
    [messages],
  );
  const cardProjectionVariables = sessionState?.variables || emptyVariables;
  const cardPlatformState = sessionState?.platform_state && typeof sessionState.platform_state === 'object'
    ? sessionState.platform_state
    : emptyVariables;
  const cardWritableState = sessionState?._state_agent_writable && typeof sessionState._state_agent_writable === 'object'
    ? sessionState._state_agent_writable
    : emptyVariables;
  const cardVariableContract = React.useMemo(() => ({
    writableProjectionPaths: Array.isArray(characterCard?.conclave_package?.state_adapter?.write_rules)
      ? characterCard!.conclave_package!.state_adapter.write_rules.map(rule => rule.card_path)
      : [],
    manualReviewPaths: Array.isArray(characterCard?.conclave_package?.state_adapter?.warnings)
      ? characterCard!.conclave_package!.state_adapter.warnings
      : [],
    writableCanonicalPaths: Array.isArray(characterCard?.conclave_package?.state_adapter?.write_rules)
      ? characterCard!.conclave_package!.state_adapter.write_rules.map(rule => rule.platform_path)
      : [],
  }), [characterCard?.conclave_package?.state_adapter]);
  const flatVariables = React.useMemo(
    () => Object.keys(cardProjectionVariables).length ? flattenVariables(cardProjectionVariables) : [],
    [cardProjectionVariables],
  );
  const activeWorldBook = React.useMemo(
    () => worldBooks.find(book => book.id === activeWorldBookId) || null,
    [worldBooks, activeWorldBookId],
  );
  const activePreset = React.useMemo(
    () => config.active_preset_id
      ? presets.find(preset => preset.id === config.active_preset_id) || null
      : null,
    [presets, config.active_preset_id],
  );
  const activePresetMissing = Boolean(config.active_preset_id && !activePreset);
  const loadSharedSaves = React.useCallback(async () => {
    const worldBookId = activeWorldBookId || characterCard?.world_book_id;
    if (!worldBookId || !characterCard) {
      return [];
    }
    const sharedSaveData = await api.listSharedSaves({ worldPackId: worldBookId, limit: 50 });
    return sharedSaveData.items || [];
  }, [activeWorldBookId, characterCard?.id, characterCard?.world_book_id]);
  const greetingOptions = React.useMemo(() => {
    if (!characterCard) return [];
    const options: Array<{ value: number; label: string }> = [];
    parseGreetings(characterCard).forEach((greeting, index) => {
      options.push({
        value: index - 1,
        label: greetingLabel(greeting, index === 0 ? '主开场白' : `可选开场白 ${index}`),
      });
    });
    return options;
  }, [characterCard, greetingLabel]);
  const sandboxRuntimeMessages = React.useMemo(
    () => messages.map(buildSandboxRuntimeMessage),
    [messages, cardProjectionVariables, userPersona.name, characterCard?.name],
  );
  const sandboxRuntimeById = React.useMemo(
    () => new Map(sandboxRuntimeMessages.map(message => [String(message.id), message])),
    [sandboxRuntimeMessages],
  );
  const hasHtmlAppInternalMessages = React.useMemo(
    () => messages.some(message => isHtmlAppInternalMessage(message)),
    [messages],
  );
  const runtimeSharedSaves = React.useMemo(() => {
    if (!sessionId || !characterCard) return peerSharedSaves;
    const now = new Date().toISOString();
    const currentSession: Session = {
      id: sessionId,
      title: sessionTitle || '自动存档',
      mode: sessionMode,
      config,
      current_turn: messages.length,
      title_source: 'auto',
      status: 'idle',
      world_pack_id: activeWorldBookId || characterCard.world_book_id || null,
      created_at: messages[0]?.created_at || now,
      updated_at: messages[messages.length - 1]?.created_at || now,
    };
    return [
      buildSharedSave(currentSession, messages),
      ...peerSharedSaves.filter(save => save.sessionId !== sessionId),
    ];
  }, [activeWorldBookId, characterCard, config, messages, peerSharedSaves, sessionId, sessionMode, cardProjectionVariables, sessionTitle, userPersona.name]);
  const sandboxContextById = React.useMemo(
    () => new Map(messages.map(message => {
      const currentMessage = sandboxRuntimeById.get(message.id)
        || buildSandboxRuntimeMessage(message, sandboxRuntimeMessages.length);
      return [message.id, {
        sessionId,
        messages: sandboxRuntimeMessages,
        currentMessage,
        currentMessageId: message.id,
        sharedSaves: runtimeSharedSaves,
        variableContract: cardVariableContract,
        platformState: cardPlatformState,
        writableState: cardWritableState,
      } satisfies SandboxRuntimeContext];
    })),
    [messages, sandboxRuntimeMessages, sandboxRuntimeById, runtimeSharedSaves, sessionId, cardVariableContract, cardPlatformState, cardWritableState],
  );
  const openingUiHostContent = React.useMemo(
    () => getOpeningHtmlAppHostContent(characterCard, runtimeAssets),
    [characterCard, runtimeAssets],
  );
  const openingPreviewText = prepareOpeningTextDisplayContent(
    selectedGreetingText || characterCard?.first_mes || '',
    { hideStatusPlaceholder: Boolean(openingUiHostContent) },
  );
  const openingGreetingVariables = React.useMemo(
    () => buildGreetingVariableSnapshots(
      characterCard,
      cardProjectionVariables as Record<string, unknown>,
    ),
    [characterCard, cardProjectionVariables],
  );
  const selectedOpeningVariables = React.useMemo(
    () => {
      if (openingGreetingVariables.length === 0) return cardProjectionVariables as Record<string, unknown>;
      return openingGreetingVariables[selectedGreetingIndex + 1]
        || openingGreetingVariables[0]
        || cardProjectionVariables as Record<string, unknown>;
    },
    [openingGreetingVariables, selectedGreetingIndex, cardProjectionVariables],
  );
  const openingRuntimeFingerprint = React.useMemo(
    () => simpleHash(JSON.stringify({
      selectedGreetingIndex,
      variables: selectedOpeningVariables,
    })),
    [selectedGreetingIndex, selectedOpeningVariables],
  );
  const sandboxSubmissionRuntime = React.useMemo<SandboxRuntimeSubmission | null>(() => {
    if (!sandboxSubmission) return null;
    return {
      status: sandboxSubmission.status,
      sourceMessageId: sandboxSubmission.sourceMessageId,
      generationId: sandboxSubmission.generationId,
      userMessage: sandboxSubmission.userMessage,
      assistantMessage: sandboxSubmission.assistantMessage,
      error: sandboxSubmission.error,
      updatedAt: sandboxSubmission.updatedAt,
    };
  }, [sandboxSubmission]);
  const sandboxSubmissionSourceId = sandboxSubmission?.sourceMessageId || null;
  const isSandboxInlineStreaming = Boolean(sandboxSubmission);
  const runtimeAssetHostRuntime = React.useMemo(() => {
    const currentMessage = sandboxRuntimeMessages[sandboxRuntimeMessages.length - 1] || null;
    return withSandboxSubmission({
      sessionId,
      messages: sandboxRuntimeMessages,
      currentMessage,
      currentMessageId: currentMessage?.message_id ?? currentMessage?.id ?? null,
      sharedSaves: runtimeSharedSaves,
      variableContract: cardVariableContract,
      platformState: cardPlatformState,
      writableState: cardWritableState,
      submission: sandboxSubmissionRuntime,
    });
  }, [sandboxRuntimeMessages, runtimeSharedSaves, sessionId, cardVariableContract, cardPlatformState, cardWritableState, sandboxSubmissionRuntime]);
  const runtimeAssetHostDocument = React.useMemo(() => {
    if (!characterCard || visibleMessages.length === 0 || runtimeAssets.tavern_helper_scripts.length === 0) {
      return null;
    }
    return renderCardIframeHtml(
      '',
      cardProjectionVariables,
      userPersona.name || '你',
      characterCard.name || '{{char}}',
      sessionId,
      activeWorldBook?.id || characterCard.world_book_id,
      characterCard,
      null,
      runtimeAssets,
    );
  }, [activeWorldBook?.id, cardProjectionVariables, characterCard, runtimeAssets, sessionId, userPersona.name, visibleMessages.length]);
  const runtimeAssetHostKey = React.useMemo(
    () => simpleHash(JSON.stringify({
      cardId: characterCard?.id || null,
      sessionId,
      messageCount: visibleMessages.length,
      variables: cardProjectionVariables,
    })),
    [cardProjectionVariables, characterCard?.id, sessionId, visibleMessages.length],
  );
  const openingPreviewRuntime = React.useMemo(
    () => buildEmptySessionPreviewRuntime(openingPreviewText),
    [openingPreviewText, runtimeSharedSaves, selectedOpeningVariables, openingGreetingVariables, cardPlatformState, cardWritableState, characterCard?.name, sandboxSubmissionRuntime, sessionId, cardVariableContract, selectedGreetingIndex],
  );

  React.useEffect(() => () => {
    cleanupIframeParentRuntimeUi();
  }, [sessionId, characterCard?.id]);
  // --- local helpers ---
  const handleRailClick = React.useCallback((tab: InspectorTab) => {
    setDrawerTab(tab);
    setDrawerOpen(prev => drawerTab === tab ? !prev : true);
  }, [drawerTab]);

  const handleCloseDrawer = React.useCallback(() => setDrawerOpen(false), []);

  // Called by iframe card apps when they mutate messages/variables so the parent re-renders.
  const handleMessagesChanged = React.useCallback(() => {
    if (!sessionId) return;
    loadMessages();
    loadSessionState();
  }, [sessionId, loadMessages, loadSessionState]);

  const handleCardSandboxAction = React.useCallback((event: any, sourceMessageId?: string | null) => {
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
    const scopedEvent = sourceMessageId && !payload.sourceMessageId
      ? { ...event, payload: { ...payload, sourceMessageId } }
      : event;
    if (event?.action === 'loadSaveSession') {
      const targetSessionId = String(event.payload?.sessionId || '');
      if (targetSessionId && targetSessionId !== sessionId) {
        navigate(`/chat/${targetSessionId}`);
      }
      return;
    }
    if (event?.action === 'deleteSaveSession') {
      const targetSessionId = String(event.payload?.sessionId || '');
      if (!targetSessionId) return;
      api.deleteSession(targetSessionId)
        .then(() => {
          setPeerSharedSaves(prev => prev.filter(save => save.sessionId !== targetSessionId));
          if (targetSessionId === sessionId) {
            navigate('/');
          } else {
            void loadSharedSaves()
              .then(saves => setPeerSharedSaves(saves as any))
              .catch(err => console.error('Failed to refresh shared card saves:', err));
          }
        })
        .catch(err => console.error('Failed to delete shared card save:', err));
      return;
    }
    handleSandboxAction(scopedEvent, canApplyOpening, setShowVariableDebug);
  }, [canApplyOpening, handleSandboxAction, loadSharedSaves, navigate, sessionId, setShowVariableDebug]);

  function flattenVariables(value: any, prefix = ''): Array<{ key: string; value: any }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const rows: Array<{ key: string; value: any }> = [];
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        rows.push(...flattenVariables(child, path));
      } else {
        rows.push({ key: path, value: child });
      }
    }
    return rows;
  }

  function parseMessageMetadata(msg: Message): Record<string, any> {
    if (!msg.metadata) return {};
    try {
      const parsed = JSON.parse(msg.metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function parseGreetings(card: CharacterCard | null): string[] {
    if (!card) return [];
    return [card.first_mes, ...(card.alternate_greetings || [])].filter(Boolean);
  }

  function buildGreetingVariableSnapshots(
    card: CharacterCard | null,
    baseVariables: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const greetings = parseGreetings(card);
    if (greetings.length === 0) return [];
    return greetings.map(greeting => mergeVariableObjects(baseVariables, parseInitVariables(greeting)));
  }

  function prepareOpeningTextDisplayContent(content: string, options?: { hideStatusPlaceholder?: boolean }): string {
    let text = stripKnownOpeningHtmlTriggers(content).trim();
    if (options?.hideStatusPlaceholder) {
      text = text.replace(/<StatusPlaceHolderImpl\/>/g, '').trim();
    }
    return text;
  }

  function getMessageDisplayContent(msg: Message): string {
    if (msg.role === 'assistant' && msg.turn_number === 0) {
      return prepareOpeningTextDisplayContent(msg.content, { hideStatusPlaceholder: Boolean(openingUiHostContent) });
    }
    return msg.content;
  }

  function isHtmlAppInternalMessage(msg: Message): boolean {
    return parseMessageMetadata(msg).html_app_internal === true;
  }

  function buildSandboxRuntimeMessage(msg: Message, index: number): SandboxRuntimeMessage {
    const chatVariables = cardProjectionVariables;
    const metadata = parseMessageMetadata(msg);
    const rawMessageVariables = metadata.variables && typeof metadata.variables === 'object'
      ? metadata.variables
      : {};
    const hasMessageVariables = Object.keys(rawMessageVariables).length > 0;
    const messageVariables = hasMessageVariables ? rawMessageVariables : chatVariables;
    const runtimeContent = msg.role === 'assistant' && msg.content.trim() === 'false' ? '' : msg.content;
    const roleName = msg.role === 'user'
      ? (userPersona.name || '你')
      : msg.turn_number === 0 && characterCard
        ? characterCard.name
        : '助手';
    const openingSwipes = msg.turn_number === 0 && characterCard
      ? parseGreetings(characterCard)
      : [];
    const comparableContent = cleanComparableMessageText(runtimeContent);
    const matchedOpeningIndex = openingSwipes.findIndex(swipe => cleanComparableMessageText(swipe) === comparableContent);
    const messageVariants = getVariants(msg);
    let swipes: string[];
    let activeSwipeIndex: number;
    if (openingSwipes.length > 0) {
      swipes = openingSwipes;
      activeSwipeIndex = matchedOpeningIndex >= 0 ? matchedOpeningIndex : 0;
    } else if (msg.role === 'assistant' && messageVariants.length > 0) {
      swipes = [runtimeContent, ...messageVariants];
      activeSwipeIndex = 0;
    } else {
      swipes = [runtimeContent];
      activeSwipeIndex = 0;
    }

    return {
      id: msg.id,
      message_id: msg.id,
      swipe_id: activeSwipeIndex,
      swipes,
      role: msg.role,
      name: roleName,
      message: runtimeContent,
      content: runtimeContent,
      created_at: msg.created_at,
      send_date: msg.created_at,
      turn_number: msg.turn_number,
      is_user: msg.role === 'user',
      is_system: msg.role === 'system',
      data: {
        ...metadata,
        stat_data: messageVariables,
        display_data: messageVariables,
        variables: messageVariables,
        chat_variables: chatVariables,
        platform_state: cardPlatformState,
        writable_state: cardWritableState,
        index,
      },
      variables: messageVariables,
      swipes_data: swipes.map(swipe => mergeVariableObjects(chatVariables, parseInitVariables(swipe))),
      swipes_info: swipes.map(() => ({})),
    };
  }

  function cleanComparableMessageText(content: string): string {
    return cleanCardDisplayText(stripKnownOpeningHtmlTriggers(content), userPersona.name || '你', characterCard?.name || '')
      .replace(/\s+/g, '')
      .trim();
  }

  function buildSandboxRuntime(current: Message): SandboxRuntimeContext {
    const base = sandboxContextById.get(current.id) || {
      messages: sandboxRuntimeMessages,
      currentMessage: buildSandboxRuntimeMessage(current, sandboxRuntimeMessages.length),
      currentMessageId: current.id,
      sharedSaves: runtimeSharedSaves,
    };
    return withSandboxSubmission(base);
  }

  function buildStreamingSandboxRuntime(content: string): SandboxRuntimeContext {
    const projectionVariables = cardProjectionVariables;
    const syntheticSubmission: SandboxRuntimeSubmission = sandboxSubmissionRuntime || {
      status: 'streaming',
      sourceMessageId: 'main-chat',
      generationId: 'main-chat-streaming',
      userMessage: '',
      assistantMessage: content,
      error: null,
      updatedAt: Date.now(),
    };
    const streamingMessage: SandboxRuntimeMessage = {
      id: 'streaming',
      message_id: 'streaming',
      role: 'assistant',
      name: '助手',
      message: content,
      content,
      is_user: false,
      data: {
        stat_data: projectionVariables,
        display_data: projectionVariables,
        variables: projectionVariables,
        platform_state: cardPlatformState,
        writable_state: cardWritableState,
      },
      variables: projectionVariables,
    };

    return {
      sessionId,
      messages: [...sandboxRuntimeMessages, streamingMessage],
      currentMessage: streamingMessage,
      currentMessageId: 'streaming',
      sharedSaves: runtimeSharedSaves,
      variableContract: cardVariableContract,
      platformState: cardPlatformState,
      writableState: cardWritableState,
      submission: syntheticSubmission,
    };
  }

  function buildEmptySessionPreviewRuntime(content: string): SandboxRuntimeContext {
    const projectionVariables = selectedOpeningVariables;
    const openingSwipes = characterCard
      ? parseGreetings(characterCard)
      : [];
    const comparableContent = cleanComparableMessageText(content);
    const matchedOpeningIndex = openingSwipes.findIndex(swipe =>
      cleanComparableMessageText(swipe) === comparableContent
    );
    if (hasHtmlAppInternalMessages) {
      const currentMessage = sandboxRuntimeMessages[sandboxRuntimeMessages.length - 1];
      return withSandboxSubmission({
        sessionId,
        messages: sandboxRuntimeMessages,
        currentMessage,
        currentMessageId: currentMessage?.message_id ?? currentMessage?.id ?? 'opening-preview',
        sharedSaves: runtimeSharedSaves,
        variableContract: cardVariableContract,
        platformState: cardPlatformState,
        writableState: cardWritableState,
        submission: sandboxSubmissionRuntime,
      });
    }
    const previewMessage: SandboxRuntimeMessage = {
      id: 'opening-preview',
      message_id: 'opening-preview',
      swipe_id: matchedOpeningIndex >= 0 ? matchedOpeningIndex : 0,
      swipes: openingSwipes,
      role: 'assistant',
      name: characterCard?.name || '助手',
      message: content,
      content,
      turn_number: 0,
      is_user: false,
      data: {
        stat_data: projectionVariables,
        display_data: projectionVariables,
        variables: projectionVariables,
        platform_state: cardPlatformState,
        writable_state: cardWritableState,
      },
      variables: projectionVariables,
      swipes_data: openingSwipes.map((_, index) => openingGreetingVariables[index] || projectionVariables),
      swipes_info: openingSwipes.map(() => ({})),
    };

    return {
      sessionId,
      messages: [previewMessage],
      currentMessage: previewMessage,
      currentMessageId: previewMessage.id,
      sharedSaves: runtimeSharedSaves,
      variableContract: cardVariableContract,
      platformState: cardPlatformState,
      writableState: cardWritableState,
      submission: sandboxSubmissionRuntime,
    };
  }

  function withSandboxSubmission(runtime: SandboxRuntimeContext): SandboxRuntimeContext {
    if (!sandboxSubmissionRuntime) return runtime;
    if (sandboxSubmissionSourceId === 'card-runtime' || sandboxSubmissionSourceId === 'main-chat') {
      return { ...runtime, submission: sandboxSubmissionRuntime };
    }
    const currentId = runtime.currentMessageId ?? runtime.currentMessage?.message_id ?? runtime.currentMessage?.id ?? null;
    if (sandboxSubmissionSourceId && String(currentId) !== sandboxSubmissionSourceId) return runtime;
    return { ...runtime, submission: sandboxSubmissionRuntime };
  }

  function formatVariableValue(value: any): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value == null) return 'null';
    return JSON.stringify(value);
  }

  function shortText(value: string, max = 180): string {
    const text = value.trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
  }

  function extractSavePreview(sessionMessages: Message[], fallback: string): string {
    const candidate = [...sessionMessages].reverse().find(message => message.role === 'assistant') || sessionMessages[0];
    const text = cleanCardDisplayText(candidate?.content || fallback || '', userPersona.name || '你', characterCard?.name || '').replace(/\s+/g, ' ').trim();
    return shortText(text, 180);
  }

  function extractAssistantSaveText(content: string): string {
    const source = String(content || '');
    const visibleMatch = source.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i)
      || source.match(/<正文\b[^>]*>([\s\S]*?)<\/正文>/i);
    const visibleSource = visibleMatch?.[1] || source;
    return cleanCardDisplayText(visibleSource, userPersona.name || '你', characterCard?.name || '')
      .replace(/<context\b[^>]*>[\s\S]*?<\/context>/gi, '')
      .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
      .replace(/<tucao\b[^>]*>[\s\S]*?<\/tucao>/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function buildSharedSave(targetSession: Session, sessionMessages: Message[]): SandboxSharedSave {
    const saveId = `xrp-session-${targetSession.id}`;
    const runId = targetSession.id;
    const personaName = targetSession.config?.user_persona?.name || userPersona.name || characterCard?.name || '未命名主角';
    const persona = targetSession.config?.user_persona || userPersona;
    const firstAssistant = sessionMessages.find(message => message.role === 'assistant');
    const lastMessage = sessionMessages[sessionMessages.length - 1];
    const updatedAt = targetSession.updated_at || lastMessage?.created_at || new Date().toISOString();
    const createdAt = targetSession.created_at || firstAssistant?.created_at || updatedAt;
    const chatLog = sessionMessages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => {
        const isAssistant = message.role === 'assistant';
        const rawText = String(message.content || '');
        return {
          role: message.role,
          speaker: message.role === 'user' ? (personaName || 'User') : 'Assistant',
          text: isAssistant ? extractAssistantSaveText(rawText) : rawText,
          ...(isAssistant ? { rawText } : {}),
        };
      });
    const statusData = cardProjectionVariables && typeof cardProjectionVariables === 'object'
      ? JSON.parse(JSON.stringify(cardProjectionVariables))
      : {};
    const gameState = {
      runId,
      statusData,
      currentMessageIndex: Math.max(0, chatLog.length - 1),
      runtimeFlags: {
        saveKind: 'autosave',
        playerProfile: {
          name: personaName,
          familyName: '',
          givenName: personaName,
          gender: '男',
          personality: persona?.background || '',
          appearance: persona?.style || '',
          className: persona?.address || '2年B班',
          stats: {
            knowledge: 60,
            charm: 60,
            proficiency: 60,
            kindness: 60,
            courage: 60,
          },
          difficulty: 'normal',
        },
        phoneMessages: null,
      },
    };
    const meta = {
      saveId,
      runId,
      sessionId: targetSession.id,
      kind: 'autosave',
      label: targetSession.title || '自动存档',
      createdAt,
      updatedAt,
      messageIndex: Math.max(0, sessionMessages.length - 1),
      messageCount: sessionMessages.length,
      playerProfile: { name: personaName },
      characterName: characterCard?.name || targetSession.title || '',
      location: '',
      gameTime: '',
      preview: extractSavePreview(sessionMessages, targetSession.title),
      version: 1,
    };
    return {
      saveId,
      sessionId: targetSession.id,
      runId,
      meta,
      payload: {
        saveId,
        runId,
        sessionId: targetSession.id,
        meta,
        gameState,
        chatLog,
        summaryStore: {},
        version: 2,
      },
    };
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
        const apiMod = await import('../api/client');
        await apiMod.updateSession(sessionId!, { title: newTitle });
      } catch (err) {
        console.error('Failed to rename session:', err);
      }
    }
  }

  // --- effects ---
  useEffect(() => {
    if (isSandboxInlineStreaming) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText, isSandboxInlineStreaming]);

  useEffect(() => {
    if (!sessionId) return;
    loadMessages().then((loadedMessages) => {
      const pending = getPending();
      if (pending) {
        const msgCount = loadedMessages?.length ?? 0;
        startRecovery(msgCount);
      }
    });
    loadSession();
    loadSessionResources();
    loadSessionState();
    loadRuntimeAssets();
    return () => { stopRecovery(); };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    async function refreshSharedSaves() {
      try {
        const saves = await loadSharedSaves();
        if (!cancelled) setPeerSharedSaves(saves as any);
      } catch (err) {
        console.error('Failed to load shared card saves:', err);
        if (!cancelled) setPeerSharedSaves([]);
      }
    }
    refreshSharedSaves();
    return () => { cancelled = true; };
  }, [loadSharedSaves]);

  return (
    <div className="chat-layout">
      {/* LEFT: Tool rail */}
      <ToolRail
        activeTab={drawerOpen ? drawerTab : null}
        onTabClick={handleRailClick}
        sessionMode={sessionMode}
        sessionId={sessionId}
      />

      {/* LEFT DRAWER: expandable settings panel */}
      <ToolDrawer
        open={drawerOpen}
        activeTab={drawerTab}
        onClose={handleCloseDrawer}
        sessionId={sessionId}
        config={config}
        setConfig={setConfig}
        configDirty={configDirty}
        characterCard={characterCard}
        providers={providers}
        worldBooks={worldBooks}
        presets={presets}
        activeWorldBookId={activeWorldBookId}
        sessionResourceSaving={sessionResourceSaving}
        renderMode={renderMode}
        userPersona={userPersona}
        userPresets={userPresets}
        sessionMode={sessionMode}
        messages={messages}
        sandboxActionLog={sandboxActionLog}
        streaming={streaming}
        recovering={recovering}
        memoryPending={memoryPending}
        stateUpdating={stateUpdating}
        flatVariables={flatVariables}
        activeWorldBook={activeWorldBook}
        activePreset={activePreset}
        activePresetMissing={activePresetMissing}
        cardHasStatusRenderer={cardHasStatusRenderer}
        paramsEditing={paramsEditing}
        setParamsEditing={setParamsEditing}
        userEditing={userEditing}
        setUserEditing={setUserEditing}
        saveConfig={saveConfig}
        updateConfig={updateConfig}
        updateRenderMode={updateRenderMode}
        updateUserPersona={updateUserPersona}
        updateUserSettingMergeStrategy={updateUserSettingMergeStrategy}
        updateSessionWorldBook={updateSessionWorldBook}
        updateSessionPreset={updateSessionPreset}
        applyUserPersonaPreset={applyUserPersonaPreset}
        applyGlobalDefaultsToSession={applyGlobalDefaultsToSession}
        saveCurrentSessionAsGlobalDefaults={saveCurrentSessionAsGlobalDefaults}
        loadSessionResources={loadSessionResources}
      />

      {/* CENTER: Immersive render zone */}
      <main className="render-zone">
        {/* Thin top bar - only essential info */}
        <div className="render-topbar">
          <div className="render-topbar-left">
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
              <span className="render-topbar-title" onClick={startRename} title="点击重命名">
                {sessionTitle || '未命名会话'}
              </span>
            )}
          </div>
        </div>

        {/* Messages list */}
        {runtimeAssetHostDocument && (
          <IframeHtmlRuntimeHost
            key={`runtime-assets-${runtimeAssetHostKey}`}
            className="card-runtime-assets-host"
            ariaHidden
            tabIndex={-1}
            documentHtml={runtimeAssetHostDocument}
            variables={cardProjectionVariables}
            runtime={runtimeAssetHostRuntime}
            sessionId={sessionId}
            worldBookId={activeWorldBook?.id || characterCard?.world_book_id}
            onAction={(event) => handleCardSandboxAction(event, 'card-runtime')}
            onMessagesChanged={handleMessagesChanged}
          />
        )}
        <div className="messages">
          {characterCard && (
            visibleMessages.length === 0
            || (
              isSandboxInlineStreaming
              && sandboxSubmissionSourceId === 'opening-preview'
              && visibleMessages.length === 0
            )
          ) && (
            <div className="message assistant opening-preview">
              <div className="message-role">{characterCard.name}</div>
              <div className="message-content">
                {openingUiHostContent && (
                  <MessageContent
                    key={`opening-ui-${openingRuntimeFingerprint}`}
                    content={openingUiHostContent}
                    card={characterCard}
                    runtimeAssets={runtimeAssets}
                    variables={selectedOpeningVariables}
                    runtime={openingPreviewRuntime}
                    onSandboxAction={(event) => handleCardSandboxAction(event, 'opening-preview')}
                    onMessagesChanged={handleMessagesChanged}
                    renderMode={renderMode}
                    userName={userPersona.name || '你'}
                    sessionId={sessionId}
                    worldBookId={activeWorldBook?.id || characterCard?.world_book_id}
                  />
                )}
                {openingPreviewText && (
                  <MessageContent
                    content={openingPreviewText}
                    card={characterCard}
                    runtimeAssets={runtimeAssets}
                    variables={selectedOpeningVariables}
                    runtime={openingPreviewRuntime}
                    onSandboxAction={(event) => handleCardSandboxAction(event, 'opening-preview')}
                    onMessagesChanged={handleMessagesChanged}
                    renderMode={renderMode}
                    userName={userPersona.name || '你'}
                    sessionId={sessionId}
                    worldBookId={activeWorldBook?.id || characterCard?.world_book_id}
                  />
                )}
              </div>
            </div>
          )}
          {visibleMessages.map(msg => {
            const isRaw = rawViewIds.has(msg.id);
            const isEditing = editingId === msg.id;
            const roleLabel = msg.role === 'user'
              ? '你'
              : msg.turn_number === 0 && characterCard
                ? characterCard.name
                : '助手';
            return (
              <div key={msg.id} className={`message ${msg.role}`}>
                <div className="message-role">{roleLabel}</div>
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
                        <>
                          <MessageContent
                            content={getMessageDisplayContent(msg)}
                            card={characterCard}
                            runtimeAssets={runtimeAssets}
                            variables={cardProjectionVariables}
                            runtime={buildSandboxRuntime(msg)}
                            onSandboxAction={(event) => handleCardSandboxAction(event, msg.id)}
                            onMessagesChanged={handleMessagesChanged}
                            renderMode={renderMode}
                            userName={userPersona.name || '你'}
                            sessionId={sessionId}
                            worldBookId={activeWorldBook?.id || characterCard?.world_book_id}
                          />
                        </>
                      )
                    ) : (
                      cleanCardDisplayText(msg.content, userPersona.name || '你', characterCard?.name || '')
                    )}
                  </div>
                )}
                {!isEditing && msg.role === 'user' && (
                  <div className="message-actions">
                    {failedContent === msg.content && (
                      <span className="send-failed-badge">发送失败</span>
                    )}
                    <button
                      className="action-btn"
                      onClick={() => handleEdit(msg.id, msg.content)}
                      title="编辑"
                    >
                      编辑
                    </button>
                    {failedContent === msg.content && (
                      <button
                        className="action-btn retry-btn"
                        onClick={handleRetry}
                        disabled={inputLocked}
                        title="重新发送"
                      >
                        重新发送
                      </button>
                    )}
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
                      {regenerateErrors[msg.id] && (
                        <span className="send-failed-badge">{regenerateErrors[msg.id]}</span>
                      )}
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
                        disabled={!!regeneratingId || inputLocked}
                        title="重新生成"
                      >
                        {regeneratingId === msg.id ? '生成中...' : '重新生成'}
                      </button>
                      <button
                        className="action-btn"
                        onClick={() => handleEdit(msg.id, msg.content)}
                        disabled={!!regeneratingId || inputLocked}
                        title="编辑"
                      >
                        编辑
                      </button>
                      <button
                        className="action-btn delete-btn"
                        onClick={() => handleDelete(msg.id)}
                        disabled={!!regeneratingId || inputLocked}
                        title="删除"
                      >
                        删除
                      </button>
                      {total > 1 && (
                        <div className="variant-nav">
                          <button
                            className="action-btn variant-btn"
                            onClick={() => handleSwitchVariant(msg.id, activeIndex === -1 ? variants.length - 1 : activeIndex - 1)}
                            disabled={activeIndex === 0 || !!regeneratingId || inputLocked}
                            title="上一个版本"
                          >
                            {'<'}
                          </button>
                          <span className="variant-count">{displayPos} / {total}</span>
                          <button
                            className="action-btn variant-btn"
                            onClick={() => handleSwitchVariant(msg.id, activeIndex >= variants.length - 1 ? -1 : activeIndex + 1)}
                            disabled={activeIndex === -1 || !!regeneratingId || inputLocked}
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
          {agentStatuses.length > 0 && !isSandboxInlineStreaming && (
            <div className="message assistant streaming">
              <div className="message-role">进度</div>
              <div className="message-content agent-status-list">
                {agentStatuses.map((s, i) => (
                  <div key={`${s.agent_type}-${i}`} className="agent-status-item">
                    <span className="agent-status-dot" />
                    <span>{s.label} 正在工作中...</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {streamError && streaming && !isSandboxInlineStreaming && (
            <div className="message assistant streaming">
              <div className="message-role">助手</div>
              <div className="message-content">
                <span className="stream-error-indicator">{streamError}</span>
              </div>
            </div>
          )}
          {streamText && !isSandboxInlineStreaming && (
            <div className="message assistant streaming">
              <div className="message-role">助手</div>
              <div className="message-content">
                <MessageContent
                  content={streamText}
                  card={characterCard}
                  runtimeAssets={runtimeAssets}
                  variables={cardProjectionVariables}
                  runtime={buildStreamingSandboxRuntime(streamText)}
                  onSandboxAction={(event) => handleCardSandboxAction(event, 'streaming')}
                  renderMode="text"
                  userName={userPersona.name || '你'}
                  sessionId={sessionId}
                  worldBookId={activeWorldBook?.id || characterCard?.world_book_id}
                />
              </div>
            </div>
          )}
          {memoryPending && !isSandboxInlineStreaming && (
            <div className="message assistant streaming">
              <div className="message-role">进度</div>
              <div className="message-content">
                <span className="recovering-indicator">正在整理记忆...</span>
              </div>
            </div>
          )}
          {stateUpdating && !memoryPending && !isSandboxInlineStreaming && (
            <div className="message assistant streaming">
              <div className="message-role">进度</div>
              <div className="message-content">
                <span className="recovering-indicator">正在更新变量...</span>
              </div>
            </div>
          )}
          {(streaming || recovering) && !isSandboxInlineStreaming && !streamText && agentStatuses.length === 0 && !streamError && !memoryPending && !stateUpdating && (
            <div className="message assistant streaming">
              <div className="message-role">助手</div>
              <div className="message-content">
                <span className="recovering-indicator">正在处理中...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* RIGHT: Input panel */}
      <InputPanel
        input={input}
        setInput={setInput}
        handleSend={handleSend}
        handleKeyDown={handleKeyDown}
        inputLocked={inputLocked}
        streaming={streaming}
        recovering={recovering}
        memoryPending={memoryPending}
        sessionTitle={sessionTitle}
        characterName={characterCard?.name || ''}
        canApplyOpening={canApplyOpening}
        selectedGreetingIndex={selectedGreetingIndex}
        greetingOptions={greetingOptions}
        onSelectGreeting={setSelectedGreetingIndex}
        onApplyGreeting={() => handleApplyGreeting(canApplyOpening)}
      />

    </div>
  );
}
