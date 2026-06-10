import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import type { SandboxRuntimeContext } from '../sandbox-runtime-types';
import {
  buildRuntimeResponsePayload,
  buildRuntimeUpdatePayload,
} from '../runtime-host-protocol';

const MIN_IFRAME_HEIGHT = 360;
const FALLBACK_MAX_IFRAME_HEIGHT = 860;
const BOTTOM_GUTTER = 24;

interface IframeHtmlRuntimeHostProps {
  documentHtml: string;
  className: string;
  runtime?: SandboxRuntimeContext;
  variables?: Record<string, unknown>;
  allowedActions?: Set<string>;
  fillAvailableHeight?: boolean;
  onAction?: (action: SandboxCardAction) => void | Promise<unknown>;
}

export function IframeHtmlRuntimeHost({
  documentHtml,
  className,
  runtime,
  variables,
  allowedActions,
  fillAvailableHeight = false,
  onAction,
}: IframeHtmlRuntimeHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(520);
  const [viewportMaxHeight, setViewportMaxHeight] = useState(FALLBACK_MAX_IFRAME_HEIGHT);
  const [loaded, setLoaded] = useState(false);
  const calculateViewportMaxHeight = useCallback(() => {
    const iframe = iframeRef.current;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
    if (!iframe || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      return FALLBACK_MAX_IFRAME_HEIGHT;
    }
    const rect = iframe.getBoundingClientRect();
    const available = viewportHeight - Math.max(0, rect.top) - BOTTOM_GUTTER;
    return Math.max(MIN_IFRAME_HEIGHT, Math.floor(available));
  }, []);
  const publishViewportMaxHeight = useCallback((maxHeight: number) => {
    const iframe = iframeRef.current;
    if (!iframe || !Number.isFinite(maxHeight)) return;
    const value = `${Math.max(MIN_IFRAME_HEIGHT, Math.floor(maxHeight))}px`;
    iframe.parentElement?.style.setProperty('--xrp-frame-max-height', value);
  }, []);
  const clampFrameHeight = useCallback((next: number) => {
    if (!Number.isFinite(next)) return MIN_IFRAME_HEIGHT;
    const maxHeight = calculateViewportMaxHeight();
    return Math.max(MIN_IFRAME_HEIGHT, Math.min(maxHeight, Math.ceil(next)));
  }, [calculateViewportMaxHeight]);

  useEffect(() => {
    setLoaded(false);
  }, [documentHtml]);

  useEffect(() => {
    let frame = 0;
    const updateViewportFitHeight = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const nextMax = calculateViewportMaxHeight();
        publishViewportMaxHeight(nextMax);
        setViewportMaxHeight(nextMax);
        setHeight(current => clampFrameHeight(current));
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
  }, [calculateViewportMaxHeight, clampFrameHeight, documentHtml, publishViewportMaxHeight]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data || {};
      if (data?.type === 'sandbox-resize') {
        const next = Number(data.height);
        if (Number.isFinite(next)) {
          const nextMax = calculateViewportMaxHeight();
          publishViewportMaxHeight(nextMax);
          setViewportMaxHeight(nextMax);
          setHeight(clampFrameHeight(next));
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
      const action = { action: data.action, payload: data.payload || {} };
      const maybePromise = onAction?.(action);
      const requestId = typeof data.requestId === 'string' ? data.requestId : '';
      if (!requestId || !maybePromise || typeof (maybePromise as Promise<unknown>).then !== 'function') return;
      Promise.resolve(maybePromise)
        .then((payload) => {
          iframeRef.current?.contentWindow?.postMessage(
            buildRuntimeResponsePayload(requestId, true, payload),
            '*',
          );
        })
        .catch((error) => {
          iframeRef.current?.contentWindow?.postMessage(
            buildRuntimeResponsePayload(
              requestId,
              false,
              null,
              String((error as any)?.message || error || 'Runtime bridge failed'),
            ),
            '*',
          );
        });
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [allowedActions, calculateViewportMaxHeight, clampFrameHeight, onAction, publishViewportMaxHeight]);

  useEffect(() => {
    if (!loaded || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(buildRuntimeUpdatePayload(runtime, variables), '*');
  }, [loaded, runtime, variables]);

  return (
    <iframe
      ref={iframeRef}
      className={className}
      srcDoc={documentHtml}
      sandbox="allow-scripts allow-same-origin"
      style={{
        height: fillAvailableHeight ? viewportMaxHeight : clampFrameHeight(height),
        maxHeight: viewportMaxHeight,
        ['--xrp-frame-max-height' as any]: `${viewportMaxHeight}px`,
      }}
      onLoad={() => {
        setLoaded(true);
        const nextMax = calculateViewportMaxHeight();
        publishViewportMaxHeight(nextMax);
        setViewportMaxHeight(nextMax);
        setHeight(current => clampFrameHeight(current));
      }}
      title="消息级角色卡界面"
    />
  );
}
