import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type { AgentDebugSnapshot, MasterPlan } from '../../api/types';

/**
 * 输出渲染器注册表 —— 异构性收口点。
 * 每个 agent_type 产出的 raw_output 结构不同，按类型 dispatch 到对应渲染器；
 * 解析失败一律兜底 RawTextView（遵循"通用兼容、不硬假设格式"原则）。
 */

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // 容忍前后被 markdown ``` 包裹 / 多余文字：截第一个 { 到最后一个 }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function RawTextView({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const text = snapshot.raw_output || '(空输出)';
  return <pre className="prompt-pre">{text}</pre>;
}

export function NarrativeView({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const text = snapshot.raw_output || '(空输出)';
  return <div className="narrative-body">{text}</div>;
}

export function MasterPlanView({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const plan = useMemo<MasterPlan | null>(() => {
    const parsed = tryParseJson(snapshot.raw_output);
    if (parsed && typeof parsed === 'object') return parsed as MasterPlan;
    return null;
  }, [snapshot.raw_output]);

  if (!plan) return <RawTextView snapshot={snapshot} />;

  const calls = plan.calls || [];
  const lifecycle = plan.lifecycle || [];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span className="insp-chip">调用 {calls.length}</span>
        <span className="insp-chip">生命周期 {lifecycle.length}</span>
        {plan.user_auto && <span className="insp-chip">用户自动代理</span>}
        {plan.final_writer_id && <span className="insp-chip">最终写手: {plan.final_writer_id}</span>}
      </div>
      {calls.length > 0 && (
        <Section title="调用计划 (calls)" defaultOpen>
          <div className="plan-calls">
            {calls.map((c, i) => (
              <div key={i} className="plan-call">
                <span className="plan-tag">→ {c.agent_id}</span>
                {c.task}
                {c.inject_from && c.inject_from.length > 0 && (
                  <span className="plan-inject">注入自: {c.inject_from.join(', ')}</span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
      {lifecycle.length > 0 && (
        <Section title="生命周期 (lifecycle)" defaultOpen>
          <div className="plan-life-list">
            {lifecycle.map((a, i) => (
              <div key={i} className="plan-life">
                <span className="plan-tag">{a.action}{a.agent_type ? ` · ${a.agent_type}` : ''}{a.label ? ` · ${a.label}` : ''}</span>
                {a.reason || a.context || ''}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/** parser 输出：可能是结构化意图 JSON，也可能是文本 —— 先尝试 JSON，失败走文本。 */
export function ParsedIntentView({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const parsed = useMemo(() => tryParseJson(snapshot.raw_output), [snapshot.raw_output]);
  if (!parsed || typeof parsed !== 'object') return <NarrativeView snapshot={snapshot} />;
  const obj = parsed as Record<string, unknown>;
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return <NarrativeView snapshot={snapshot} />;
  return (
    <div className="state-diff">
      {entries.map(([k, v]) => (
        <div key={k} className="state-diff-row add">
          <strong style={{ opacity: 0.7 }}>{k}:</strong> {Array.isArray(v) ? v.join(', ') : String(v)}
        </div>
      ))}
    </div>
  );
}

/** state 输出：StateChangeProposal（可能 JSON），失败兜底文本。 */
export function StateDiffView({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const parsed = useMemo(() => tryParseJson(snapshot.raw_output), [snapshot.raw_output]);
  if (!parsed || typeof parsed !== 'object') return <NarrativeView snapshot={snapshot} />;
  const candidates = (parsed as { changes?: unknown[] }).changes;
  if (!Array.isArray(candidates)) return <RawTextView snapshot={snapshot} />;
  return (
    <div className="state-diff">
      {candidates.map((c, i) => {
        const item = c as Record<string, unknown>;
        const op = String(item.operation || item.action || 'set');
        return (
          <div key={i} className={`state-diff-row ${op === 'delete' ? 'del' : 'add'}`}>
            <strong style={{ opacity: 0.7 }}>{op}</strong> {String(item.path || item.key || item.target || '')}
            {item.value != null ? ` = ${JSON.stringify(item.value)}` : ''}
          </div>
        );
      })}
    </div>
  );
}

/** 局部可折叠节（master 计划等复杂渲染器内部用）。 */
export function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`insp-section${open ? '' : ' is-collapsed'}`}>
      <div className="section-divider" onClick={() => setOpen(o => !o)}>
        <span className="section-divider-line" />
        <span className="section-divider-dot">·</span>
        <span className="section-label">{title}</span>
        {count != null && <span className="section-count">{count}</span>}
        <span className="section-divider-dot">·</span>
        <span className="section-divider-line" />
      </div>
      <div className="insp-section-body">{children}</div>
    </div>
  );
}

const OUTPUT_REGISTRY: Record<string, (props: { snapshot: AgentDebugSnapshot }) => ReactElement> = {
  master: MasterPlanView,
  parser: ParsedIntentView,
  director: NarrativeView,
  writer: NarrativeView,
  npc: NarrativeView,
  user: NarrativeView,
  state: StateDiffView,
};

export function OutputRenderer({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const Renderer = OUTPUT_REGISTRY[snapshot.agent_type] || RawTextView;
  return <Renderer snapshot={snapshot} />;
}
