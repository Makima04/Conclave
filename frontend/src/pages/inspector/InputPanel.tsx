import { Section } from './renderers';
import type { AgentDebugSnapshot } from '../../api/types';

function roleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  return role;
}

function fmtState(state: unknown): Array<[string, string]> {
  if (!state || typeof state !== 'object') return [];
  const obj = state as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined)
    .slice(0, 60)
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}

/**
 * 统一输入面板 —— 每个 agent 被注入的字段同名，故所有 agent 共用一套渲染器。
 * 这是"数据库多功能美化正则"那种可折叠分层面板在 Conclave 的对应物，但数据来自
 * Conclave 自己的结构化字段（recent_messages/recalled_events/worldbook/preset/state_slice），
 * 不解析模型输出的标签。空节自动隐藏。
 */
export function InputPanel({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const msgs = snapshot.recent_messages || [];
  const recalled = snapshot.recalled_events || [];
  const wb = snapshot.worldbook_entries || [];
  const presets = snapshot.preset_modules || [];
  const stateRows = fmtState(snapshot.state_slice);
  const hasPrompt = Boolean(snapshot.system_prompt && snapshot.system_prompt.trim());

  const empty = !hasPrompt && msgs.length === 0 && recalled.length === 0 && wb.length === 0 && presets.length === 0 && stateRows.length === 0;
  if (empty) return <p className="insp-hint">（无注入上下文）</p>;

  return (
    <>
      {hasPrompt && (
        <Section title="系统提示 (system_prompt)">
          <pre className="prompt-pre">{snapshot.system_prompt}</pre>
        </Section>
      )}
      {msgs.length > 0 && (
        <Section title="最近对话 (recent_messages)" count={msgs.length}>
          {msgs.map((m, i) => (
            <div key={i} className="msg-item">
              <span className="msg-role">[{roleLabel(m.role)} · turn {m.turn_number}]</span>
              {m.content}
            </div>
          ))}
        </Section>
      )}
      {recalled.length > 0 && (
        <Section title="召回事件 (recalled_events)" count={recalled.length}>
          {recalled.map((e, i) => (
            <div key={i} className="recall-item">
              {typeof e === 'object' ? JSON.stringify(e, null, 0) : String(e)}
            </div>
          ))}
        </Section>
      )}
      {wb.length > 0 && (
        <Section title="世界书条目 (worldbook_entries)" count={wb.length}>
          {wb.map((e, i) => (
            <div key={i} className="wb-entry">
              <span className="wb-tag">{e.visibility}</span>
              {e.content}
              <small> · 优先级 {e.priority}{e.constant ? ' · 常驻' : ''}{e.keys.length ? ` · ${e.keys.join(',')}` : ''}</small>
            </div>
          ))}
        </Section>
      )}
      {presets.length > 0 && (
        <Section title="预设模块 (preset_modules)" count={presets.length}>
          {presets.map((p, i) => (
            <div key={i} className="preset-item">
              <span className="preset-tag">{p.name}</span>
              {p.content}
              {p.target_agents.length > 0 && <small> · → {p.target_agents.join(',')}</small>}
            </div>
          ))}
        </Section>
      )}
      {stateRows.length > 0 && (
        <Section title="状态切片 (state_slice)" count={stateRows.length}>
          {stateRows.map(([k, v]) => (
            <div key={k} className="state-kv">
              <span className="state-key">{k}</span>
              {v}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
