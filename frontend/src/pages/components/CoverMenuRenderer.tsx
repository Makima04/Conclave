// Cover menu renderer
// Extracted from Chat.tsx GROUP 21

import type { CoverMenuSchema } from '../card-schema-types';

export function CoverMenuRenderer({ schema }: { schema: CoverMenuSchema }) {
  const style = {
    '--cover-bg': schema.theme.cardBg,
    '--cover-text': schema.theme.textPrimary,
    '--cover-muted': schema.theme.textSecondary,
    '--cover-accent': schema.theme.accentMain,
    '--cover-gold': schema.theme.gold,
    '--cover-border': schema.theme.borderGlow,
    '--cover-shadow': schema.theme.shadow,
  } as React.CSSProperties;

  return (
    <div className="schema-cover-menu" style={style}>
      {schema.background && <img className="schema-cover-bg" src={schema.background} alt={schema.title} />}
      <div className="schema-cover-overlay" />
      <div className="schema-cover-content">
        <div className="schema-cover-title">{schema.title}</div>
        {schema.subtitle && <div className="schema-cover-subtitle">{schema.subtitle}</div>}
        {schema.buttons.length > 0 && (
          <div className="schema-cover-buttons">
            {schema.buttons.map(label => (
              <button key={label} type="button" className="schema-cover-button">{label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
