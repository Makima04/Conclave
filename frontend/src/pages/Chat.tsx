import { useCallback, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SessionConfig } from '../api/types';
import { ChatPane, useChatSessionState, type ChatPaneController } from '../features/chat-runtime';
import { parsedGreetings } from '../features/chat-runtime/helpers';
import { ChatLayout } from './chat/ChatLayout';
import { SettingsSidebar } from './chat/SettingsSidebar';
import { InputDebugRail } from './chat/InputDebugRail';
import '../styles/chat.css';
import '../styles/st-host.css';
import '../styles/settings.css';
import '../styles/chat-v3.css';

export default function Chat() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const paneRef = useRef<ChatPaneController | null>(null);

  const {
    session,
    characterCard,
    runtimeAssets,
    renderPayload,
    messages,
    openingIndex,
    runtimeReady,
    loading,
    error,
    configSaving,
    reload,
    patchConfig,
    setOpeningIndex,
    setError,
  } = useChatSessionState(sessionId);

  const [debug, setDebug] = useState({ streaming: false, streamText: '', error: null as string | null, turnNumber: null as number | null });
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // Recent turns kept visible before older messages collapse. Page-local (not
  // persisted); user-tunable from the right rail.
  const [collapseThreshold, setCollapseThreshold] = useState(10);

  // Optimistic + debounced persistence (see useChatSessionState.patchConfig).
  // The previous version did a PUT + full reload() per keystroke, which is why
  // typing into number fields felt frozen.
  const onConfigChange = useCallback(
    (patch: Partial<SessionConfig>) => patchConfig(patch),
    [patchConfig],
  );

  if (loading && !session) {
    return <div className="st-host-loading">正在加载会话…</div>;
  }
  if (!sessionId || !session) {
    return <div className="st-host-loading">无效的会话 ID。</div>;
  }

  const greetings = parsedGreetings(characterCard);
  const hasStarted = messages.some(message => message.turn_number > 0);
  const canApplyOpening = Boolean(characterCard && !hasStarted);

  return (
    <ChatLayout
      header={
        <>
          <div className="st-host-brand">
            <button type="button" className="st-host-back" onClick={() => navigate('/')}>
              ← 返回
            </button>
            <h1 title={characterCard?.name || session.title}>{characterCard?.name || session.title}</h1>
          </div>
          <div className="st-host-actions">
            <button type="button" onClick={() => navigate(`/chat/${sessionId}/inspector`)}>
              Agent 工作台
            </button>
            <button type="button" onClick={() => void reload(true)}>
              重新加载
            </button>
          </div>
        </>
      }
      left={<SettingsSidebar session={session} onConfigChange={onConfigChange} active={activeCategory} onSelectActive={setActiveCategory} saving={configSaving} />}
      center={
        <ChatPane
          ref={paneRef}
          sessionId={sessionId}
          characterCard={characterCard}
          runtimeAssets={runtimeAssets}
          renderPayload={renderPayload}
          messages={messages}
          runtimeReady={runtimeReady}
          openingIndex={openingIndex}
          collapseThreshold={collapseThreshold}
          onStateChange={state => setDebug(state)}
          onMessagesUpdated={() => void reload(false)}
        />
      }
      right={
        <InputDebugRail
          sessionId={sessionId}
          controllerRef={paneRef}
          greetingsCount={greetings.length}
          openingIndex={openingIndex}
          canApplyOpening={canApplyOpening}
          onApplyOpening={async content => {
            const target = content || greetings[openingIndex] || greetings[0] || '';
            if (!target.trim()) return;
            try {
              await paneRef.current?.applyOpening(target);
              await reload(false);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
          onChangeOpening={delta => {
            if (greetings.length <= 1) return;
            const next = (openingIndex + delta + greetings.length) % greetings.length;
            setOpeningIndex(next);
          }}
          collapseThreshold={collapseThreshold}
          onCollapseThresholdChange={setCollapseThreshold}
          debug={debug}
        />
      }
    />
  );
}
