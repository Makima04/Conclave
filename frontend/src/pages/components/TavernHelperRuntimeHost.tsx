import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildTavernHelperDocument, type SandboxRuntimeContext } from '../sandbox-document';

export function TavernHelperRuntimeHost({
  scripts,
  variables,
  runtime,
  onAction,
}: {
  scripts: Array<{ name: string; content: string }>;
  variables: any;
  runtime?: SandboxRuntimeContext;
  onAction?: (action: SandboxCardAction) => void;
}) {
  const [height, setHeight] = useState(560);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const documentHtml = useMemo(
    () => scripts.length ? buildTavernHelperDocument(scripts, variables || {}, runtime) : '',
    [scripts, variables, runtime],
  );

  useEffect(() => {
    if (!scripts.length) return undefined;
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (event.data?.type === 'sandbox-resize') {
        const next = Number(event.data.height);
        if (Number.isFinite(next)) {
          setHeight(current => {
            const clamped = Math.max(420, Math.min(900, next));
            return Math.abs(clamped - current) < 8 ? current : clamped;
          });
        }
        return;
      }
      if (event.data?.type !== 'card-sandbox-action' || typeof event.data.action !== 'string') return;
      if (event.data.action === 'runtimeError') {
        console.error('[TavernHelper Runtime Error]', event.data.payload?.message, event.data.payload);
      } else if (event.data.action === 'missingApi') {
        console.warn('[TavernHelper Missing API]', event.data.payload?.method, event.data.payload);
      }
      onAction?.({ action: event.data.action, payload: event.data.payload || {} });
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAction, scripts.length]);

  if (!scripts.length) return null;

  return (
    <iframe
      ref={iframeRef}
      className="tavern-helper-runtime-host"
      title="TavernHelper runtime"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={documentHtml}
      style={{ height }}
    />
  );
}
