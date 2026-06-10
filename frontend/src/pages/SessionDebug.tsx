import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../api/client';
import type {
  AgentDebugSnapshot,
  CharacterCard,
  DebugMessage,
  DebugTurnSummary,
  Message,
  Session,
} from '../api/types';
import { buildStatusSchema } from './card-schema-builders';
import {
  assessStateContractQuality,
  buildStateDiagnosticSummary,
  explainStateDiagnostic,
  findClosestStatePaths,
  summarizeStateContract,
} from './state-debug';
import { ToolRail } from './components/ToolRail';
import type { InspectorTab } from './components/InspectorSidebar';
import '../styles/chat.css';

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

function flattenVariables(value: any, prefix = ''): Array<{ key: string; value: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const rows: Array<{ key: string; value: unknown }> = [];
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

function mergeDebugMessages(messages: DebugMessage[], fullMessages: Message[]): DebugMessage[] {
  const metadataById = new Map(fullMessages.map(message => [message.id, message]));
  return messages.map(message => metadataById.get(message.id) || message);
}

function summarizeOpeningState(variables: any): { title: string; detail: string } {
  const rows = flattenVariables(variables);
  if (rows.length === 0) {
    return {
      title: '变量仍为空',
      detail: '当前 sessionState.variables 还是空对象，适合继续对照 opening 内容与初始化结果。',
    };
  }

  const highlighted = rows
    .slice(0, 3)
    .map(row => `${row.key}=${shortText(String(row.value ?? ''), 18)}`)
    .join(' · ');

  return {
    title: `已读到 ${rows.length} 个变量`,
    detail: highlighted,
  };
}

function summarizeAdapterMeta(adapterMeta: any): { title: string; detail: string } {
  if (!adapterMeta || typeof adapterMeta !== 'object') {
    return {
      title: '未暴露运行时适配器元数据',
      detail: '当前 session state 里还没有 _card_state_adapter，通常说明还没经过规范化状态初始化。',
    };
  }

  const writable = Array.isArray(adapterMeta.writable_platform_paths)
    ? adapterMeta.writable_platform_paths.length
    : 0;
  const manualReview = Array.isArray(adapterMeta.manual_review_card_paths)
    ? adapterMeta.manual_review_card_paths.length
    : 0;
  const mapped = Number(adapterMeta.mapped_field_count || 0);
  const source = String(adapterMeta.source || 'unknown');

  return {
    title: `${source} · ${writable} 可写 / ${manualReview} 审查`,
    detail: `mapped ${mapped} · ${adapterMeta.platform_state_empty ? 'platform_state 为空' : 'platform_state 已初始化'}`,
  };
}

function summarizeStateLayer(value: any, emptyLabel: string): { title: string; detail: string; count: number } {
  const rows = flattenVariables(value).slice(0, 3);
  const total = flattenVariables(value).length;
  if (total === 0) {
    return {
      title: emptyLabel,
      detail: '当前没有可展示路径。',
      count: 0,
    };
  }
  return {
    title: `已读到 ${total} 条路径`,
    detail: rows.map(row => `${row.key}=${shortText(String(row.value ?? ''), 18)}`).join(' · '),
    count: total,
  };
}

export default function SessionDebug() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [characterCard, setCharacterCard] = useState<CharacterCard | null>(null);
  const [sessionState, setSessionState] = useState<any>({});
  const [drawerTab, setDrawerTab] = useState<InspectorTab>('debug');
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
        const [overview, sessionData, stateData, messageData] = await Promise.all([
          api.getSessionDebugOverview(sessionId),
          api.getSession(sessionId),
          api.getSessionState(sessionId),
          api.listMessages(sessionId),
        ]);
        const cardData = sessionData.world_pack_id
          ? await api.getWorldBookCharacterCard(sessionData.world_pack_id).catch(() => null)
          : null;
        if (cancelled) return;
        const nextMessages = mergeDebugMessages(overview.messages || [], messageData.items || []);
        const nextTurns = overview.turns || [];
        const initialTurn = latestDebugTurn(nextTurns, nextMessages);
        setSession(sessionData);
        setCharacterCard(cardData);
        setSessionState(stateData || {});
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
    return () => {
      cancelled = true;
    };
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
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedTurn]);

  const selectedSnapshot = snapshots.find(item => item.id === selectedSnapshotId) || snapshots[0] || null;
  const currentMessages = turnMessages(messages, selectedTurn);
  const totalCalls = turns.reduce((sum, turn) => sum + turn.call_count, 0);
  const totalTokens = turns.reduce((sum, turn) => sum + turn.total_prompt_tokens + turn.total_completion_tokens, 0);
  const openingMessage = useMemo(
    () => messages.find(message => message.turn_number === 0 && message.role === 'assistant') || null,
    [messages],
  );
  const projectionVariables = sessionState?.variables && typeof sessionState.variables === 'object'
    ? sessionState.variables
    : {};
  const platformState = sessionState?.platform_state && typeof sessionState.platform_state === 'object'
    ? sessionState.platform_state
    : {};
  const writableState = sessionState?._state_agent_writable && typeof sessionState._state_agent_writable === 'object'
    ? sessionState._state_agent_writable
    : {};
  const topVariableRows = useMemo(
    () => flattenVariables(projectionVariables).slice(0, 18),
    [projectionVariables],
  );
  const adapterMeta = sessionState?._card_state_adapter && typeof sessionState._card_state_adapter === 'object'
    ? sessionState._card_state_adapter
    : null;
  const openingStateSummary = useMemo(
    () => summarizeOpeningState(projectionVariables),
    [projectionVariables],
  );
  const adapterMetaSummary = useMemo(
    () => summarizeAdapterMeta(adapterMeta),
    [adapterMeta],
  );
  const projectionSummary = useMemo(
    () => summarizeStateLayer(projectionVariables, 'projection variables 为空'),
    [projectionVariables],
  );
  const platformSummary = useMemo(
    () => summarizeStateLayer(platformState, 'platform_state 为空'),
    [platformState],
  );
  const writableSummary = useMemo(
    () => summarizeStateLayer(writableState, '_state_agent_writable 为空'),
    [writableState],
  );
  const statusSchema = useMemo(
    () => buildStatusSchema(characterCard),
    [characterCard],
  );
  const stateDiagnostic = useMemo(
    () => buildStateDiagnosticSummary({ variables: projectionVariables, card: characterCard, schema: statusSchema }),
    [projectionVariables, characterCard, statusSchema],
  );
  const contractSummary = useMemo(
    () => summarizeStateContract(characterCard),
    [characterCard],
  );
  const contractQuality = useMemo(
    () => assessStateContractQuality({ card: characterCard, variables: projectionVariables, stateDiagnostic }),
    [characterCard, projectionVariables, stateDiagnostic],
  );
  const explainabilityIssues = useMemo(
    () => explainStateDiagnostic({
      card: characterCard,
      variables: projectionVariables,
      stateDiagnostic,
      contractQuality,
    }),
    [characterCard, projectionVariables, stateDiagnostic, contractQuality],
  );
  if (loading) return <div className="session-debug loading">加载调试台...</div>;

  return (
    <div className="chat-layout session-debug-layout">
      <ToolRail
        activeTab={drawerTab}
        onTabClick={(tab) => {
          if (tab === 'debug') return;
          setDrawerTab(tab);
          navigate(`/chat/${sessionId}`);
        }}
        sessionMode={session?.mode || 'single_agent'}
        sessionId={sessionId}
      />

      <main className="render-zone session-debug-zone">
        <div className="render-topbar debug-render-topbar">
          <div className="render-topbar-left">
            <span className="render-topbar-title">{session?.title || '未命名会话'}</span>
            <span className="debug-route-badge">调试台</span>
          </div>
          <button className="debug-back-btn" onClick={() => navigate(`/chat/${sessionId}`)}>返回对话</button>
        </div>

        <div className="session-debug">
          <header className="debug-topbar">
            <div>
              <h1>会话调试台</h1>
              <p>消息数据库、Agent 调用现场、开场白与状态初始化，放在同一张工作台上看。</p>
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

          <section className="debug-overview-strip">
            <article className="debug-overview-card">
              <div className="panel-title">Opening</div>
              <strong>{openingMessage ? '已写入开场白消息' : '尚未写入开场白消息'}</strong>
              <p>{openingMessage ? shortText(openingMessage.content, 160) : '当前 session 还没有 turn 0 assistant opening。'}</p>
            </article>
            <article className="debug-overview-card">
              <div className="panel-title">State Init</div>
              <strong>{openingStateSummary.title}</strong>
              <p>{openingStateSummary.detail}</p>
            </article>
            <article className="debug-overview-card">
              <div className="panel-title">State Contract</div>
              <strong>
                {stateDiagnostic.matchedChecks}/{stateDiagnostic.totalChecks || 0} 路径命中
              </strong>
              <p>
                schema {contractSummary.packageStateFields} · leaf {contractQuality.declaredLeafLikeFields} · runtime leaf {contractQuality.runtimeLeafPaths}
              </p>
            </article>
            <article className="debug-overview-card">
              <div className="panel-title">Explainability</div>
              <strong>{explainabilityIssues.length} 条解释</strong>
              <p>
                {explainabilityIssues[0]?.title || '当前没有额外解释型诊断。'}
              </p>
            </article>
            <article className="debug-overview-card">
              <div className="panel-title">Adapter Meta</div>
              <strong>{adapterMetaSummary.title}</strong>
              <p>{adapterMetaSummary.detail}</p>
            </article>
            <article className="debug-overview-card">
              <div className="panel-title">Writable View</div>
              <strong>{writableSummary.title}</strong>
              <p>{writableSummary.detail}</p>
            </article>
            <article className="debug-overview-card">
              <div className="panel-title">Session</div>
              <strong>{session?.status || 'unknown'}</strong>
              <p>{session?.mode || 'single_agent'} · turn {session?.current_turn ?? 0} · {topVariableRows.length} 个变量预览</p>
            </article>
          </section>

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

              <div className="panel-title">State Diagnostics</div>
              <div className="message-db-list">
                {stateDiagnostic.totalChecks === 0 ? (
                  <div className="debug-empty">当前卡没有可推导的状态依赖，先展示纯变量总览。</div>
                ) : (
                  stateDiagnostic.rows.slice(0, 14).map((row) => (
                    <article key={`${row.source}:${row.path}`} className={`debug-message ${row.exists ? 'assistant' : 'user'}`}>
                      <div>
                        <strong>{row.exists ? 'hit' : 'miss'}</strong>
                        <span>{row.source}</span>
                      </div>
                      <p>{row.path}</p>
                      <small>{row.role} · {row.resolution === 'projection_alias' ? `alias -> ${row.resolvedPath || '(root)'}` : row.preview}</small>
                    </article>
                  ))
                )}
              </div>

              <div className="panel-title">Contract Quality</div>
              <div className="message-db-list">
                {contractQuality.issues.length === 0 ? (
                  <div className="debug-empty">当前状态契约结构完整，可以继续做细粒度绑定验证。</div>
                ) : (
                  contractQuality.issues.map((issue, index) => (
                    <article key={`${issue}-${index}`} className="debug-message user">
                      <div>
                        <strong>issue</strong>
                        <span>contract</span>
                      </div>
                      <p>{issue}</p>
                      <small>
                        {contractQuality.canVerifyFineGrainedBindings ? '可做字段级验证' : '仅能做根级验证'}
                      </small>
                    </article>
                  ))
                )}
              </div>

              <div className="panel-title">Explainability</div>
              <div className="message-db-list">
                {explainabilityIssues.length === 0 ? (
                  <div className="debug-empty">当前没有额外解释型诊断，状态契约和运行时路径基本一致。</div>
                ) : (
                  explainabilityIssues.slice(0, 12).map((issue, index) => (
                    <article key={`${issue.kind}-${issue.path || index}`} className="debug-message user">
                      <div>
                        <strong>{issue.kind}</strong>
                        <span>{issue.path || 'contract'}</span>
                      </div>
                      <p>{issue.title}</p>
                      <small>{issue.detail}</small>
                    </article>
                  ))
                )}
              </div>

              <div className="panel-title">Adapter Meta</div>
              <div className="message-db-list">
                {!adapterMeta ? (
                  <div className="debug-empty">当前 session state 里没有 _card_state_adapter。</div>
                ) : (
                  <>
                    <article className="debug-message assistant">
                      <div>
                        <strong>source</strong>
                        <span>{String(adapterMeta.source || 'unknown')}</span>
                      </div>
                      <p>{String(adapterMeta.adapter_version || 'unknown')}</p>
                      <small>{String(adapterMeta.source_format || 'unknown')}</small>
                    </article>
                    <article className="debug-message assistant">
                      <div>
                        <strong>writable</strong>
                        <span>{Array.isArray(adapterMeta.writable_platform_paths) ? adapterMeta.writable_platform_paths.length : 0}</span>
                      </div>
                      <p>
                        {Array.isArray(adapterMeta.writable_platform_paths) && adapterMeta.writable_platform_paths.length > 0
                          ? adapterMeta.writable_platform_paths.slice(0, 4).join(' · ')
                          : '没有可写 canonical path'}
                      </p>
                      <small>{adapterMeta.platform_state_empty ? 'platform_state 为空' : 'platform_state 已初始化'}</small>
                    </article>
                    <article className="debug-message user">
                      <div>
                        <strong>manual_review</strong>
                        <span>{Array.isArray(adapterMeta.manual_review_card_paths) ? adapterMeta.manual_review_card_paths.length : 0}</span>
                      </div>
                      <p>
                        {Array.isArray(adapterMeta.manual_review_card_paths) && adapterMeta.manual_review_card_paths.length > 0
                          ? adapterMeta.manual_review_card_paths.slice(0, 4).join(' · ')
                          : '没有 manual review 路径'}
                      </p>
                      <small>{Array.isArray(adapterMeta.warnings) ? adapterMeta.warnings.slice(0, 2).join(' · ') || '无额外 warning' : '无额外 warning'}</small>
                    </article>
                  </>
                )}
              </div>

              <div className="panel-title">State Layers</div>
              <div className="message-db-list">
                <article className="debug-message assistant">
                  <div>
                    <strong>variables</strong>
                    <span>{projectionSummary.count}</span>
                  </div>
                  <p>{projectionSummary.title}</p>
                  <small>{projectionSummary.detail}</small>
                </article>
                <article className="debug-message assistant">
                  <div>
                    <strong>platform_state</strong>
                    <span>{platformSummary.count}</span>
                  </div>
                  <p>{platformSummary.title}</p>
                  <small>{platformSummary.detail}</small>
                </article>
                <article className="debug-message assistant">
                  <div>
                    <strong>_state_agent_writable</strong>
                    <span>{writableSummary.count}</span>
                  </div>
                  <p>{writableSummary.title}</p>
                  <small>{writableSummary.detail}</small>
                </article>
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
              <StateDiagnosticDetail
                stateDiagnostic={stateDiagnostic}
                contractSummary={contractSummary}
                contractQuality={contractQuality}
                explainabilityIssues={explainabilityIssues}
                adapterMeta={adapterMeta}
                projectionVariables={projectionVariables}
                platformState={platformState}
                writableState={writableState}
              />
              {!selectedSnapshot ? (
                <div className="debug-empty">选择一个 Agent 调用查看实际注入内容。</div>
              ) : (
                <AgentSnapshotDetail snapshot={selectedSnapshot} variables={topVariableRows} />
              )}
            </section>
          </main>
        </div>
      </main>
    </div>
  );
}

