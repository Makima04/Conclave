// Custom status renderer: StatusMetric, SchemaWidget, CustomStatusRenderer
// Extracted from Chat.tsx GROUP 18 + GROUP 19 + GROUP 20

import { useState } from 'react';
import type { UiSchema, UiWidget } from '../card-schema-types';
import { getPathValue, parsePrimaryValue, parsePercent } from '../card-utils';

function StatusMetric({ label, value, color = '#C8A2C8' }: { label: string; value: any; color?: string }) {
  return (
    <div className="schema-metric">
      <div className="schema-metric-row">
        <span>{label}</span>
        <strong>{parsePrimaryValue(value)}</strong>
      </div>
      <div className="schema-bar">
        <div className="schema-bar-fill" style={{ width: `${parsePercent(value)}%`, background: color }} />
      </div>
    </div>
  );
}

function formatSchemaLabel(label: string, variables: any): string {
  return label.replace(/\{([^}]+)\}/g, (_, name) => {
    return parsePrimaryValue(getPathValue(variables, `<user>.特质.${name}.等级`));
  });
}

function SchemaWidget({ widget, variables }: { widget: UiWidget; variables: any }) {
  if (widget.type === 'thoughts') {
    return (
      <div className="schema-thought-grid">
        <div>
          <span>{widget.leftLabel}</span>
          <p>{parsePrimaryValue(getPathValue(variables, widget.leftPath))}</p>
        </div>
        <div>
          <span>{widget.rightLabel}</span>
          <p>{parsePrimaryValue(getPathValue(variables, widget.rightPath))}</p>
        </div>
      </div>
    );
  }

  if (widget.type === 'progress') {
    return (
      <StatusMetric
        label={formatSchemaLabel(widget.label, variables)}
        value={getPathValue(variables, widget.path)}
        color={widget.color}
      />
    );
  }

  if (widget.type === 'facts') {
    return (
      <div className="schema-facts">
        {widget.items.map(item => (
          <span key={`${item.label}-${item.path}`}>{item.label}：{parsePrimaryValue(getPathValue(variables, item.path))}</span>
        ))}
      </div>
    );
  }

  if (widget.type === 'table') {
    return (
      <div className="schema-table-wrap">
        <table className="schema-table">
          <thead>
            <tr><th>日期</th><th>上午</th><th>下午</th></tr>
          </thead>
          <tbody>
            {widget.rows.map(row => (
              <tr key={row.join('-')}>
                <td>{row[0]}</td><td>{row[1]}</td><td>{row[2] || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

export function CustomStatusRenderer({ schema, variables }: { schema: UiSchema | null; variables: any }) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());

  if (!schema) return null;

  const worldDate = schema.datePaths
    .map(path => parsePrimaryValue(getPathValue(variables, path)))
    .filter(v => v !== 'N/A')
    .join(' ');
  const initialized = Boolean(getPathValue(variables, '<user>.精神状态数值') || getPathValue(variables, '<user>.身体开发') || getPathValue(variables, '世界.当前日期'));
  const style = {
    '--schema-card-bg': schema.theme.cardBg,
    '--schema-text-primary': schema.theme.textPrimary,
    '--schema-text-secondary': schema.theme.textSecondary,
    '--schema-accent-main': schema.theme.accentMain,
    '--schema-gold': schema.theme.gold,
    '--schema-border-glow': schema.theme.borderGlow,
    '--schema-shadow': schema.theme.shadow,
  } as React.CSSProperties;

  function toggleSection(title: string) {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  }

  return (
    <details className="schema-status-shell" open={initialized} style={style}>
      <summary>
        <span>{schema.title}</span>
        <small>{worldDate || '状态未初始化'}</small>
      </summary>
      <div className="schema-status-card">
        {!initialized && (
          <div className="schema-empty-state">
            状态变量还没有完整初始化。继续发送开场白或下一轮回复后，这里会显示角色卡状态。
          </div>
        )}

        {schema.sections.map(section => {
          const expanded = expandedSections.has(section.title);
          return (
            <div className={`schema-section ${expanded ? 'expanded' : ''}`} key={section.title}>
              <button
                className="schema-section-title"
                type="button"
                aria-expanded={expanded}
                onClick={() => toggleSection(section.title)}
              >
                <span>{section.title}</span>
                <span className="schema-section-arrow">▼</span>
              </button>
              {expanded && (
                <div className="schema-grid">
                  {section.widgets.map((widget, index) => (
                    <SchemaWidget key={`${section.title}-${index}`} widget={widget} variables={variables} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
