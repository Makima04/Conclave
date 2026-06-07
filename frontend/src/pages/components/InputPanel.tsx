import React, { useRef, useEffect } from 'react';

interface InputPanelProps {
  // input state
  input: string;
  setInput: (value: string) => void;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  inputLocked: boolean;

  // status flags
  streaming: boolean;
  recovering: boolean;
  memoryPending: boolean;

  // session info
  sessionTitle: string;
  characterName: string;

  // opening greeting
  canApplyOpening?: boolean;
  selectedGreetingIndex?: number;
  greetingOptions?: Array<{ value: number; label: string }>;
  onSelectGreeting?: (value: number) => void;
  onApplyGreeting?: () => void;

  // continue writing
  onContinueWriting?: () => void;
}

export const InputPanel = React.memo(function InputPanel({
  input, setInput, handleSend, handleKeyDown, inputLocked,
  streaming, recovering, memoryPending,
  sessionTitle, characterName,
  canApplyOpening = false,
  selectedGreetingIndex = -1,
  greetingOptions = [],
  onSelectGreeting,
  onApplyGreeting,
  onContinueWriting,
}: InputPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  return (
    <aside className="input-panel">
      {/* Session header */}
      <div className="input-panel-header">
        <div className="input-panel-title" title={sessionTitle}>
          {sessionTitle || '未命名会话'}
        </div>
        {characterName && (
          <div className="input-panel-char">{characterName}</div>
        )}
      </div>

      {greetingOptions.length > 0 && (
        <div className="input-panel-greeting">
          <div className="input-panel-section-label">开场白</div>
          <select
            className="input-panel-greeting-select"
            value={selectedGreetingIndex}
            onChange={event => onSelectGreeting?.(Number(event.target.value))}
            disabled={!canApplyOpening || inputLocked}
          >
            {greetingOptions.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button
            className="input-panel-greeting-apply"
            onClick={onApplyGreeting}
            disabled={!canApplyOpening || inputLocked}
          >
            应用开场白
          </button>
        </div>
      )}

      {/* Continue writing prompt */}
      <button
        className="continue-writing-btn"
        disabled={inputLocked}
        onClick={onContinueWriting}
      >
        继续书写这个故事的后续…
      </button>

      {/* Input area */}
      <div className="input-panel-composer">
        <textarea
          ref={textareaRef}
          className="input-panel-textarea"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            memoryPending ? '正在整理记忆...'
            : recovering ? '等待后端响应中...'
            : streaming ? '发送中...'
            : '输入消息…'
          }
          rows={3}
          disabled={inputLocked}
        />
        <button
          className="input-panel-send"
          onClick={() => handleSend()}
          disabled={inputLocked || !input.trim()}
        >
          {memoryPending ? '整理中...' : streaming ? '发送中...' : recovering ? '等待中...' : '发送'}
        </button>
      </div>

      {/* Quick actions */}
      <div className="input-panel-actions">
        <button className="input-action-btn" disabled={inputLocked} title="记事本">
          📝 记事本
        </button>
        <button className="input-action-btn" disabled={inputLocked} title="记录">
          📋 记录
        </button>
      </div>
    </aside>
  );
});
