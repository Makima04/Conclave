import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import type { SandboxRuntimeContext } from '../sandbox-document';

interface DirectHtmlRuntimeHostProps {
  documentHtml: string;
  className: string;
  runtime?: SandboxRuntimeContext;
  variables?: Record<string, unknown>;
  allowedActions?: Set<string>;
  onAction?: (action: SandboxCardAction) => void;
}

function copyAttributes(from: Element, to: Element) {
  Array.from(from.attributes).forEach(attr => {
    to.setAttribute(attr.name, attr.value);
  });
}

function appendExecutableScript(target: HTMLElement, sourceScript: HTMLScriptElement) {
  const script = document.createElement('script');
  copyAttributes(sourceScript, script);
  script.textContent = sourceScript.textContent || '';
  try {
    target.appendChild(script);
  } catch (error) {
    console.error('[Direct Card Runtime Script Error]', error);
  }
}

export function DirectHtmlRuntimeHost({
  documentHtml,
  className,
  runtime,
  variables,
  allowedActions,
  onAction,
}: DirectHtmlRuntimeHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const eventNamesRef = useRef({
    message: `xrp-direct-runtime-message-${Math.random().toString(36).slice(2)}`,
    update: `xrp-direct-runtime-update-${Math.random().toString(36).slice(2)}`,
    dispose: `xrp-direct-runtime-dispose-${Math.random().toString(36).slice(2)}`,
  });
  const transformedHtml = useMemo(() => documentHtml, [documentHtml]);

  useEffect(() => {
    function handleRuntimeMessage(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.type === 'sandbox-resize') {
        onAction?.({ action: 'sandboxResize', payload: { height: detail.height } });
        return;
      }
      if (detail?.type !== 'card-sandbox-action' || typeof detail.action !== 'string') return;
      if (allowedActions && !allowedActions.has(detail.action)) return;
      if (detail.action === 'runtimeError') {
        console.error('[Direct Card Runtime Error]', detail.payload?.message, detail.payload);
      } else if (detail.action === 'missingApi') {
        console.warn('[Direct Card Missing API]', detail.payload?.method, detail.payload);
      }
      onAction?.({ action: detail.action, payload: detail.payload || {} });
    }

    window.addEventListener(eventNamesRef.current.message, handleRuntimeMessage);
    return () => window.removeEventListener(eventNamesRef.current.message, handleRuntimeMessage);
  }, [allowedActions, onAction]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    setMounted(false);
    host.innerHTML = '';

    const parser = new DOMParser();
    const parsed = parser.parseFromString(transformedHtml, 'text/html');
    const documentRoot = document.createElement('div');
    documentRoot.className = 'direct-card-runtime-document';
    copyAttributes(parsed.body, documentRoot);
    const preserveTavernGlobals = className.includes('session-tavern-helper-runtime-host');
    const bridge = {
      messageEventName: eventNamesRef.current.message,
      updateEventName: eventNamesRef.current.update,
      disposeEventName: eventNamesRef.current.dispose,
      preserveTavernGlobals,
      post: (message: unknown) => {
        window.dispatchEvent(new CustomEvent(eventNamesRef.current.message, { detail: message }));
      },
    };
    (window as any).__XRPDirectRuntimeBridge = bridge;
    const externalNodes = new Set<Node>();
    const externalObserver = preserveTavernGlobals ? new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node === host || host.contains(node)) return;
          externalNodes.add(node);
        });
      });
    }) : null;
    if (externalObserver) {
      if (document.head) externalObserver.observe(document.head, { childList: true });
      if (document.body) externalObserver.observe(document.body, { childList: true });
    }

    const appendNode = (node: ChildNode, target: HTMLElement) => {
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === 'script') {
        appendExecutableScript(host, node as HTMLScriptElement);
        return;
      }
      target.appendChild(node.cloneNode(true));
    };

    Array.from(parsed.head.childNodes).forEach(node => appendNode(node, host));
    host.appendChild(documentRoot);
    Array.from(parsed.body.childNodes).forEach(node => appendNode(node, documentRoot));
    setMounted(true);

    return () => {
      window.dispatchEvent(new CustomEvent(eventNamesRef.current.dispose));
      externalObserver?.disconnect();
      externalNodes.forEach((node) => {
        if (node === host || host.contains(node)) return;
        if (node.parentNode === document.body || node.parentNode === document.head) {
          node.parentNode.removeChild(node);
        }
      });
      if ((window as any).__XRPDirectRuntimeBridge === bridge) {
        delete (window as any).__XRPDirectRuntimeBridge;
      }
      host.innerHTML = '';
    };
  }, [transformedHtml]);

  useEffect(() => {
    if (!mounted) return;
    window.dispatchEvent(new CustomEvent(eventNamesRef.current.update, {
      detail: {
        type: 'xrp-runtime-update',
        runtime: runtime || {},
        variables: variables || {},
        submission: runtime?.submission || null,
      },
    }));
  }, [mounted, runtime, variables]);

  return <div ref={hostRef} className={className} />;
}
