import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as api from '../../api/client';
import type { CharacterCard, Message, SessionRuntimeAssets, StHostRenderPayload } from '../../api/types';
import { ChatSurfaceIframe } from '../../pages/st-runtime/ChatSurfaceIframe';
import { normalizeTavernHelperScripts } from '../../pages/st-runtime/tavern-helper-scripts';
import {
  escapeHtml,
  messageFingerprint,
  messageHtml,
  parsedGreetings,
  resolveOpeningIndex,
  sortMessages,
} from './helpers';

export interface ChatPaneController {
  /** Send a user message; returns the AbortController for the stream. */
  sendMessage: (content: string) => AbortController | null;
  /** Abort the in-flight stream, if any. */
  stop: () => void;
  /** Apply the given opening (greeting) text. */
  applyOpening: (content: string) => Promise<void>;
  /** Switch the active greeting index, returning its content. */
  changeOpening: (delta: number) => string;
  /** Re-fetch messages/render payload from the backend. */
  reload: () => Promise<void>;
}

export interface ChatPaneProps {
  sessionId: string;
  characterCard: CharacterCard | null;
  runtimeAssets: SessionRuntimeAssets;
  renderPayload: StHostRenderPayload | null;
  messages: Message[];
  runtimeReady: boolean;
  openingIndex: number;
  /** Notifies the parent of streaming/error/opening changes (for the debug rail). */
  onStateChange?: (state: {
    streaming: boolean;
    streamText: string;
    error: string | null;
    turnNumber: number | null;
  }) => void;
  /** Called when messages change (after a turn completes) so the parent can refresh settings/agents. */
  onMessagesUpdated?: () => void;
  /** Recent turns to keep visible before older messages collapse (0 disables). */
  collapseThreshold?: number;
}

/**
 * ChatPane — renders chat messages the ST-host way (ChatSurfaceIframe sandbox)
 * and owns the streaming/opening flow. Pure rendering + send/receive; no sidebar,
 * no input box (the parent owns layout and the input box).
 *
 * Extracted from pages/StHost.tsx so both StHost and /chat pages share one renderer.
 */
