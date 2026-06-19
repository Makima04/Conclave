import { useState } from 'react';
import type { AgentDebugSnapshot } from '../../api/types';
import { InputPanel } from './InputPanel';
import { OutputRenderer } from './renderers';

function fmtDuration(ms: number | null | undefined): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AgentCard({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const [open, setOpen] = useState(snapshot.phase === 'master');
  const isMaster = snapshot.phase === 'master' || snapshot.agent_type === 'master';
  const hasInput = Boolean(
    snapshot.system_prompt?.trim() ||
      (snapshot.recent_messages && snapshot.recent_messages.length) ||
      (snapshot.recalled_events && snapshot.recalled_events.length) ||
      (snapshot.worldbook_entries && snapshot.worldbook_entries.length) ||
      (snapshot.preset_modules && snapshot.preset_modules.length),
  );

  return (
    <div className={`agent-card${isMaster ? ' master' : ''}${open ? ' is-open' : ' is-collapsed'}`}>
      <button type="button" className="agent-card-head" onClick={() => setOpen(o => !o)}>
        <span className={`agent-type-badge${isMaster ? ' master' : ''}`}>{snapshot.agent_type}</span>
        <span className="agent-card-label">{snapshot.agent_label || snapshot.agent_id?.slice(0, 8) || '-'}</span>
        {snapshot.model && <span className="agent-card-model">{snapshot.model}</span>}
        <span className="agent-card-chevron">{open ? '▾' : '▸'}</span>
      </button>
      <div className="insp-stat-row">
        {snapshot.task && <span className="insp-chip" title={snapshot.task}>task: {snapshot.task.slice(0, 40)}</span>}
        <span className="insp-chip dim">↑{snapshot.prompt_tokens} ↓{snapshot.completion_tokens}</span>
        {snapshot.cached_tokens > 0 && snapshot.prompt_tokens > 0 && (
          <span
            className="insp-chip dim"
            title="prompt cache 命中 token / 占输入比例"
          >
            cache {snapshot.cached_tokens} ({Math.round((snapshot.cached_tokens / snapshot.prompt_tokens) * 100)}%)
          </span>
        )}
        {snapshot.duration_ms != null && <span className="insp-chip dim">{fmtDuration(snapshot.duration_ms)}</span>}
        {snapshot.level_index != null && <span className="insp-chip dim">level {snapshot.level_index}</span>}
      </div>
      {open && (
        <div className="agent-card-body">
          {hasInput && (
            <>
              <div className="section-divider"><span className="section-divider-line" /><span className="section-divider-dot">·</span><span className="section-label">注入上下文</span><span className="section-divider-dot">·</span><span className="section-divider-line" /></div>
              <InputPanel snapshot={snapshot} />
              <div className="section-divider"><span className="section-divider-line" /><span className="section-divider-dot">·</span><span className="section-label">产出 (raw_output)</span><span className="section-divider-dot">·</span><span className="section-divider-line" /></div>
            </>
          )}
          <OutputRenderer snapshot={snapshot} />
        </div>
      )}
    </div>
  );
}
