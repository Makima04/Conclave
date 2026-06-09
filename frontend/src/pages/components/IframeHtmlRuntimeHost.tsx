import React, { useEffect, useRef, useState } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import type { SandboxRuntimeContext } from '../sandbox-document';

const MIN_IFRAME_HEIGHT = 360;
const MAX_MESSAGE_IFRAME_HEIGHT = 720;

interface IframeHtmlRuntimeHostProps {
  documentHtml: string;
  className: string;
  runtime?: SandboxRuntimeContext;
  variables?: Record<string, unknown>;
  allowedActions?: Set<string>;
  onAction?: (action: SandboxCardAction) => void;
}

export function IframeHtmlRuntimeHost({
  documentHtml,
  className,
  runtime,
  variables,
  allowedActions,
  onAction,
}: IframeHtmlRuntimeHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(520);
  const [viewportFitHeight, setViewportFitHeight] = useState(MIN_IFRAME_HEIGHT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [documentHtml]);

  useEffect(() => {
    let frame = 0;
    const updateViewportFitHeight = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const iframe = iframeRef.current;
        if (!iframe) return;
        const rect = iframe.getBoundingClientRect();
        const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
        const bottomGutter = 24;
        const available = viewportHeight - Math.max(0, rect.top) - bottomGutter;
        if (Number.isFinite(available)) {
          setViewportFitHeight(Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_MESSAGE_IFRAME_HEIGHT, available)));
        }
      });
    };

    updateViewportFitHeight();
    window.addEventListener('resize', updateViewportFitHeight);
    window.visualViewport?.addEventListener('resize', updateViewportFitHeight);
    const observer = new ResizeObserver(updateViewportFitHeight);
    if (iframeRef.current?.parentElement) observer.observe(iframeRef.current.parentElement);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateViewportFitHeight);
      window.visualViewport?.removeEventListener('resize', updateViewportFitHeight);
      observer.disconnect();
    };
  }, [documentHtml]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data || {};
      if (data?.type === 'sandbox-resize') {
        const next = Number(data.height);
        if (Number.isFinite(next)) {
          setHeight(Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_MESSAGE_IFRAME_HEIGHT, next)));
          onAction?.({ action: 'sandboxResize', payload: { height: next } });
        }
        return;
      }
      if (data?.type !== 'card-sandbox-action' || typeof data.action !== 'string') return;
      if (allowedActions && !allowedActions.has(data.action)) return;
      if (data.action === 'runtimeError') {
        console.error('[Iframe Card Runtime Error]', data.payload?.message, data.payload);
      } else if (data.action === 'missingApi') {
        console.warn('[Iframe Card Missing API]', data.payload?.method, data.payload);
      }
      onAction?.({ action: data.action, payload: data.payload || {} });
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [allowedActions, onAction]);

  useEffect(() => {
    if (!loaded || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({
      type: 'xrp-runtime-update',
      runtime: runtime || {},
      variables: variables || {},
      submission: runtime?.submission || null,
    }, '*');
  }, [loaded, runtime, variables]);

  return (
    <iframe
      ref={iframeRef}
      className={className}
      srcDoc={documentHtml}
      sandbox="allow-scripts allow-same-origin"
      style={{ height: Math.max(height, viewportFitHeight) }}
      onLoad={() => {
        setLoaded(true);
        const iframe = iframeRef.current;
        if (!iframe) return;
        const rect = iframe.getBoundingClientRect();
        const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
        const available = viewportHeight - Math.max(0, rect.top) - 24;
        if (Number.isFinite(available)) {
          setViewportFitHeight(Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_MESSAGE_IFRAME_HEIGHT, available)));
        }
      }}
      title="消息级角色卡界面"
    />
  );
}
