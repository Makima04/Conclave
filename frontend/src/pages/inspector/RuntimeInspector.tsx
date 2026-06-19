import { useCallback, useEffect, useState } from 'react';
import * as api from '../../api/client';
import type { AgentDebugSnapshot, DebugTurnSummary } from '../../api/types';
import { AgentCard } from './AgentCard';

function orderForFlow(s: AgentDebugSnapshot): number {
  // master at the head, then by level_index ascending.
  if (s.phase === 'master' || s.agent_type === 'master') return -1;
  return s.level_index ?? 99;
}

export function RuntimeInspector({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<DebugTurnSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [snapshots, setSnapshots] = useState<AgentDebugSnapshot[]>([]);
  const [loadingTurns, setLoadingTurns] = useState(true);
  const [loadingSnap, setLoadingSnap] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingTurns(true);
    setError(null);
    api
      .getSessionDebugOverview(sessionId)
      .then(res => {
        if (cancelled) return;
        const list = (res.turns || []).slice().sort((a, b) => b.turn_number - a.turn_number);
        setTurns(list);
        if (list.length > 0) setSelected(list[0].turn_number);
      })
      .catch(e => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoadingTurns(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const loadTurn = useCallback(
    (turn: number) => {
      setLoadingSnap(true);
      setError(null);
      api
        .getSessionDebugTurn(sessionId, turn)
        .then(res => setSnapshots(res.items || []))
        .catch(e => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoadingSnap(false));
    },
    [sessionId],
  );

  useEffect(() => {
    if (selected != null) loadTurn(selected);
  }, [selected, loadTurn]);

  const flow = snapshots.slice().sort((a, b) => orderForFlow(a) - orderForFlow(b));

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="inspector-body">
      <aside className="insp-turn-list">
        {loadingTurns && <p className="insp-empty">加载轮次…</p>}
        {!loadingTurns && turns.length === 0 && <p className="insp-empty">暂无运行轮次</p>}
        {turns.map(t => (
          <div
            key={t.turn_number}
            className={`insp-turn-item${selected === t.turn_number ? ' active' : ''}`}
            onClick={() => setSelected(t.turn_number)}
          >
            <div className="insp-turn-head">
              <span className="insp-turn-no">第 {t.turn_number} 轮</span>
              <span className="insp-turn-meta">{t.agent_count} agent · {t.call_count} call</span>
            </div>
            <div className="insp-turn-stats">
              <span>↑{t.total_prompt_tokens}</span>
              <span>↓{t.total_completion_tokens}</span>
              {t.total_cached_tokens > 0 && t.total_prompt_tokens > 0 && (
                <span title="prompt cache 命中 token / 占输入比例">
                  cache {t.total_cached_tokens} ({Math.round((t.total_cached_tokens / t.total_prompt_tokens) * 100)}%)
                </span>
              )}
              <span>{t.total_duration_ms}ms</span>
            </div>
          </div>
        ))}
      </aside>

      <main className="insp-main">
        {error && <div className="insp-error">{error}</div>}
        {selected == null && !loadingTurns && <p className="insp-empty">选择左侧轮次查看 agent 运行详情</p>}
        {loadingSnap && <p className="insp-empty">加载快照…</p>}
        {!loadingSnap && snapshots.length > 0 && (
          <>
            <div className="turn-flow">
              {flow.map((s, i) => {
                const isMaster = s.phase === 'master' || s.agent_type === 'master';
                const cardId = `agent-card-${s.id}`;
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
                    <div className={`turn-flow-node${isMaster ? ' master' : ''}`} onClick={() => scrollTo(cardId)} title={s.task}>
                      <span className="tfn-type">{s.agent_type}</span>
                      <span className="tfn-label">{s.agent_label || s.agent_id?.slice(0, 6)}</span>
                    </div>
                    {i < flow.length - 1 && <span className="turn-flow-arrow">→</span>}
                  </div>
                );
              })}
            </div>
            {flow.map(s => (
              <div key={s.id} id={`agent-card-${s.id}`}>
                <AgentCard snapshot={s} />
              </div>
            ))}
          </>
        )}
        {!loadingSnap && snapshots.length === 0 && selected != null && (
          <p className="insp-empty">该轮无快照</p>
        )}
      </main>
    </div>
  );
}
