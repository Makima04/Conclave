// Platform game start renderer
// Extracted from Chat.tsx GROUP 22

import { useState } from 'react';
import type { PlatformCardSchema, PlatformLocation, SandboxCardAction } from '../card-schema-types';
import { sanitizeHtmlFragment } from '../card-content';

export function PlatformGameStartRenderer({
  schema,
  onAction,
}: {
  schema: PlatformCardSchema;
  onAction?: (action: SandboxCardAction) => void;
}) {
  const [view, setView] = useState<'home' | 'intro' | 'map' | 'carousel'>('home');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedLocation, setSelectedLocation] = useState<PlatformLocation | null>(null);
  const [showFreeStart, setShowFreeStart] = useState(false);
  const selected = schema.characters[selectedIndex] || schema.characters[0];
  const style = {
    '--platform-card-bg': schema.theme.cardBg,
    '--platform-card-text': schema.theme.textPrimary,
    '--platform-card-muted': schema.theme.textSecondary,
    '--platform-card-accent': schema.theme.accentMain,
    '--platform-card-gold': schema.theme.gold,
    '--platform-card-border': schema.theme.borderGlow,
    '--platform-card-shadow': schema.theme.shadow,
    '--platform-shell-max-width': `${schema.layout.shellMaxWidth}px`,
    '--platform-stage-min-height': `${schema.layout.stageMinHeight}px`,
    '--platform-main-card-width': `${schema.layout.mainCardWidth}px`,
    '--platform-main-card-min-width': `${schema.layout.mainCardMinWidth}px`,
    '--platform-main-card-top': `${schema.layout.mainCardTop}%`,
    '--platform-main-card-height': `${schema.layout.mainCardHeight}%`,
    '--platform-side-card-scale': schema.layout.sideCardScale,
    '--platform-side-card-offset': `${schema.layout.sideCardOffset}%`,
    '--platform-side-card-opacity': schema.layout.sideCardOpacity,
    '--platform-background-dim': schema.layout.backgroundDim,
  } as React.CSSProperties;

  function selectCharacter(id: number) {
    onAction?.({ action: 'applyOpeningSwipe', payload: { swipeId: id } });
  }

  function randomize() {
    setSelectedIndex(Math.floor(Math.random() * schema.characters.length));
  }

  return (
    <div className="platform-card-shell" style={style}>
      {schema.background && <img className="platform-card-bg" src={schema.background} alt={schema.title} />}
      <div className="platform-card-overlay" />
      <div className="platform-card-ui">
        {view !== 'home' && (
          <button className="platform-icon-btn platform-close-btn" type="button" onClick={() => setView('home')} title="关闭">x</button>
        )}

        {view === 'home' && (
          <div className="platform-home">
            <div>
              <div className="platform-title">{schema.title}</div>
              {schema.subtitle && <div className="platform-subtitle">{schema.subtitle}</div>}
            </div>
            <div className="platform-menu">
              <button type="button" onClick={() => setView('intro')}>天道卷首</button>
              <button type="button" onClick={() => setView('map')}>苍玄地志</button>
              <button type="button" onClick={() => setView('carousel')}>因果轮盘</button>
            </div>
          </div>
        )}

        {view === 'intro' && (
          <div className="platform-scroll-panel">
            <div className="platform-panel-title">天道卷首</div>
            {schema.introHtml ? (
              <div className="platform-rich-text" dangerouslySetInnerHTML={{ __html: schema.introHtml }} />
            ) : (
              <p>大道五十，天衍四九。</p>
            )}
          </div>
        )}

        {view === 'map' && (
          <div className="platform-map-view">
            <div className="platform-panel-title">苍玄地志</div>
            <div className="platform-location-grid">
              {schema.locations.map(location => (
                <button key={location.id} type="button" className="platform-location-card" onClick={() => setSelectedLocation(location)}>
                  <strong>{location.name}</strong>
                  <span>{location.tag}</span>
                </button>
              ))}
            </div>
            {selectedLocation && (
              <div className="platform-modal-backdrop" onClick={() => setSelectedLocation(null)}>
                <div className="platform-modal" onClick={event => event.stopPropagation()}>
                  <button className="platform-icon-btn" type="button" onClick={() => setSelectedLocation(null)} title="关闭">x</button>
                  <h3>{selectedLocation.name}</h3>
                  <small>{selectedLocation.tag}</small>
                  <div className="platform-rich-text" dangerouslySetInnerHTML={{ __html: sanitizeHtmlFragment(selectedLocation.desc) }} />
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'carousel' && selected && (
          <div className="platform-carousel-view">
            <button className="platform-icon-btn platform-nav-btn prev" type="button" onClick={() => setSelectedIndex((selectedIndex - 1 + schema.characters.length) % schema.characters.length)} title="上一个">‹</button>
            <div className="platform-carousel-strip">
              {schema.characters.map((character, index) => {
                const offset = index - selectedIndex;
                const wrapped = Math.abs(offset) > schema.characters.length / 2
                  ? offset - Math.sign(offset) * schema.characters.length
                  : offset;
                return (
                  <button
                    key={character.id}
                    type="button"
                    className={`platform-character-card ${index === selectedIndex ? 'active' : ''}`}
                    style={{
                      transform: `translateX(calc(${wrapped} * var(--platform-side-card-offset, 42%))) scale(${index === selectedIndex ? 1 : 'var(--platform-side-card-scale, 0.72)'})`,
                      opacity: Math.abs(wrapped) > 2 ? 0 : index === selectedIndex ? 1 : 'var(--platform-side-card-opacity, 0.45)',
                      zIndex: 20 - Math.abs(wrapped),
                    }}
                    onClick={() => index === selectedIndex ? selectCharacter(character.id) : setSelectedIndex(index)}
                  >
                    <img src={character.front} alt={character.name} />
                    <span>{character.name}</span>
                    <small>{character.title}</small>
                  </button>
                );
              })}
            </div>
            <button className="platform-icon-btn platform-nav-btn next" type="button" onClick={() => setSelectedIndex((selectedIndex + 1) % schema.characters.length)} title="下一个">›</button>
            <div className="platform-character-detail">
              {selected.avatar && <img src={selected.avatar} alt={selected.name} />}
              <h3>{selected.name}</h3>
              <div>{selected.sect} · {selected.title}</div>
              <p>{selected.desc}</p>
              <button type="button" className="platform-primary-btn" onClick={() => selectCharacter(selected.id)}>选定此缘</button>
            </div>
            <div className="platform-carousel-actions">
              <button type="button" onClick={randomize}>听凭天意</button>
              <button type="button" onClick={() => setShowFreeStart(true)}>自由开局</button>
            </div>
            {showFreeStart && (
              <div className="platform-modal-backdrop" onClick={() => setShowFreeStart(false)}>
                <div className="platform-modal" onClick={event => event.stopPropagation()}>
                  <button className="platform-icon-btn" type="button" onClick={() => setShowFreeStart(false)} title="关闭">x</button>
                  <h3>自由开局</h3>
                  <p>自由开局表单保留在原始沙盒模式中。平台 Schema 模式当前先覆盖轮盘开局。</p>
                  <button type="button" className="platform-primary-btn" onClick={() => setShowFreeStart(false)}>返回</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