function StateDiagnosticDetail({
  stateDiagnostic,
  contractSummary,
  contractQuality,
  explainabilityIssues,
  adapterMeta,
  projectionVariables,
  platformState,
  writableState,
}: {
  stateDiagnostic: ReturnType<typeof buildStateDiagnosticSummary>;
  contractSummary: ReturnType<typeof summarizeStateContract>;
  contractQuality: ReturnType<typeof assessStateContractQuality>;
  explainabilityIssues: ReturnType<typeof explainStateDiagnostic>;
  adapterMeta: any;
  projectionVariables: any;
  platformState: any;
  writableState: any;
}) {
  const missingRows = stateDiagnostic.rows.filter((row) => !row.exists);
  return (
    <div className="snapshot-detail">
      <div className="snapshot-hero">
        <div>
          <span>state diagnostic</span>
          <h2>状态依赖诊断</h2>
          <p>{stateDiagnostic.matchedChecks} 命中 / {stateDiagnostic.totalChecks} 检查</p>
        </div>
        <div>
          <strong>{stateDiagnostic.missingChecks}</strong>
          <span>missing</span>
        </div>
      </div>

      <details open>
        <summary>Contract Summary</summary>
        <pre>{formatJson(contractSummary)}</pre>
      </details>

      <details open>
        <summary>Contract Quality</summary>
        <pre>{formatJson(contractQuality)}</pre>
      </details>

      <details open>
        <summary>Missing Paths ({missingRows.length})</summary>
        <pre>{formatJson(missingRows.map((row) => ({
          ...row,
          closest_paths: findClosestStatePaths(projectionVariables, row.path),
        })))}</pre>
      </details>

      <details open>
        <summary>Explainability ({explainabilityIssues.length})</summary>
        <pre>{formatJson(explainabilityIssues)}</pre>
      </details>

      <details open>
        <summary>Adapter Meta</summary>
        <pre>{formatJson(adapterMeta)}</pre>
      </details>

      <details open>
        <summary>Projection Variables</summary>
        <pre>{formatJson(projectionVariables)}</pre>
      </details>

      <details open>
        <summary>Platform State</summary>
        <pre>{formatJson(platformState)}</pre>
      </details>

      <details open>
        <summary>State Agent Writable View</summary>
        <pre>{formatJson(writableState)}</pre>
      </details>

      <details>
        <summary>All Diagnostic Checks ({stateDiagnostic.rows.length})</summary>
        <pre>{formatJson(stateDiagnostic.rows)}</pre>
      </details>
    </div>
  );
}

function AgentSnapshotDetail({
  snapshot,
  variables,
}: {
  snapshot: AgentDebugSnapshot;
  variables: Array<{ key: string; value: unknown }>;
}) {
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
        <summary>Current Session Variables ({variables.length})</summary>
        <pre>{formatJson(variables)}</pre>
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
