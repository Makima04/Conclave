import { useState } from 'react';
import { ChatPaneController } from '../../features/chat-runtime/ChatPane';

export interface InputDebugRailProps {
  sessionId: string;
  controllerRef: React.RefObject<ChatPaneController | null>;
  greetingsCount: number;
  openingIndex: number;
  canApplyOpening: boolean;
  onApplyOpening: (content: string) => Promise<void>;
  onChangeOpening: (delta: number) => void;
  /** Recent turns kept visible before older messages collapse (0 disables). */
  collapseThreshold: number;
  onCollapseThresholdChange: (value: number) => void;
  /** Live debug snapshot pushed from ChatPane's onStateChange. */
  debug: {
    streaming: boolean;
    error: string | null;
    turnNumber: number | null;
  };
}

/**
 * Right column: input box (send/stop) + opening switch controls + a small debug
 * panel showing the current turn / streaming / error state.
 */
export function InputDebugRail({
  controllerRef,
  greetingsCount,
  openingIndex,
  canApplyOpening,
  onApplyOpening,
  onChangeOpening,
  collapseThreshold,
  onCollapseThresholdChange,
  debug,
}: InputDebugRailProps) {
  const [input, setInput] = useState('');
  const { streaming, error, turnNumber } = debug;

  function handleSend(event?: React.FormEvent) {
    event?.preventDefault();
    const content = input.trim();
    if (!content || streaming) return;
    setInput('');
    controllerRef.current?.sendMessage(content);
  }

  function handleStop() {
    controllerRef.current?.stop();
  }

  return (
    <div className="chat-debug-rail">
      <section className="chat-debug-input">
        <form className="chat-input-form" onSubmit={handleSend}>
          <textarea
            value={input}
            placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
            rows={6}
            disabled={streaming}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSend();
              }
            }}
          />
          <div className="chat-input-actions">
            {streaming ? (
              <button type="button" onClick={handleStop}>
                停止
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}>
                发送
              </button>
            )}
          </div>
        </form>
      </section>

      {greetingsCount > 1 && (
        <section className="chat-debug-opening">
          <div className="chat-section-title">开场白</div>
          <div className="chat-opening-controls">
            <button type="button" onClick={() => onChangeOpening(-1)} disabled={streaming}>
              上一条
            </button>
            <span>
              {openingIndex + 1} / {greetingsCount}
            </span>
            <button type="button" onClick={() => onChangeOpening(1)} disabled={streaming}>
              下一条
            </button>
            {canApplyOpening && (
              <button
                type="button"
                onClick={() => onApplyOpening('')}
                disabled={streaming}
                title="应用当前开场白"
              >
                应用
              </button>
            )}
          </div>
        </section>
      )}

      <section className="chat-debug-panel">
        <div className="chat-section-title">调试</div>
        <dl className="chat-debug-meta">
          <dt>状态</dt>
          <dd>{streaming ? '流式生成中' : '空闲'}</dd>
          <dt>当前轮</dt>
          <dd>{turnNumber ?? '-'}</dd>
          {error && (
            <>
              <dt>错误</dt>
              <dd className="chat-debug-error">
                {error}
                {!streaming && (
                  <button
                    type="button"
                    onClick={() => controllerRef.current?.retryLast()}
                    title="用上一条输入重新发送（断线重连）"
                  >
                    重试本轮
                  </button>
                )}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="chat-debug-panel">
        <div className="chat-section-title">消息折叠</div>
        <label className="chat-field">
          <span>保留最近 N 轮（更早的折叠）</span>
          <input
            type="number"
            min={0}
            step={1}
            value={collapseThreshold}
            onChange={event => {
              const value = Number(event.target.value);
              onCollapseThresholdChange(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
            }}
          />
        </label>
        <p className="chat-settings-hint">0 = 不折叠。重载或发消息后自动滚到最新。</p>
      </section>
    </div>
  );
}