export const ChatPane = forwardRef<ChatPaneController, ChatPaneProps>(function ChatPane(
  {
    sessionId,
    characterCard,
    runtimeAssets,
    renderPayload,
    messages,
    runtimeReady,
    openingIndex,
    collapseThreshold,
    onStateChange,
    onMessagesUpdated,
  },
  ref,
) {
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnNumber, setTurnNumber] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    onStateChange?.({ streaming, streamText, error, turnNumber });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, streamText, error, turnNumber]);

  const { greetings, renderedGreetings } = useMemo(() => {
    if (renderPayload) {
      // Mirror the raw list with its backend-rendered counterpart so the selected
      // greeting's preview can use the rendered HTML (rendered_greetings) instead
      // of always falling back to the first message's rendered_html — which is why
      // switching greetings previously had no visible effect.
      const raw = [renderPayload.first_message, ...(renderPayload.greetings || [])];
      const rendered = [renderPayload.rendered_html, ...(renderPayload.rendered_greetings || [])];
      const kept = raw
        .map((text, i) => ({ text, rendered: rendered[i] ?? '' }))
        .filter(pair => typeof pair.text === 'string' && pair.text.trim().length > 0);
      return {
        greetings: kept.map(pair => pair.text),
        renderedGreetings: kept.map(pair => pair.rendered),
      };
    }
    const parsed = parsedGreetings(characterCard);
    return { greetings: parsed, renderedGreetings: parsed.map(() => '') };
  }, [renderPayload, characterCard]);

  const userName = useMemo(() => '', []);
  const sortedMessages = useMemo(() => sortMessages(messages), [messages]);
  const hasStarted = sortedMessages.some(message => message.turn_number > 0);

  const renderedMessageById = useMemo(
    () =>
      new Map((renderPayload?.messages || []).map(message => [message.id, message.rendered_html])),
    [renderPayload],
  );

  const openingContent = greetings[openingIndex] || greetings[0] || '';
  // Pre-rendered HTML for the selected greeting (backend applied the card's
  // regex/macros), falling back to escaped plain text when unavailable.
  const openingRendered = renderedGreetings[openingIndex] || '';

  // Messages rendered as HTML — preview opening before the conversation starts,
  // otherwise the persisted message list (greeting is turn 0 once applied).
  const messagesHtml = useMemo(() => {
    if (!characterCard) return '';
    const showOpeningPreview = Boolean(characterCard && !hasStarted && openingContent);
    if (showOpeningPreview) {
      const first = openingRendered || escapeHtml(openingContent);
      return messageHtml(characterCard.name || 'assistant', first, false);
    }
    const display = hasStarted
      ? sortedMessages
      : sortedMessages.filter(message => !(message.turn_number === 0 && message.role === 'assistant'));
    return display
      .map(message => {
        const isUser = message.role === 'user';
        const name = isUser ? userName : characterCard.name || 'assistant';
        const rendered = isUser ? '' : renderedMessageById.get(message.id) || '';
        const body = isUser || !rendered
          ? `<div class="cx-plain">${escapeHtml(message.content)}</div>`
          : rendered;
        return messageHtml(name, body, isUser);
      })
      .join('');
  }, [
    characterCard,
    hasStarted,
    openingContent,
    openingRendered,
    renderPayload,
    sortedMessages,
    renderedMessageById,
    userName,
  ]);

  const streamingHtml = useMemo(() => {
    if (!streaming || !streamText || !characterCard) return null;
    return messageHtml(characterCard.name, `<div class="cx-plain">${escapeHtml(streamText)}</div>`, false);
  }, [streaming, streamText, characterCard]);

  const runtimeHostScripts = useMemo(
    () => normalizeTavernHelperScripts(runtimeAssets.tavern_helper_scripts),
    [runtimeAssets],
  );

  const cardKey = useMemo(
    () => `${sessionId}:${characterCard?.id ?? ''}:${runtimeHostScripts.length}`,
    [sessionId, characterCard?.id, runtimeHostScripts.length],
  );

  const reload = useCallback(async () => {
    onMessagesUpdated?.();
    // Parent owns the message source (useChatSessionState); signal it to reload.
    // We re-render from props, so only a parent reload updates messages.
  }, [onMessagesUpdated]);

  const sendMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!sessionId || streaming || !trimmed) return null;
      setStreaming(true);
      setStreamText('');
      setError(null);
      abortRef.current = api.sendMessageStream(
        sessionId,
        trimmed,
        message => {
          if (message.event === 'message_delta') {
            setStreamText(current => current + message.data.content);
          } else if (message.event === 'turn_end') {
            setStreamText(message.data.message_content);
            setTurnNumber(message.data.turn_number ?? null);
          } else if (message.event === 'stream_error') {
            setError(message.data.error);
          } else if (message.event === 'turn_ready') {
            void reload();
          }
        },
        errorValue => {
          setError(errorValue.message);
          setStreaming(false);
        },
        () => {
          setStreaming(false);
        },
      );
      return abortRef.current;
    },
    [sessionId, streaming, reload],
  );

  const applyOpening = useCallback(
    async (content: string) => {
      if (!sessionId || !content.trim()) return;
      await api.applyOpeningMessage(sessionId, content);
      await reload();
    },
    [sessionId, reload],
  );

  const changeOpening = useCallback(
    (delta: number) => {
      if (greetings.length <= 1) return openingContent;
      // Pure index math; the parent owns openingIndex state. Return the candidate content.
      const next = (openingIndex + delta + greetings.length) % greetings.length;
      return greetings[next] || openingContent;
    },
    [greetings, openingIndex, openingContent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  useImperativeHandle(
    ref,
    () => ({ sendMessage, stop, applyOpening, changeOpening, reload }),
    [sendMessage, stop, applyOpening, changeOpening, reload],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div className="st-host-chat-surface">
      {!characterCard ? (
        <div className="st-host-empty-state">
          当前会话没有绑定可渲染的角色卡。请在左侧选择世界书，或导入 JSON/PNG。
        </div>
      ) : !runtimeReady ? (
        <div className="st-host-empty-state">正在初始化渲染运行时…</div>
      ) : (
        <ChatSurfaceIframe
          cardKey={cardKey}
          messagesHtml={messagesHtml}
          tavernHelperScripts={runtimeHostScripts}
          streamingHtml={streamingHtml}
          collapseThreshold={collapseThreshold}
        />
      )}
      {error && <div className="st-host-error">{error}</div>}
    </div>
  );
});
