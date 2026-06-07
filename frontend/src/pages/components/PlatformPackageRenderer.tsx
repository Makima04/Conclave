import React, { useRef, useEffect, useMemo, useState } from 'react';
import type { ConclaveCardPackage, PackageUi } from '../../api/types';
import { buildSandboxDocument, type SandboxRuntimeContext } from '../sandbox-document';

interface PlatformPackageRendererProps {
  pkg: ConclaveCardPackage;
  variables?: Record<string, unknown>;
  runtime?: SandboxRuntimeContext;
  onAction?: (actionId: string, payload?: unknown) => void;
}

/**
 * Renders a ConclaveCardPackage UI definition.
 * - HtmlApp: renders in a sandboxed iframe using the split CSS/JS
 * - HtmlFragment: renders inline HTML
 * - Text: renders as markdown/text
 * - Schema: falls back to schema-based rendering
 * - RawPreview: shows raw content
 */
export function PlatformPackageRenderer({ pkg, variables, runtime, onAction }: PlatformPackageRendererProps) {
  const { ui } = pkg;

  switch (ui.type) {
    case 'html_app':
      return <HtmlAppRenderer ui={ui} pkg={pkg} variables={variables} runtime={runtime} onAction={onAction} />;
    case 'html_fragment':
      return <HtmlFragmentRenderer ui={ui} pkg={pkg} variables={variables} runtime={runtime} onAction={onAction} />;
    case 'text':
      return <TextRenderer content={ui.html || ''} />;
    case 'raw_preview':
      return <RawPreviewRenderer ui={ui} />;
    case 'schema':
    default:
      return <div className="schema-placeholder">Schema 渲染暂未实现</div>;
  }
}

function HtmlAppRenderer({ ui, pkg, variables, runtime, onAction }: { ui: PackageUi; pkg: ConclaveCardPackage; variables?: Record<string, unknown>; runtime?: SandboxRuntimeContext; onAction?: (id: string, payload?: unknown) => void }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);
  const [height, setHeight] = useState(640);
  const htmlSource = useMemo(() => buildIframeSrc(ui), [ui]);
  const htmlContent = useMemo(() => mounted ? buildSandboxDocument(htmlSource, variables || {}, runtime) : '', [mounted, htmlSource, variables, runtime]);

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
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      if (e.data?.type === 'sandbox-resize') {
        const next = Number(e.data.height);
        if (Number.isFinite(next)) {
          setHeight(current => {
            const clamped = Math.max(360, Math.min(1800, next));
            return Math.abs(clamped - current) < 8 ? current : clamped;
          });
          onAction?.('sandboxResize', { height: next });
        }
      } else if (e.data?.type === 'state_change' && onAction) {
        onAction('state_change', e.data.changes);
      } else if (e.data?.type === 'action' && onAction) {
        onAction(e.data.actionId, e.data.payload);
      } else if (e.data?.type === 'card-sandbox-action' && typeof e.data.action === 'string' && onAction) {
        if (e.data.action === 'runtimeError') {
          console.error('[Platform Package Runtime Error]', e.data.payload?.message, e.data.payload);
        } else if (e.data.action === 'missingApi') {
          console.warn('[Platform Package Missing API]', e.data.payload?.method, e.data.payload);
        }
        onAction(e.data.action, e.data.payload || {});
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAction]);

  return (
    <div ref={shellRef} className="platform-package-renderer html-app">
      {mounted ? (
        <iframe
          ref={iframeRef}
          srcDoc={htmlContent}
          sandbox="allow-scripts"
          className="package-iframe"
          title={pkg.manifest.name}
          referrerPolicy="no-referrer"
          style={{ height }}
        />
      ) : (
        <div className="package-iframe-placeholder" style={{ height }} />
      )}
    </div>
  );
}

function buildIframeSrc(ui: PackageUi): string {
  // If ui.html is available, use it directly -- buildSandboxDocument handles
  // normalization and injects Vue runtime, MiniQuery, bridge APIs, etc.
  // This preserves external <script src="..."> tags (e.g. Vue CDN) that
  // html_splitter.rs drops when populating ui.js[].
  if (ui.html && ui.html.trim()) return ui.html;

  // Fallback: reconstruct from css/js arrays when ui.html is missing
  const entry = `<div id="${ui.entry || 'app'}"></div>`;
  const css = ui.css.map(c => `<style>${c}</style>`).join('\n');
  const js = ui.js.map(j => `<script${j.includes('import ') ? ' type="module"' : ''}>${j}</script>`).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${css}
</head>
<body>
${entry}
${js}
</body>
</html>`;
}

function HtmlFragmentRenderer({ ui, pkg, variables, runtime, onAction }: { ui: PackageUi; pkg: ConclaveCardPackage; variables?: Record<string, unknown>; runtime?: SandboxRuntimeContext; onAction?: (id: string, payload?: unknown) => void }) {
  // Use sandbox iframe for html_fragment too, so Vue runtime, bridge APIs
  // (TavernHelper, eventOn, etc.), and sandbox isolation are all available.
  const shellRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);
  const [height, setHeight] = useState(640);
  const htmlSource = useMemo(() => buildIframeSrc(ui), [ui]);
  const htmlContent = useMemo(() => mounted ? buildSandboxDocument(htmlSource, variables || {}, runtime) : '', [mounted, htmlSource, variables, runtime]);

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
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      if (e.data?.type === 'sandbox-resize') {
        const next = Number(e.data.height);
        if (Number.isFinite(next)) {
          setHeight(current => {
            const clamped = Math.max(360, Math.min(1800, next));
            return Math.abs(clamped - current) < 8 ? current : clamped;
          });
          onAction?.('sandboxResize', { height: next });
        }
      } else if (e.data?.type === 'state_change' && onAction) {
        onAction('state_change', e.data.changes);
      } else if (e.data?.type === 'action' && onAction) {
        onAction(e.data.actionId, e.data.payload);
      } else if (e.data?.type === 'card-sandbox-action' && typeof e.data.action === 'string' && onAction) {
        if (e.data.action === 'runtimeError') {
          console.error('[Platform Package Runtime Error]', e.data.payload?.message, e.data.payload);
        } else if (e.data.action === 'missingApi') {
          console.warn('[Platform Package Missing API]', e.data.payload?.method, e.data.payload);
        }
        onAction(e.data.action, e.data.payload || {});
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAction]);

  return (
    <div ref={shellRef} className="platform-package-renderer html-fragment">
      {mounted ? (
        <iframe
          ref={iframeRef}
          srcDoc={htmlContent}
          sandbox="allow-scripts"
          className="package-iframe"
          title={pkg.manifest.name}
          referrerPolicy="no-referrer"
          style={{ height, border: 'none' }}
        />
      ) : (
        <div className="package-iframe-placeholder" style={{ height }} />
      )}
    </div>
  );
}

function TextRenderer({ content }: { content: string }) {
  return (
    <div className="platform-package-renderer text-content">
      {content}
    </div>
  );
}

function RawPreviewRenderer({ ui }: { ui: PackageUi }) {
  return (
    <div className="platform-package-renderer raw-preview">
      <pre><code>{ui.html || '(empty)'}</code></pre>
    </div>
  );
}

export default PlatformPackageRenderer;
