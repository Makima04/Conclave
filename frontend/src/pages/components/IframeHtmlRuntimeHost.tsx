import React, { useEffect, useRef, useState } from 'react';
import * as api from '../../api/client';

const MIN_IFRAME_HEIGHT = 360;
const MAX_MESSAGE_IFRAME_HEIGHT = 720;
const KNOWN_PARENT_UI_SELECTORS = [
  '#cx-floating-status-root',
  '#cx-floating-status-style',
  '[id^="cx-floating-status-"]',
];

export function cleanupIframeParentRuntimeUi() {
  for (const selector of KNOWN_PARENT_UI_SELECTORS) {
    document.querySelectorAll(selector).forEach(element => element.remove());
  }
}

function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

interface IframeHtmlRuntimeHostProps {
  documentHtml: string;
  className?: string;
  ariaHidden?: boolean;
  tabIndex?: number;
  variables?: Record<string, unknown>;
  runtime?: Record<string, any>;
  sessionId?: string;
  worldBookId?: string;
  onAction?: (action: { action: string; payload: any }) => void | Promise<unknown>;
  /** Called after mutations (replaceVariables, etc.) so the parent can reload state. */
  onMessagesChanged?: () => void;
}

export function IframeHtmlRuntimeHost({
  documentHtml,
  className,
  ariaHidden,
  tabIndex,
  variables,
  runtime,
  sessionId,
  worldBookId,
  onAction,
  onMessagesChanged,
}: IframeHtmlRuntimeHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);  // for cleanup only (no stale closure)
  const [height, setHeight] = useState(520);
  const [viewportFitHeight, setViewportFitHeight] = useState(MIN_IFRAME_HEIGHT);
  const [loaded, setLoaded] = useState(false);
  const [isRendered, setIsRendered] = useState(false);

  // Blob URL for iframe src — avoids `about:srcdoc` null-origin issues.
  // JS-Slash-Runner uses the same pattern (Blob URL or srcdoc).
  // IMPORTANT: blobUrl is state (not just a ref) so EVERY documentHtml change
  // triggers a React re-render — even when loaded is already false. Without this,
  // React skips the re-render and the iframe src stays at the old Blob URL.
  useEffect(() => {
    // ── CRITICAL: Cleanup BEFORE new iframe renders ──
    // Card scripts (thScriptTags in <head>) run before bridge (in <body>),
    // so bridge's cleanup-floating-ui postMessage is too late — the card JS
    // already saw stale parent DOM and skipped creating fresh widgets.
    // Clean up HERE, in React-land, before the new blob URL is set.
    cleanupIframeParentRuntimeUi();

    const runtimeDocumentHtml = documentHtml.replace(
      'window.__XRP_INITIAL_RUNTIME=null;',
      `window.__XRP_INITIAL_RUNTIME=${safeJsonForInlineScript(runtime)};`,
    );

    // Revoke previous blob
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
    }
    const blob = new Blob([runtimeDocumentHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;
    setBlobUrl(url);  // STATE update → always triggers re-render
    setLoaded(false);
    setIsRendered(false);
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [documentHtml]);

  // Viewport-fit height management + ResizeObserver
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

  // postMessage handler: th_api, bridge events, sandbox-resize, rendered
  useEffect(() => {
    async function handleMessage(event: MessageEvent) {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data || {};

      // sandbox-resize
      if (data?.type === 'sandbox-resize') {
        const next = Number(data.height);
        if (Number.isFinite(next)) {
          setHeight(Math.max(MIN_IFRAME_HEIGHT, Math.min(MAX_MESSAGE_IFRAME_HEIGHT, next)));
        }
        return;
      }

      // rendered
      if (data?.type === 'rendered') {
        setIsRendered(true);
        return;
      }

      // cleanup-floating-ui: when iframe is rebuilt (greeting switch),
      // remove stale floating UI DOM injected into parent by old iframe's JS
      if (data?.type === 'cleanup-floating-ui') {
        cleanupIframeParentRuntimeUi();
        return;
      }

      // setVariables / card-sandbox-action (existing bridge)
      if (data?.type === 'setVariables' && data.changes) {
        const payload = data.changes?.variables
          ? data.changes
          : { variables: data.changes, options: { merge: true } };
        onAction?.({ action: 'setVariables', payload });
        return;
      }

      if (data?.type === 'card-sandbox-action' && typeof data.action === 'string') {
        onAction?.({ action: data.action, payload: data.payload || {} });
        return;
      }

      // ── th_api handler ──
      if (data?.type === 'th_api' && data.requestId && data.method) {
        const result = await handleThApi(data.method, data.params || {}, sessionId, worldBookId, onAction);
        iframeRef.current.contentWindow?.postMessage(
          {
            type: 'th_api_response',
            requestId: data.requestId,
            ...result,
          },
          '*',
        );
        // Notify parent of state-affecting mutations
        const mutatingMethods = [
          'setLorebookEntries',
          'mvu_replaceData', 'replaceVariables',
        ];
        if (mutatingMethods.includes(data.method) && !result.error) {
          onMessagesChanged?.();
        }
        return;
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAction, sessionId, worldBookId, onMessagesChanged]);

  // Push variables into iframe on load + variable changes
  useEffect(() => {
    if (!loaded || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'variablesUpdated', variables },
      '*',
    );
  }, [loaded, variables]);

  useEffect(() => {
    if (!loaded || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'runtimeUpdated', runtime, reason: 'host-runtime-change' },
      '*',
    );
  }, [loaded, runtime]);

  return (
    <iframe
      ref={iframeRef}
      className={`${className ?? ''}${isRendered ? ' sandbox-rendered' : ''}`}
      aria-hidden={ariaHidden}
      tabIndex={tabIndex}
      src={blobUrl || undefined}
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

// ── Helpers ──

/** Cache for world book name → ID lookups. */
const worldBookNameCache = new Map<string, string>();

/**
 * Resolve a world book ID from card JS parameters.
 * Card JS passes `bookName` (a display name), but our API uses UUIDs.
 * We cache lookups to avoid repeated listWorldBooks calls.
 */
async function resolveWorldBookId(
  params: Record<string, any>,
  hostWorldBookId?: string,
): Promise<string | undefined> {
  // 1. Card JS passes bookName string
  const bookName: string | undefined = params.bookName;
  if (bookName) {
    if (worldBookNameCache.has(bookName)) {
      return worldBookNameCache.get(bookName);
    }
    const list = await api.listWorldBooks();
    const match = list.items.find(
      (wb: any) => wb.name === bookName || wb.name?.toLowerCase() === bookName.toLowerCase(),
    );
    if (match) {
      worldBookNameCache.set(bookName, match.id);
      return match.id;
    }
    // Try substring match
    const partial = list.items.find(
      (wb: any) => wb.name?.includes(bookName) || bookName.includes(wb.name),
    );
    if (partial) {
      worldBookNameCache.set(bookName, partial.id);
      return partial.id;
    }
  }

  // 2. Fallback: direct worldBookId from params or host
  const directId = params.worldBookId || hostWorldBookId;
  if (directId) return directId;

  return undefined;
}

// ── th_api handler: routes iframe JS-Slash-Runner API calls to our backend ──

async function handleThApi(
  method: string,
  params: Record<string, any>,
  sessionId?: string,
  worldBookId?: string,
  onAction?: (action: { action: string; payload: any }) => void | Promise<unknown>,
): Promise<{ result?: any; error?: string }> {
  try {
    switch (method) {
      // ── Echo / slash commands ──
      case 'triggerSlash': {
        // /echo: let card's local showToast (fallback) handle it visually
        if (/^\/echo\b/i.test(String(params.cmd || ''))) {
          return { error: 'echo handled locally' };
        }
        return { error: 'slash command not supported: ' + (params.cmd || '') };
      }

      // ── World book / lorebook entries ──
      // Card JS calls these with 'bookName' (string), but we also have
      // the host-side 'worldBookId' (UUID) as a fallback.
      case 'getLorebookEntries': {
        const wbId = await resolveWorldBookId(params, worldBookId);
        if (!wbId) return { error: `getLorebookEntries: world book not found (tried: "${params.bookName || ''}")` };
        const detail = await api.getWorldBook(wbId);
        return { result: detail.entries || [] };
      }

      case 'setLorebookEntries': {
        const wbId = await resolveWorldBookId(params, worldBookId);
        if (!wbId) return { error: `setLorebookEntries: world book not found (tried: "${params.bookName || ''}")` };
        const entries = params.entries || [];
        for (const entry of entries) {
          if (entry.id) {
            await api.updateWorldBookEntry(wbId, entry.id, entry);
          }
        }
        return { result: true };
      }

      case 'getLorebookSettings': {
        return { result: { enabled: true } };
      }

      case 'setLorebookSettings': {
        return { result: true };
      }

      // ── Chat messages ──
      case 'getChatMessages': {
        if (!sessionId) return { error: 'getChatMessages: sessionId not available' };
        const data = await api.listMessages(sessionId);
        const messageId = params.messageId;
        // ST convention: -1 means "all messages" (same as undefined/latest)
        if (messageId === -1 || messageId === '-1' || messageId === undefined || messageId === 'latest') {
          return { result: data.items };
        }
        const msg = data.items.find((m: any) => m.id === String(messageId) || m.turn_number === Number(messageId));
        return { result: data.items };
      }

      case 'setChatMessage': {
        // Card JS follows ST convention: may pass message, swipe_id, message_id
        const payload: Record<string, any> = { ...params };
        if (params.message !== undefined) {
          payload.message = String(params.message).trim();
        }
        if (params.swipe_id !== undefined || params.swipeId !== undefined) {
          payload.swipeId = Number(params.swipe_id ?? params.swipeId);
        }
        if (params.message_id !== undefined || params.messageId !== undefined) {
          payload.messageId = String(params.message_id ?? params.messageId);
        }
        if (Object.keys(payload).length > 0) {
          await onAction?.({ action: 'setChatMessage', payload });
        }
        return { result: true };
      }

      case 'setChatMessages': {
        const messages = params.messages || [];
        for (const msg of messages) {
          // Card JS follows ST convention: {message_id, swipe_id}
          // Normalize to camelCase for downstream handlers.
          const payload: Record<string, any> = msg && typeof msg === 'object' ? { ...msg } : {};
          if (msg.message !== undefined) {
            payload.message = String(msg.message).trim();
          }
          if (msg.swipe_id !== undefined || msg.swipeId !== undefined) {
            payload.swipeId = Number(msg.swipe_id ?? msg.swipeId);
          }
          if (msg.message_id !== undefined || msg.messageId !== undefined) {
            payload.messageId = String(msg.message_id ?? msg.messageId);
          }
          if (Object.keys(payload).length > 0) {
            await onAction?.({ action: 'setChatMessage', payload });
          }
        }
        return { result: true };
      }

      // ── Variables / state ──
      case 'mvu_getData': {
        if (!sessionId) return { error: 'mvu_getData: sessionId not available' };
        const state = await api.getSessionState(sessionId);
        return { result: { stat_data: state || {}, initialized_lorebooks: {} } };
      }

      case 'mvu_replaceData': {
        if (!sessionId) return { error: 'mvu_replaceData: sessionId not available' };
        const mvuData = params.data || {};
        const statData = mvuData.stat_data || {};
        await api.updateSessionVariables(sessionId, statData, true);
        return { result: true };
      }

      case 'getVariables': {
        if (!sessionId) return { error: 'getVariables: sessionId not available' };
        const state = await api.getSessionState(sessionId);
        return { result: state || {} };
      }

      case 'replaceVariables': {
        if (!sessionId) return { error: 'replaceVariables: sessionId not available' };
        await api.updateSessionVariables(sessionId, params.data || {}, true);
        return { result: true };
      }

      // ── Generation ──
      case 'generate': {
        if (!sessionId) return { error: 'generate: sessionId not available' };
        // Use quiet generate for card-triggered generation
        const response = await api.quietGenerate(
          sessionId,
          {
            source: 'card-ui-generate',
            prompt: params.prompt || '',
            instruct: params.instruct,
            stop: params.stop,
            genId: params.genId,
          },
        );
        return { result: response };
      }

      case 'stopGeneration': {
        // No-op: generation stop is managed by the host
        return { result: true };
      }

      // ── Extension prompts / injection ──
      case 'setExtensionPrompt': {
        // Card can request prompt injection for next generation
        return { result: true };
      }

      case 'injectPrompts': {
        return { result: true };
      }

      case 'uninjectPrompts': {
        return { result: true };
      }

      // ── Utility ──
      case 'getLastMessageId': {
        if (!sessionId) return { error: 'getLastMessageId: sessionId not available' };
        const data = await api.listMessages(sessionId);
        const items = data.items || [];
        return { result: items.length > 0 ? items[items.length - 1].turn_number : -1 };
      }

      case 'substitudeMacros': {
        // Basic macro substitution: {{user}} {{char}}
        const text = params.text || '';
        const result = text
          .replace(/\{\{user\}\}/gi, '你')
          .replace(/\{\{char\}\}/gi, '');
        return { result };
      }

      case 'initializeGlobal': {
        return { result: true };
      }

      case 'waitGlobalInitialized': {
        return { result: true };
      }

      default:
        return { error: `Unknown API method: ${method}` };
    }
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}
