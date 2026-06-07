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
import { buildSandboxDocument, type SandboxRuntimeContext } from '../sandbox-document';

export function SandboxHtmlRenderer({ html, variables, runtime, onAction }: { html: string; variables: any; runtime?: SandboxRuntimeContext; onAction?: (action: SandboxCardAction) => void }) {
  const [height, setHeight] = useState(640);
  const frameIdRef = useRef(`sandbox-${Math.random().toString(36).slice(2)}`);
  const shellRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);
  const documentHtml = React.useMemo(() => mounted ? buildSandboxDocument(html, variables || {}, runtime) : '', [mounted, html, variables, runtime]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setMounted(true);
        observer.disconnect();
      }
    }, { rootMargin: '900px 0px' });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (event.data?.type === 'sandbox-resize') {
        const next = Number(event.data.height);
        if (Number.isFinite(next)) {
          setHeight(current => {
            const clamped = Math.max(360, Math.min(1800, next));
            return Math.abs(clamped - current) < 8 ? current : clamped;
          });
          onAction?.({ action: 'sandboxResize', payload: { height: next } });
        }
      }
      if (event.data?.type === 'card-sandbox-action' && typeof event.data.action === 'string') {
        const allowed = new Set(['applyGreeting', 'applyOpeningSwipe', 'readVariables', 'writeVariables', 'openStatusPanel', 'submitFreeStart', 'submitText', 'diagnostic', 'uiClick', 'formSubmit', 'setChatMessage', 'setChatMessages', 'triggerSlash', 'setVariables', 'missingApi', 'runtimeError', 'resourceRequest']);
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
    <div ref={shellRef} className="sandbox-renderer-shell" data-sandbox-id={frameIdRef.current}>
      {mounted ? (
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
      ) : (
        <div className="package-iframe-placeholder" style={{ height }} />
      )}
    </div>
  );
}
