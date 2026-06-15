// StScriptIframeHost — persistent hidden iframes for tavern_helper_scripts
//
// Each card script (tavern_helper_scripts from card extensions) gets its own
// hidden iframe. These iframes persist across message changes — they are only
// destroyed when the session or card changes.
//
// Scripts inherit host globals (lodash, jQuery, TavernHelper, etc.) via
// predefine.js → window.parent access (same-origin blob URL).
// They create floating UI (status bars, "灵" buttons) on the parent DOM.

import React, { useMemo } from 'react';
import { createScriptSrcContent } from './iframe-doc';
import type { TavernHelperScript } from './tavern-helper-scripts';

interface StScriptIframeHostProps {
  /** Unique key for the current card (card_id or similar). Changes on card switch. */
  cardKey: string;
  /** The scripts to load, one iframe per script. */
  scripts: TavernHelperScript[];
}

/**
 * Renders one hidden <iframe> per tavern_helper_script.
 *
 * Naming: TH-script--{name}--{idx}
 *
 * Lifecycle:
 *   - Created when scripts become available (card load)
 *   - Destroyed only when cardKey changes (card switch / session exit)
 *   - NOT destroyed on message changes
 */
export const StScriptIframeHost: React.FC<StScriptIframeHostProps> = ({ cardKey, scripts }) => {
  if (scripts.length === 0) return null;

  return (
    <div
      className="st-script-iframe-host"
      data-card-key={cardKey}
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <div id="tavern_helper" aria-hidden="true" style={{ display: 'none' }}>
        {scripts.map((script, idx) => (
          <div
            key={`${cardKey}--script-marker--${idx}--${script.id ?? 'no-id'}`}
            data-script-id={script.id ?? String(idx)}
          />
        ))}
      </div>
      <div id="extensions_settings2" aria-hidden="true" style={{ display: 'none' }} />
      {scripts.map((script, idx) => (
        <ScriptIframe
          key={`${cardKey}--${idx}--${script.id ?? 'no-id'}`}
          script={script}
          idx={idx}
        />
      ))}
    </div>
  );
};

/** Single hidden iframe for one tavern_helper_script. */
const ScriptIframe: React.FC<{ script: TavernHelperScript; idx: number }> = ({ script, idx }) => {
  const scriptId = script.id ?? String(idx);
  const iframeName = `TH-script--${idx}--${script.name}--${scriptId}`;
  const srcdoc = useMemo(() => createScriptSrcContent(script.content), [script.content]);

  return (
    <iframe
      id={iframeName}
      name={iframeName}
      srcDoc={srcdoc}
      title={iframeName}
      style={{
        position: 'absolute',
        width: '0',
        height: '0',
        border: 'none',
        visibility: 'hidden',
        pointerEvents: 'none',
      }}
      onLoad={() => {
        console.debug(`[StScriptIframeHost] script loaded: ${iframeName}`);
      }}
      onError={() => {
        console.error(`[StScriptIframeHost] script iframe error: ${iframeName}`);
      }}
    />
  );
};
