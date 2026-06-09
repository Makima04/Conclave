import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../api/client';
import type { AgentDebugSnapshot, DebugMessage, DebugTurnSummary } from '../api/types';
import '../styles/session-debug.css';

function shortText(value: string, max = 120): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnMessages(messages: DebugMessage[], turn: number): DebugMessage[] {
  return messages.filter(message => message.turn_number === turn);
}

function latestDebugTurn(turns: DebugTurnSummary[], messages: DebugMessage[]): number {
  if (turns.length > 0) return turns[turns.length - 1].turn_number;
  const numbered = messages.map(message => message.turn_number).filter(turn => turn > 0);
  return numbered.length > 0 ? Math.max(...numbered) : 0;
}

export default function SessionDebug() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<DebugMessage[]>([]);
  const [turns, setTurns] = useState<DebugTurnSummary[]>([]);
  const [selectedTurn, setSelectedTurn] = useState<number>(0);
  const [snapshots, setSnapshots] = useState<AgentDebugSnapshot[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadOverview() {
      if (!sessionId) return;
      setLoading(true);
      setError(null);
      try {
        const overview = await api.getSessionDebugOverview(sessionId);
        if (cancelled) return;
        const nextMessages = overview.messages || [];
        const nextTurns = overview.turns || [];
        const initialTurn = latestDebugTurn(nextTurns, nextMessages);
        setMessages(nextMessages);
        setTurns(nextTurns);
        setSelectedTurn(initialTurn);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || '加载调试数据失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadOverview();
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    async function loadTurn() {
      if (!sessionId || selectedTurn <= 0) {
        setSnapshots([]);
        setSelectedSnapshotId(null);
        return;
      }
      setDetailLoading(true);
      try {
        const detail = await api.getSessionDebugTurn(sessionId, selectedTurn);
        if (cancelled) return;
        const items = detail.items || [];
        setSnapshots(items);
        setSelectedSnapshotId(items[0]?.id || null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || '加载本轮 Agent 快照失败');
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }
    loadTurn();
    return () => { cancelled = true; };
  }, [sessionId, selectedTurn]);

  const selectedSnapshot = snapshots.find(item => item.id === selectedSnapshotId) || snapshots[0] || null;
  const currentMessages = turnMessages(messages, selectedTurn);
  const totalCalls = turns.reduce((sum, turn) => sum + turn.call_count, 0);
  const totalTokens = turns.reduce((sum, turn) => sum + turn.total_prompt_tokens + turn.total_completion_tokens, 0);

  if (loading) return <div className="session-debug loading">加载调试台...</div>;

  return (
    <div className="session-debug">
      <header className="debug-topbar">
        <button className="debug-back-btn" onClick={() => navigate(`/chat/${sessionId}`)}>返回对话</button>
        <div>
          <h1>会话调试台</h1>
          <p>消息数据库、Agent 调用现场、预设与世界书注入，一起摊开看。</p>
        </div>
        <div className="debug-metrics">
          <div><span>消息</span><strong>{messages.length}</strong></div>
          <div><span>快照轮</span><strong>{turns.length}</strong></div>
          <div><span>调用</span><strong>{totalCalls}</strong></div>
          <div><span>Tokens</span><strong>{totalTokens}</strong></div>
        </div>
      </header>

      {error && (
        <div className="debug-error">
          <span>{error}</span>
          <button onClick={() => window.location.reload()}>刷新</button>
        </div>
      )}

      <main className="debug-grid">
        <aside className="debug-panel turn-panel">
          <div className="panel-title">Turn Timeline</div>
          <div className="turn-list">
            {turns.length === 0 ? (
              <div className="debug-empty">还没有 Agent 快照。发送一轮 multi-agent 消息后这里会开始记录。</div>
            ) : (
              turns.map(turn => (
                <button
                  key={turn.turn_number}
                  className={`turn-card${selectedTurn === turn.turn_number ? ' active' : ''}`}
                  onClick={() => setSelectedTurn(turn.turn_number)}
                >
                  <strong>第 {turn.turn_number} 轮</strong>
                  <span>{turn.call_count} calls · {turn.agent_count} agents</span>
                  <small>{turn.total_prompt_tokens}/{turn.total_completion_tokens} tokens · {turn.total_duration_ms}ms</small>
                </button>
              ))
            )}
          </div>

          <div className="panel-title">Messages</div>
          <div className="message-db-list">
            {currentMessages.length === 0 ? (
              <div className="debug-empty">当前轮没有消息记录。</div>
            ) : (
              currentMessages.map(message => (
                <article key={message.id} className={`debug-message ${message.role}`}>
                  <div>
                    <strong>{message.role}</strong>
                    <span>T{message.turn_number}</span>
                  </div>
                  <p>{shortText(message.content, 220)}</p>
                </article>
              ))
            )}
          </div>
        </aside>

        <section className="debug-panel call-panel">
          <div className="panel-title">Agent Calls</div>
          {detailLoading ? (
            <div className="debug-empty">读取本轮快照中...</div>
          ) : snapshots.length === 0 ? (
            <div className="debug-empty">这一轮没有 agent 调用快照。旧消息在功能上线前生成的话，也会没有现场记录。</div>
          ) : (
            <div className="agent-call-list">
              {snapshots.map(snapshot => (
                <button
                  key={snapshot.id}
                  className={`agent-call-card${selectedSnapshot?.id === snapshot.id ? ' active' : ''}`}
                  onClick={() => setSelectedSnapshotId(snapshot.id)}
                >
                  <div className="agent-call-head">
                    <span className="level-badge">{snapshot.level_index == null ? 'fallback' : `L${snapshot.level_index}`}</span>
                    <strong>{snapshot.agent_label || snapshot.agent_id || snapshot.agent_type}</strong>
                    <em>{snapshot.agent_type}</em>
                  </div>
                  <p>{shortText(snapshot.task, 150)}</p>
                  <div className="agent-call-stats">
                    <span>{snapshot.prompt_tokens}/{snapshot.completion_tokens} tok</span>
                    <span>{snapshot.duration_ms ?? 0}ms</span>
                    <span>{snapshot.preset_modules.length} preset</span>
                    <span>{snapshot.worldbook_entries.length} wb</span>
                    <span>{snapshot.injected_outputs.length} inject</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="debug-panel detail-panel">
          <div className="panel-title">Inspector</div>
          {!selectedSnapshot ? (
            <div className="debug-empty">选择一个 Agent 调用查看实际注入内容。</div>
          ) : (
            <AgentSnapshotDetail snapshot={selectedSnapshot} />
          )}
        </section>
      </main>
    </div>
  );
}

function AgentSnapshotDetail({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  return (
    <div className="snapshot-detail">
      <div className="snapshot-hero">
        <div>
          <span>{snapshot.agent_type}</span>
          <h2>{snapshot.agent_label || snapshot.agent_id || 'Unnamed Agent'}</h2>
          <p>{snapshot.model}</p>
        </div>
        <div>
          <strong>{snapshot.prompt_tokens + snapshot.completion_tokens}</strong>
          <span>tokens</span>
        </div>
      </div>

      <details open>
        <summary>Task / User Prompt</summary>
        <pre>{snapshot.user_prompt}</pre>
      </details>
      <details>
        <summary>System Prompt</summary>
        <pre>{snapshot.system_prompt}</pre>
      </details>
      <details open>
        <summary>Injected Outputs ({snapshot.injected_outputs.length})</summary>
        <pre>{formatJson(snapshot.injected_outputs)}</pre>
      </details>
      <details>
        <summary>Preset Modules ({snapshot.preset_modules.length})</summary>
        <pre>{formatJson(snapshot.preset_modules)}</pre>
      </details>
      <details>
        <summary>Worldbook Entries ({snapshot.worldbook_entries.length})</summary>
        <pre>{formatJson(snapshot.worldbook_entries)}</pre>
      </details>
      <details>
        <summary>Recent Messages ({snapshot.recent_messages.length})</summary>
        <pre>{formatJson(snapshot.recent_messages)}</pre>
      </details>
      <details>
        <summary>State Slice</summary>
        <pre>{formatJson(snapshot.state_slice)}</pre>
      </details>
      <details open>
        <summary>Raw Output</summary>
        <pre>{snapshot.raw_output}</pre>
      </details>
      {snapshot.tool_calls.length > 0 && (
        <details open>
          <summary>Tool Calls</summary>
          <pre>{formatJson(snapshot.tool_calls)}</pre>
        </details>
      )}
    </div>
  );
}
