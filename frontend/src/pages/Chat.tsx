import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  cleanCardDisplayText,
  hasComplexCardUi,
  hasStatusRenderer,
  isGameStartCard,
} from './card-content';
import { buildPlatformCardSchema } from './card-schema-builders';
import { MessageContent } from './components/MessageContent';
import '../styles/chat.css';
import { InspectorSidebar } from './components/InspectorSidebar';
import { useChatSession } from './hooks/useChatSession';
import { useStreamRecovery } from './hooks/useStreamRecovery';
import { useMessageStream } from './hooks/useMessageStream';

export default function Chat() {
  const navigate = useNavigate();

  // --- hook: session lifecycle ---
  const session = useChatSession();
  const {
    sessionId, messages, setMessages, sessionTitle, setSessionTitle,
    config, setConfig, configDirty, setConfigDirty, characterCard,
    providers, worldBooks, presets, activeWorldBookId, sessionResourceSaving,
    renderMode, userPersona, userPresets, sessionMode, selectedGreetingIndex,
    setSelectedGreetingIndex, sessionState, showVariableDebug, setShowVariableDebug,
    titleInput, setTitleInput, editingTitle, setEditingTitle, streamError,
    titleInputRef, loadSessionResources, loadSession,
    loadMessages, loadSessionState, saveConfig, updateConfig, updateRenderMode,
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
    selectedGreetingIndex, setSelectedGreetingIndex, saveConfig, loadMessages,
    loadSessionState, recovering, failedContent, setFailedContent, memoryPending,
    setMemoryBusy, agentStatuses, setAgentStatuses,
    streamText, setStreamText, streamError, setStreamError,
    setPending, clearPending, startRecovery, stopRecovery, recoveringRef,
    streamHadErrorRef, streamTextRef, memoryPendingRef, streamingRef,
  });
  const {
    streaming, input, setInput, regeneratingId, regenerateErrors, rawViewIds,
    copiedMsgId, editingId, editContent, setEditContent, sandboxActionLog, inputLocked,
    handleSend, handleKeyDown, handleApplyGreeting, handleSandboxAction,
    handleRetry, handleRegenerate, handleSwitchVariant, handleEdit,
    handleSaveEdit, handleCancelEdit, handleDelete, getVariants, toggleRawView,
    handleCopyMsg, greetingLabel,
  } = stream;
  const selectedGreetingText = selectedGreetingText_;

  // --- local UI state ---
  const [inspectorOpen, setInspectorOpen] = useState(window.innerWidth > 900);
  const [inspectorTab, setInspectorTab] = useState<'params' | 'worldbook' | 'preset' | 'agents' | 'render' | 'user' | 'debug'>('params');
  const [paramsEditing, setParamsEditing] = useState(false);
  const [userEditing, setUserEditing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // --- derived ---
  const cardHasStatusRenderer = hasStatusRenderer(characterCard);
  const cardHasComplexUi = hasComplexCardUi(characterCard);
  const cardHasGameStart = isGameStartCard(characterCard);
  const openingLocked = messages.some(msg => msg.turn_number > 0);
  const canApplyOpening = !openingLocked;
  const debugPlatformSchema = buildPlatformCardSchema(characterCard, characterCard?.first_mes || '\u3010GameStart\u3011');
  const flatVariables = React.useMemo(
    () => sessionState?.variables ? flattenVariables(sessionState.variables) : [],
    [sessionState?.variables],
  );
  const activeWorldBook = worldBooks.find(book => book.id === activeWorldBookId) || null;
  const activePreset = config.active_preset_id
    ? presets.find(preset => preset.id === config.active_preset_id) || null
    : null;
  const activePresetMissing = Boolean(config.active_preset_id && !activePreset);

  // --- local helpers ---
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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

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
    return () => { stopRecovery(); };
  }, [sessionId]);

  return (
    <div className={`chat-layout${inspectorOpen ? ' inspector-open' : ''}`}>
    <div className="chat-main">
    <div className="chat">
      <div className="chat-header">
        <button className="back-btn" onClick={() => navigate('/')}>返回</button>
        <div className="header-user-entry" onClick={() => { setInspectorTab('user'); setInspectorOpen(true); }}>
          {userPersona.name || '默认用户'}
        </div>
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
        <div className="header-spacer" />
        <button
          className={`config-toggle ${inspectorOpen ? 'active' : ''}`}
          onClick={() => setInspectorOpen(!inspectorOpen)}
        >
          ☰
        </button>
      </div>

      {characterCard && (
        <div className="chat-card-panel">
          <div className="chat-card-avatar">
            {characterCard.avatar && characterCard.avatar !== 'none'
              ? <img src={characterCard.avatar} alt={characterCard.name} />
              : <span>{characterCard.name.charAt(0)}</span>
            }
          </div>
          <div className="chat-card-main">
            <div className="chat-card-header">
              <div>
                <div className="chat-card-name">{characterCard.name}</div>
                {(characterCard.creator || characterCard.character_version) && (
                  <div className="chat-card-meta">
                    {[characterCard.creator, characterCard.character_version && `v${characterCard.character_version}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
              </div>
              {canApplyOpening && (characterCard.first_mes || characterCard.alternate_greetings.length > 0) && (
                <div className="chat-card-greeting-controls">
                  {characterCard.alternate_greetings.length > 0 && (
                    <select
                      className="chat-card-greeting-select"
                      value={selectedGreetingIndex}
                      onChange={e => setSelectedGreetingIndex(Number(e.target.value))}
                      disabled={inputLocked}
                    >
                      {characterCard.first_mes && (
                        <option value={-1}>{greetingLabel(characterCard.first_mes, '主开场白')}</option>
                      )}
                      {characterCard.alternate_greetings.map((greeting, index) => (
                        <option key={index} value={index}>
                          {greetingLabel(greeting, `可选开场白 ${index + 1}`)}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    className="chat-card-greeting-btn"
                    disabled={inputLocked || !selectedGreetingText()}
                    onClick={() => handleApplyGreeting(canApplyOpening)}
                  >
                    {cardHasGameStart && selectedGreetingIndex === -1 ? '打开角色卡首页' : '应用开场白'}
                  </button>
                </div>
              )}
            </div>
            {characterCard.tags.length > 0 && (
              <div className="chat-card-tags">
                {characterCard.tags.slice(0, 8).map((tag, index) => (
                  <span key={`${tag}-${index}`}>{tag}</span>
                ))}
              </div>
            )}
            {!cardHasComplexUi && (characterCard.description || characterCard.personality || characterCard.scenario) && (
              <div className="chat-card-summary">
                {characterCard.description && <p>{shortText(characterCard.description)}</p>}
                {characterCard.personality && <p>{shortText(characterCard.personality)}</p>}
                {characterCard.scenario && <p>{shortText(characterCard.scenario)}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {sessionState?.variables && !cardHasStatusRenderer && flatVariables.length > 0 && (
        <details
          className={`status-panel ${cardHasComplexUi ? 'debug' : ''}`}
          open={!cardHasComplexUi || showVariableDebug}
          onToggle={(event) => {
            if (cardHasComplexUi) setShowVariableDebug(event.currentTarget.open);
          }}
        >
          <summary className="status-panel-header">
            <span>{cardHasComplexUi ? `变量调试 (${flatVariables.length})` : '状态变量'}</span>
            <button className="status-refresh-btn" onClick={(event) => { event.preventDefault(); loadSessionState(); }}>刷新</button>
          </summary>
          {(!cardHasComplexUi || showVariableDebug) && (
            <div className="status-grid">
              {flatVariables.slice(0, cardHasComplexUi ? 12 : 24).map(item => (
                <div className="status-var" key={item.key}>
                  <span className="status-var-key">{item.key}</span>
                  <span className="status-var-value">{formatVariableValue(item.value)}</span>
                </div>
              ))}
            </div>
          )}
        </details>
      )}

      <div className="messages">
        {messages.map(msg => {
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
                      <MessageContent
                        content={msg.content}
                        card={characterCard}
                        variables={sessionState?.variables || {}}
                        onSandboxAction={(event) => handleSandboxAction(event, canApplyOpening, setShowVariableDebug)}
                        renderMode={renderMode}
                      />
                    )
                  ) : (
                    cleanCardDisplayText(msg.content)
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
        {agentStatuses.length > 0 && (
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
        {streamError && streaming && (
          <div className="message assistant streaming">
            <div className="message-role">助手</div>
            <div className="message-content">
              <span className="stream-error-indicator">{streamError}</span>
            </div>
          </div>
        )}
        {streamText && (
          <div className="message assistant streaming">
            <div className="message-role">助手</div>
            <div className="message-content">
              <MessageContent
                content={streamText}
                card={characterCard}
                variables={sessionState?.variables || {}}
                onSandboxAction={(event) => handleSandboxAction(event, canApplyOpening, setShowVariableDebug)}
                renderMode={renderMode}
              />
            </div>
          </div>
        )}
        {memoryPending && (
          <div className="message assistant streaming">
            <div className="message-role">进度</div>
            <div className="message-content">
              <span className="recovering-indicator">正在整理记忆...</span>
            </div>
          </div>
        )}
        {stateUpdating && !memoryPending && (
          <div className="message assistant streaming">
            <div className="message-role">进度</div>
            <div className="message-content">
              <span className="recovering-indicator">正在更新变量...</span>
            </div>
          </div>
        )}
        {(streaming || recovering) && !streamText && agentStatuses.length === 0 && !streamError && !memoryPending && !stateUpdating && (
          <div className="message assistant streaming">
            <div className="message-role">助手</div>
            <div className="message-content">
              <span className="recovering-indicator">正在处理中...</span>
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
          placeholder={memoryPending ? '正在整理记忆...' : recovering ? '等待后端响应中...' : '输入消息...'}
          rows={3}
          disabled={inputLocked}
        />
        <button onClick={() => handleSend()} disabled={inputLocked || !input.trim()}>
          {memoryPending ? '整理中...' : streaming ? '发送中...' : recovering ? '等待中...' : '发送'}
        </button>
      </div>
    </div>
    </div>{/* .chat-main */}

    <InspectorSidebar
      inspectorOpen={inspectorOpen}
      inspectorTab={inspectorTab}
      setInspectorTab={setInspectorTab}
      setInspectorOpen={setInspectorOpen}
      paramsEditing={paramsEditing}
      setParamsEditing={setParamsEditing}
      userEditing={userEditing}
      setUserEditing={setUserEditing}
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
      cardHasComplexUi={cardHasComplexUi}
      cardHasGameStart={cardHasGameStart}
      debugPlatformSchema={debugPlatformSchema}
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
    </div>
  );
}
