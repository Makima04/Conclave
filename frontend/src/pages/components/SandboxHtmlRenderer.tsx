// Sandbox HTML renderer (iframe-based)
// Extracted from Chat.tsx GROUP 23

/**
 * @deprecated Runtime sandbox renderer -- FALLBACK ONLY.
 *
 * The primary path for external character card rendering is now the
 * import-time normalization pipeline (ConclaveCardPackage).
 *
 * This component is retained for:
 * - Import normalization failure fallback (cards without conclave_package)
 * - Raw ST sandbox preview in the Import Workbench
 * - Explicit user opt-in for "raw sandbox mode" (render_mode = 'sandbox')
 *
 * New cards should be imported via /charactercards/import and rendered
 * through PlatformPackageRenderer instead.
 */

import React, { useState, useEffect, useRef } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildSandboxDocument } from '../sandbox-document';

export function SandboxHtmlRenderer({ html, variables, onAction }: { html: string; variables: any; onAction?: (action: SandboxCardAction) => void }) {
  const [height, setHeight] = useState(640);
  const frameIdRef = useRef(`sandbox-${Math.random().toString(36).slice(2)}`);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const documentHtml = React.useMemo(() => buildSandboxDocument(html, variables || {}), [html, variables]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (event.data?.type === 'sandbox-resize') {
        const next = Number(event.data.height);
        if (Number.isFinite(next)) {
          setHeight(Math.max(360, Math.min(1800, next)));
        }
      }
      if (event.data?.type === 'card-sandbox-action' && typeof event.data.action === 'string') {
        const allowed = new Set(['applyGreeting', 'applyOpeningSwipe', 'readVariables', 'writeVariables', 'openStatusPanel', 'submitFreeStart', 'uiClick', 'formSubmit', 'setChatMessage', 'setChatMessages', 'triggerSlash', 'setVariables', 'missingApi', 'runtimeError', 'resourceRequest']);
        if (allowed.has(event.data.action)) {
          if (event.data.action === 'runtimeError') {
            console.error('[Sandbox Runtime Error]', event.data.payload?.message, event.data.payload);
          } else if (event.data.action === 'missingApi') {
            console.warn('[Sandbox Missing API]', event.data.payload?.method, event.data.payload);
          }
          onAction?.({ action: event.data.action, payload: event.data.payload || {} });
        }
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAction]);

  return (
    <div className="sandbox-renderer-shell" data-sandbox-id={frameIdRef.current}>
      <iframe
        className="sandbox-renderer-frame"
        title="角色卡 UI"
        sandbox="allow-scripts"
        ref={iframeRef}
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height }}
        srcDoc={documentHtml}
      />
    </div>
  );
}
