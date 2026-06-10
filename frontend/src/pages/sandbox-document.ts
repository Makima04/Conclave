// SillyTavern-style sandbox document builder with MiniQuery shim and bridge script.
// Extracted from Chat.tsx GROUP 10

import { serializeSandboxData } from './card-content';
import { decodeStyleTags } from './sandbox-style-isolation';
import type {
  SandboxRuntimeContext,
} from './sandbox-runtime-types';
import { SANDBOX_DOM_SHIM_SOURCE } from './sandbox-dom-shim';
import { buildSandboxEarlyBridgeSource } from './sandbox-early-bridge';
import { SANDBOX_HOST_BRIDGE_SOURCE } from './sandbox-host-bridge';
import { SANDBOX_INPUT_RUNTIME_SOURCE } from './sandbox-input-runtime';
import { SANDBOX_QUIET_RUNTIME_SOURCE } from './sandbox-quiet-runtime';
import { SANDBOX_ST_COMPAT_RUNTIME_SOURCE } from './sandbox-st-compat-runtime';
import { SANDBOX_STORAGE_RUNTIME_SOURCE } from './sandbox-storage-runtime';
import { SANDBOX_VARIABLE_RUNTIME_SOURCE } from './sandbox-variable-runtime';
import vueGlobalRuntime from 'vue/dist/vue.global.prod.js?raw';

export interface TavernHelperScript {
  name: string;
  content: string;
}

function normalizeSandboxHtml(innerHtml: string): string {
  const source = innerHtml.trim();
  if (/<html[\s\S]*?>[\s\S]*<\/html>/i.test(source)) {
    return source;
  }
  if (/<!doctype\b/i.test(source) || /<head[\s\S]*?>/i.test(source) || /<body[\s\S]*?>/i.test(source)) {
    const headMatch = source.match(/<head[\s\S]*?>([\s\S]*?)<\/head>/i);
    const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const doctype = source.match(/<!doctype[^>]*>/i)?.[0] || '<!doctype html>';
    const head = headMatch?.[1] || '';
    const body = bodyMatch?.[1] || source
      .replace(/<!doctype[^>]*>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<\/?body[^>]*>/gi, '')
      .trim();
    return `${doctype}<html><head>${head}</head><body>${body}</body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${source}</body></html>`;
}

function escapeScriptContent(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

function escapeHtmlAttribute(source: string): string {
  return source
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildTavernHelperDocument(scripts: TavernHelperScript[], variables: any, runtime: SandboxRuntimeContext = {}, scopeSelector?: string): string {
  const body = scripts
    .map((script, index) => {
      const name = script.name || `TavernHelper Script ${index + 1}`;
      return `<script type="module" data-tavern-helper-script="${escapeHtmlAttribute(name)}">\n${escapeScriptContent(script.content)}\n</script>`;
    })
    .join('\n');
  return buildSandboxDocument(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`,
    variables,
    runtime,
    scopeSelector,
  );
}

export function buildSandboxDocument(innerHtml: string, variables: any, runtime: SandboxRuntimeContext = {}, scopeSelector?: string): string {
  let body = normalizeSandboxHtml(innerHtml);
  // Decode encoded style tags and scope CSS selectors to prevent global leakage
  if (scopeSelector) {
    body = decodeStyleTags(body, scopeSelector);
  }
  const variablesJson = serializeSandboxData(variables);
  const runtimeJson = serializeSandboxData(runtime);

  const earlyBridge = buildSandboxEarlyBridgeSource(runtimeJson, variablesJson);

  const shim = `
<script>
${SANDBOX_DOM_SHIM_SOURCE}
</script>
<script>
${vueGlobalRuntime}
</script>`;

  const bridge = `
<style>
img,video{max-width:100%;height:auto;}
</style>
<script>
(() => {
  const directRuntimeBridge = window.__XRPDirectRuntimeBridge && typeof window.__XRPDirectRuntimeBridge === 'object'
    ? window.__XRPDirectRuntimeBridge
    : null;
  const post = (message) => {
    if (directRuntimeBridge && typeof directRuntimeBridge.post === 'function') {
      directRuntimeBridge.post(message);
      return;
    }
    parent.postMessage(message, '*');
  };
${SANDBOX_HOST_BRIDGE_SOURCE}
  const safeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const describeError = (error) => ({
    message: String(error?.message || error || '').slice(0, 1000),
    stack: String(error?.stack || '').slice(0, 2000),
  });
  const postDiagnostic = (event, payload = {}) => post({
    type: 'card-sandbox-action',
    action: 'diagnostic',
    payload: { event, ...payload, at: Date.now() },
  });
  postDiagnostic('st-bridge-start');
  const exposeGlobal = (name, value) => {
    const targets = [window, self, globalThis].filter(Boolean);
    for (const target of targets) {
      try {
        Object.defineProperty(target, name, {
          value,
          writable: true,
          configurable: true,
        });
        continue;
      } catch {}
      try {
        target[name] = value;
      } catch {}
    }
  };
  const previewText = (value, limit = 120) => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, limit);
  ['log', 'warn', 'error'].forEach((level) => {
    const original = console[level] ? console[level].bind(console) : null;
    console[level] = (...args) => {
      try {
        postDiagnostic('console', {
          level,
          message: args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ').slice(0, 1000),
        });
      } catch {}
      original && original(...args);
    };
  });
  const debugTelemetry = new URLSearchParams(window.location.search).has('xrpDebugTelemetry');
  const minFrameHeight = 360;
  const maxSafeFrameHeight = 20000;
  let lastNotifiedHeight = 0;
  let notifyFrame = 0;
  const readHeight = () => {
    const doc = document.documentElement;
    const body = document.body;
    const viewportHeight = window.innerHeight || 0;
    const candidates = [
      doc?.scrollHeight,
      doc?.offsetHeight,
      doc?.clientHeight,
      body?.scrollHeight,
      body?.offsetHeight,
      body?.clientHeight,
      viewportHeight,
    ];
    const sampledElements = body ? [
      body.firstElementChild,
      document.getElementById('app'),
      document.querySelector('[data-xrp-root]'),
      document.querySelector('.view-container'),
      document.querySelector('.cx-launcher'),
      document.querySelector('.phone-shell'),
      document.querySelector('.memory-phone-scroll'),
      document.querySelector('[data-action="open-phone"]'),
    ].filter(Boolean) : [];
    for (const element of sampledElements) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0 && rect.width <= 0) continue;
      candidates.push(rect.bottom + window.scrollY);
      candidates.push(element.scrollHeight);
      candidates.push(element.clientHeight);
      candidates.push(element.offsetHeight);
    }
    const measured = Math.max(...candidates.filter(value => Number.isFinite(value) && value > 0));
    return Math.min(maxSafeFrameHeight, Math.max(minFrameHeight, Math.ceil(measured || viewportHeight || 0) + 16));
  };
  const notify = () => {
    if (notifyFrame) return;
    notifyFrame = requestAnimationFrame(() => {
      notifyFrame = 0;
      const height = readHeight();
      if (Math.abs(height - lastNotifiedHeight) < 8) return;
      lastNotifiedHeight = height;
      post({ type: 'sandbox-resize', height });
      postDiagnostic('resize', { height });
    });
  };
  const initialRuntimeVariables = ${variablesJson};
  const initialRuntimeContext = ${runtimeJson};
  const runtimeSessionId = initialRuntimeContext.sessionId ? String(initialRuntimeContext.sessionId) : '';
  let runtimeProjectionVariables = initialRuntimeVariables;
  let runtimeContext = initialRuntimeContext;
  let runtimePlatformState = initialRuntimeContext.platformState && typeof initialRuntimeContext.platformState === 'object'
    ? initialRuntimeContext.platformState
    : {};
  let runtimeWritableState = initialRuntimeContext.writableState && typeof initialRuntimeContext.writableState === 'object'
    ? initialRuntimeContext.writableState
    : {};
  let runtimeSubmission = runtimeContext.submission && typeof runtimeContext.submission === 'object'
    ? runtimeContext.submission
    : { status: 'idle' };
${SANDBOX_STORAGE_RUNTIME_SOURCE}
  const isRuntimeObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const hasRuntimeObjectContent = (value) => isRuntimeObject(value) && Object.keys(value).length > 0;
  const selectRuntimeVariables = (...values) => {
    const nonEmpty = values.find(hasRuntimeObjectContent);
    if (nonEmpty) return nonEmpty;
    return values.find(isRuntimeObject) || {};
  };
  const normalizeMessage = (message, index) => {
    const source = message && typeof message === 'object' ? message : {};
    const fallbackId = index + 1;
    const id = source.id ?? source.message_id ?? fallbackId;
    const text = source.message ?? source.content ?? '';
    const data = source.data && typeof source.data === 'object' ? source.data : {};
    const messageVariables = selectRuntimeVariables(
      source.variables,
      data.variables,
      data.stat_data,
      data.display_data,
      runtimeProjectionVariables,
    );
    return {
      ...source,
      id,
      message_id: source.message_id ?? id,
      swipe_id: Number.isFinite(Number(source.swipe_id)) ? Number(source.swipe_id) : 0,
      swipes: Array.isArray(source.swipes) ? source.swipes : [],
      message: String(text ?? ''),
      content: String(text ?? ''),
      role: source.role || (source.is_user ? 'user' : 'assistant'),
      is_user: Boolean(source.is_user ?? source.role === 'user'),
      is_system: Boolean(source.is_system ?? source.role === 'system'),
      data: {
        ...data,
        stat_data: selectRuntimeVariables(data.stat_data, messageVariables, runtimeProjectionVariables),
        display_data: selectRuntimeVariables(data.display_data, data.stat_data, messageVariables, runtimeProjectionVariables),
        variables: selectRuntimeVariables(data.variables, messageVariables, runtimeProjectionVariables),
        platform_state: data.platform_state && typeof data.platform_state === 'object' ? data.platform_state : runtimePlatformState,
        writable_state: data.writable_state && typeof data.writable_state === 'object' ? data.writable_state : runtimeWritableState,
      },
      variables: messageVariables,
    };
  };
  let runtimeMessages = [];
  let runtimeMessage = null;
  let runtimeMessagesJson = '[]';
  let runtimeMessageJson = '{}';
  let runtimeMessagesByIdJson = new Map();
  const defaultRuntimeMessages = () => [normalizeMessage({
        message_id: 0,
        id: 0,
        swipe_id: 0,
        swipes: [],
        message: '',
        content: '',
        role: 'assistant',
        data: {},
        variables: runtimeProjectionVariables,
      }, 0)];
  const refreshRuntimeSnapshot = (nextContext, nextVariables) => {
    if (nextVariables && typeof nextVariables === 'object') runtimeProjectionVariables = nextVariables;
    if (nextContext && typeof nextContext === 'object') runtimeContext = nextContext;
    runtimePlatformState = runtimeContext.platformState && typeof runtimeContext.platformState === 'object'
      ? runtimeContext.platformState
      : runtimePlatformState || {};
    runtimeWritableState = runtimeContext.writableState && typeof runtimeContext.writableState === 'object'
      ? runtimeContext.writableState
      : runtimeWritableState || {};
    sharedSaves = Array.isArray(runtimeContext.sharedSaves) ? runtimeContext.sharedSaves : [];
    rebuildSharedSaveCaches();
    seedSharedSaveLocalStorage();
    runtimeSubmission = runtimeContext.submission && typeof runtimeContext.submission === 'object'
      ? runtimeContext.submission
      : { status: 'idle' };
    runtimeMessages = Array.isArray(runtimeContext.messages) && runtimeContext.messages.length
      ? runtimeContext.messages.map(normalizeMessage)
      : defaultRuntimeMessages();
    const requestedCurrentId = runtimeContext.currentMessageId ?? runtimeContext.currentMessage?.message_id ?? runtimeContext.currentMessage?.id;
    runtimeMessage = normalizeMessage(
      runtimeContext.currentMessage || runtimeMessages.find(item => String(item.message_id) === String(requestedCurrentId) || String(item.id) === String(requestedCurrentId)) || runtimeMessages[runtimeMessages.length - 1],
      runtimeMessages.length - 1,
    );
    runtimeMessagesJson = JSON.stringify(runtimeMessages);
    runtimeMessageJson = JSON.stringify(runtimeMessage);
    runtimeMessagesByIdJson = new Map();
    runtimeMessages.forEach(item => {
      const json = JSON.stringify(item);
      runtimeMessagesByIdJson.set(String(item.message_id), json);
      runtimeMessagesByIdJson.set(String(item.id), json);
    });
    window.__XRPRuntime = {
      variables: runtimeProjectionVariables,
      projection: runtimeProjectionVariables,
      platformState: runtimePlatformState,
      writableState: runtimeWritableState,
      messages: runtimeMessages,
      currentMessage: runtimeMessage,
      submission: runtimeSubmission,
    };
    window.__XRPVariables = runtimeProjectionVariables;
  };
  const currentMvuPayload = () => ({
    stat_data: runtimeProjectionVariables,
    display_data: runtimeProjectionVariables,
    variables: runtimeProjectionVariables,
    platform_state: runtimePlatformState,
    writable_state: runtimeWritableState,
    message_id: runtimeMessage?.message_id ?? runtimeMessage?.id ?? null,
    swipe_id: runtimeMessage?.swipe_id ?? 0,
  });
  refreshRuntimeSnapshot(runtimeContext, runtimeProjectionVariables);
  const cloneJsonString = (value) => {
    try { return JSON.parse(value); } catch { return null; }
  };
  const getRuntimeMessageId = () => runtimeMessage.message_id ?? runtimeMessage.id ?? null;
  const textFromCommandLike = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const keys = ['message', 'text', 'input', 'content', 'value'];
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    for (const key of ['user_input', 'userInput', 'prompt']) {
      const candidate = value[key];
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const currentInputMatch = candidate.match(/玩家当前输入[：:]\\s*([^\\n]+)/);
      if (currentInputMatch?.[1]?.trim()) return currentInputMatch[1].trim();
      const userHistoryMatches = Array.from(candidate.matchAll(/\\[user:[^\\]]+\\]\\s*\\n([^\\n]+)/g));
      const latestUserHistory = userHistoryMatches[userHistoryMatches.length - 1]?.[1]?.trim();
      if (latestUserHistory) return latestUserHistory;
      return candidate;
    }
    if (Array.isArray(value.args)) {
      const candidate = value.args.find(item => typeof item === 'string' && item.trim());
      if (candidate) return candidate;
    }
    return '';
  };
  const makeGenerationId = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch {}
    return 'xrp-gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  };
  const generationIdFromRequest = (request) => {
    if (request && typeof request === 'object') {
      const explicit = request.generation_id ?? request.generationId ?? request.id;
      if (explicit != null && String(explicit).trim()) return String(explicit).trim();
    }
    return makeGenerationId();
  };
${SANDBOX_QUIET_RUNTIME_SOURCE}
  const quietGenerateRaw = async (request = {}) => {
    const generationId = generationIdFromRequest(request);
    if (!runtimeSessionId) {
      postDiagnostic('generateRaw-quiet-fallback', {
        reason: 'missing_session_id',
        generationId,
      });
      return '<progress></progress>';
    }
    const payload = quietRequestPayload(request, generationId);
    postDiagnostic('generateRaw-quiet-request', {
      generationId,
      hasOrderedPrompts: Array.isArray(payload.ordered_prompts),
      hasMessages: Array.isArray(payload.messages),
      promptLength: typeof payload.prompt === 'string' ? payload.prompt.length : 0,
    });
    try {
      const result = await requestHost('generateRaw', { request: payload });
      const content = String(result?.content || '');
      postDiagnostic('generateRaw-quiet-result', {
        generationId,
        contentLength: content.length,
        model: String(result?.model || ''),
      });
      return content;
    } catch (error) {
      postDiagnostic('generateRaw-quiet-error', {
        generationId,
        message: String(error?.message || error).slice(0, 1000),
      });
      throw error;
    }
  };
  const pendingGenerationRequests = new Map();
  const stEventTypes = {
    APP_INITIALIZED: 'app_initialized',
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_LOADED: 'chatLoaded',
    CHAT_CREATED: 'chat_created',
    MESSAGE_SENT: 'message_sent',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    MESSAGE_RECEIVED: 'message_received',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SWIPED: 'message_swiped',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
  };
  const settleGenerationRequest = (generationId, status, assistantMessage, error) => {
    const pending = pendingGenerationRequests.get(String(generationId));
    if (!pending) return;
    if (status === 'error') {
      clearTimeout(pending.timeoutId);
      pendingGenerationRequests.delete(String(generationId));
      pending.reject(new Error(String(error || '生成失败')));
      return;
    }
    if (status === 'finalizing' || status === 'done') {
      clearTimeout(pending.timeoutId);
      pendingGenerationRequests.delete(String(generationId));
      pending.resolve(String(assistantMessage || ''));
    }
  };
  const waitForGenerationResult = (generationId) => new Promise((resolve, reject) => {
    const id = String(generationId);
    const timeoutId = window.setTimeout(() => {
      pendingGenerationRequests.delete(id);
      resolve('');
    }, 120000);
    pendingGenerationRequests.set(id, { resolve, reject, timeoutId });
  });
  const submitChatText = (message, source = 'st-input-proxy', generationId = null) => {
    const text = String(message || '').trim().slice(0, 8000);
    if (!text) return false;
    const requestGenerationId = generationId == null ? null : String(generationId);
    post({
      type: 'card-sandbox-action',
      action: 'submitText',
      payload: {
        message: text,
        source,
        sourceMessageId: getRuntimeMessageId(),
        generationId: requestGenerationId,
        clear: true,
      },
    });
    postDiagnostic('submitText', { source, length: text.length, generationId: requestGenerationId });
    return true;
  };
  window.__XRPBridge = Object.freeze({
    applyGreeting: (index) => post({ type: 'card-sandbox-action', action: 'applyGreeting', payload: { index: Number(index) } }),
    readVariables: (paths, options) => readBridgeVariables(paths, options),
    writeVariables: (changes, options) => writeBridgeVariables(changes, options),
    generateRaw: (request) => requestHost('generateRaw', { request }),
    openStatusPanel: () => post({ type: 'card-sandbox-action', action: 'openStatusPanel', payload: {} }),
    submitFreeStart: (payload) => post({
      type: 'card-sandbox-action',
      action: 'submitFreeStart',
      payload: { ...(payload && typeof payload === 'object' ? payload : {}), sourceMessageId: getRuntimeMessageId() },
    }),
  });
  const applyRuntimeUpdate = (data = {}) => {
    if (data?.type !== 'xrp-runtime-update') return;
    refreshRuntimeSnapshot(data.runtime || {}, data.variables || {});
    __emitEvent('VARIABLE_UPDATE_ENDED', currentMvuPayload(), currentMvuPayload());
    __emitMany(['CHAT_CHANGED', window.event_types.CHAT_CHANGED]);
    __emitMany(['MESSAGE_UPDATED', window.event_types.MESSAGE_UPDATED]);
    __emitMany([window.event_types.MESSAGE_RECEIVED, window.event_types.CHARACTER_MESSAGE_RENDERED], window.getLastMessageId(), 'normal');
    if (data.submission) {
      emitGenerationEventsFromSubmission();
      ensureSubmissionOverlay();
    }
  };
  window.addEventListener('message', (event) => {
    applyRuntimeUpdate(event.data || {});
  });
  if (directRuntimeBridge && typeof directRuntimeBridge.updateEventName === 'string') {
    window.addEventListener(directRuntimeBridge.updateEventName, (event) => applyRuntimeUpdate(event.detail || {}));
  }
  window.getCurrentMessageId = () => runtimeMessage.message_id ?? runtimeMessage.id ?? 0;
  window.getLastMessageId = () => {
    const last = runtimeMessages[runtimeMessages.length - 1] || runtimeMessage;
    return last.message_id ?? last.id ?? 0;
  };
  const resolveRuntimeMessage = (options = {}) => {
    const messageId = typeof options === 'object' ? options.message_id ?? options.messageId ?? options.id : options;
    if (messageId === 'latest') return runtimeMessages[runtimeMessages.length - 1] || runtimeMessage;
    if (messageId === 'current' || messageId == null) return runtimeMessage;
    return runtimeMessages.find(item => String(item.message_id) === String(messageId) || String(item.id) === String(messageId)) || runtimeMessage;
  };
${SANDBOX_VARIABLE_RUNTIME_SOURCE}
  const getChatMessages = async () => cloneJsonString(runtimeMessagesJson) || cloneJson(runtimeMessages);
  exposeGlobal('getChatMessages', getChatMessages);
  const getChatMessage = async (messageId) => {
    const id = messageId ?? runtimeMessage.message_id ?? runtimeMessage.id;
    return cloneJsonString(runtimeMessagesByIdJson.get(String(id)) || runtimeMessageJson) || cloneJson(runtimeMessage);
  };
  exposeGlobal('getChatMessage', getChatMessage);
  const getVariables = (option = { type: 'projection' }) => withVariableAliases(getVariableStore(option));
  exposeGlobal('getVariables', getVariables);
  exposeGlobal('getvar', getvar);
  exposeGlobal('getProjectionVariables', () => cloneJson(getVariableStore({ type: 'projection' })));
  exposeGlobal('getLocalVariables', () => cloneJson(getVariableStore({ type: 'local' })));
  exposeGlobal('readVariables', readBridgeVariables);
  exposeGlobal('writeVariables', writeBridgeVariables);
  exposeGlobal('getAllVariables', getAllVariables);
  window.__XRPVariables = runtimeProjectionVariables;
  exposeGlobal('replaceVariables', replaceVariables);
  exposeGlobal('setVariables', replaceVariables);
  exposeGlobal('setvar', setvar);
  exposeGlobal('setProjectionVariables', (variables) => setVariableStore(cloneJson(variables), { type: 'projection' }));
  exposeGlobal('setLocalVariables', (variables) => setVariableStore(cloneJson(variables), { type: 'local' }));
  exposeGlobal('updateVariablesWith', updateVariablesWith);
  const setChatMessage = (message, messageId, options) => {
    const swipeId = Number(options?.swipe_id);
    postDiagnostic('setChatMessage-call', {
      messageId,
      swipeId: Number.isFinite(swipeId) ? swipeId : null,
      hasMessage: Boolean(String(message || '').trim()),
      options: options && typeof options === 'object' ? Object.keys(options).slice(0, 12) : [],
    });
    post({ type: 'card-sandbox-action', action: 'setChatMessage', payload: { message: String(message || '').slice(0, 8000), swipeId: Number.isFinite(swipeId) ? swipeId : undefined } });
  };
  exposeGlobal('setChatMessage', setChatMessage);
  const setChatMessages = async (messages) => {
    const first = Array.isArray(messages) ? messages[0] : null;
    const swipeId = Number(first?.swipe_id);
    postDiagnostic('setChatMessages-call', {
      count: Array.isArray(messages) ? messages.length : 0,
      firstKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 12) : [],
      swipeId: Number.isFinite(swipeId) ? swipeId : null,
      hasMessage: Boolean(String(first?.message || '').trim()),
    });
    if (Number.isFinite(swipeId)) {
      post({ type: 'card-sandbox-action', action: 'applyOpeningSwipe', payload: { swipeId } });
      return;
    }
    if (first?.message) {
      post({ type: 'card-sandbox-action', action: 'setChatMessage', payload: { message: String(first.message).slice(0, 8000) } });
    }
  };
  exposeGlobal('setChatMessages', setChatMessages);
  const triggerSlash = (command) => {
    const directText = textFromCommandLike(command);
    if (directText && submitChatText(directText, 'triggerSlash-object')) return;
    post({
      type: 'card-sandbox-action',
      action: 'triggerSlash',
      payload: {
        command: typeof command === 'string' ? command.slice(0, 2000) : JSON.stringify(command || {}).slice(0, 2000),
        sourceMessageId: getRuntimeMessageId(),
      },
    });
  };
  exposeGlobal('triggerSlash', triggerSlash);
  const generate = async (request = 'normal') => {
    const requestGenerationId = generationIdFromRequest(request);
    const requestText = inputTextFromGenerateRequest(request);
    const stInput = document.getElementById('send_textarea');
    const active = document.activeElement;
    const fields = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"]'))
      .filter(field => isTextField(field) && !field.dataset?.xrpStInputProxy);
    const field = readFieldValue(stInput)
      ? stInput
      : isTextField(active) && !active.dataset?.xrpStInputProxy && readFieldValue(active)
        ? active
        : fields.find(candidate => readFieldValue(candidate));
    const text = requestText || (field ? readFieldValue(field) : '');
    if (submitChatText(text, 'Generate', requestGenerationId)) {
      if (field && field.value !== undefined) {
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (field && field.isContentEditable) {
        field.textContent = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return waitForGenerationResult(requestGenerationId);
    }
    post({ type: 'card-sandbox-action', action: 'triggerSlash', payload: { command: typeof request === 'string' ? request : JSON.stringify(request || {}), sourceMessageId: getRuntimeMessageId(), generationId: requestGenerationId } });
    return waitForGenerationResult(requestGenerationId);
  };
  exposeGlobal('Generate', generate);
  exposeGlobal('generate', generate);
  exposeGlobal('generateRaw', quietGenerateRaw);

  const getMvuData = (options = {}) => {
    const message = resolveRuntimeMessage(options);
    const messageVariables = getVariableStore({
      ...normalizeVariableOption(options || {}),
      type: 'message',
    });
    const data = message?.data && typeof message.data === 'object' ? message.data : {};
    const nonEmptyObject = (value) => (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length > 0
    ) ? value : null;
    const statData = nonEmptyObject(data.stat_data) || nonEmptyObject(messageVariables) || runtimeProjectionVariables || {};
    const displayData = nonEmptyObject(data.display_data) || statData;
    const variables = nonEmptyObject(data.variables) || statData;
    const platformState = nonEmptyObject(data.platform_state) || runtimePlatformState || {};
    const writableState = nonEmptyObject(data.writable_state) || runtimeWritableState || {};
    return cloneJson({
      stat_data: statData,
      display_data: displayData,
      variables,
      platform_state: platformState,
      writable_state: writableState,
      message_id: message?.message_id ?? message?.id,
      swipe_id: message?.swipe_id ?? 0,
    });
  };
  exposeGlobal('getMvuData', getMvuData);
  const replaceMvuData = (data, options = {}) => {
    const next = data?.stat_data || data?.variables || data || {};
    const normalized = normalizeVariableOption(options || {});
    const targetType = normalized.type && normalized.type !== 'projection'
      ? normalized.type
      : 'message';
    setVariableStore(next && typeof next === 'object' ? next : {}, { ...normalized, type: targetType });
    __emitEvent('VARIABLE_UPDATE_ENDED', data, options);
    return true;
  };
  exposeGlobal('replaceMvuData', replaceMvuData);
${SANDBOX_ST_COMPAT_RUNTIME_SOURCE}
${SANDBOX_INPUT_RUNTIME_SOURCE}
  const ensureSubmissionOverlay = () => {
    const status = String(runtimeSubmission.status || 'idle');
    if (!['pending', 'streaming', 'finalizing', 'error'].includes(status)) return;
    const existing = document.querySelector('[data-xrp-submission-overlay]');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.dataset.xrpSubmissionOverlay = 'true';
    overlay.setAttribute('role', status === 'error' ? 'alert' : 'status');
    overlay.setAttribute('aria-live', 'polite');
    const label = status === 'error'
      ? (runtimeSubmission.error || '生成失败')
      : status === 'finalizing'
        ? '正在整理...'
        : '生成中...';
    overlay.innerHTML = '<span data-xrp-submission-dot></span><span data-xrp-submission-text></span>';
    overlay.querySelector('[data-xrp-submission-text]').textContent = label;
    const style = document.createElement('style');
    style.dataset.xrpSubmissionOverlayStyle = 'true';
    style.textContent = [
      '[data-xrp-submission-overlay]{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:9px;max-width:min(360px,calc(100vw - 36px));padding:10px 13px;border-radius:8px;background:rgba(15,12,22,.88);color:#f6eef6;border:1px solid rgba(255,255,255,.16);box-shadow:0 12px 30px rgba(0,0,0,.24);font:600 13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;backdrop-filter:blur(10px)}',
      '[data-xrp-submission-dot]{width:8px;height:8px;border-radius:999px;background:#73d7a4;box-shadow:0 0 0 4px rgba(115,215,164,.18);animation:xrpSubmissionPulse 1.2s ease-in-out infinite;flex:0 0 auto}',
      '[data-xrp-submission-overlay][role=\"alert\"] [data-xrp-submission-dot]{background:#ff6f91;box-shadow:0 0 0 4px rgba(255,111,145,.18)}',
      '[data-xrp-submission-text]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@keyframes xrpSubmissionPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}',
    ].join('');
    if (!document.querySelector('[data-xrp-submission-overlay-style]')) {
      document.head.appendChild(style);
    }
    document.body.appendChild(overlay);
    notify();
  };

  bindChatInputInteractions();
  ensureSillyTavernInputProxy();
  ensureSubmissionOverlay();
  document.addEventListener('DOMContentLoaded', ensureSillyTavernInputProxy, { once: true });
  const resizeObserver = new ResizeObserver(notify);
  resizeObserver.observe(document.documentElement);
  if (document.body) resizeObserver.observe(document.body);
  const mutationObserver = new MutationObserver(notify);
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  window.addEventListener('load', notify);
  setTimeout(notify, 80);
  setTimeout(notify, 500);
  setTimeout(notify, 1200);
  postDiagnostic('sandbox-ready', {
    vueLoaded: Boolean(window.Vue),
    bodyChildren: document.body ? document.body.children.length : 0,
  });
  setTimeout(() => {
    postDiagnostic('health', {
      vueLoaded: Boolean(window.Vue),
      bodyChildren: document.body ? document.body.children.length : 0,
      textLength: document.body ? safeText(document.body.innerText || document.body.textContent).length : 0,
      height: readHeight(),
    });
  }, 1200);

  // Emit initialization events so Vue/MVU code can proceed
  requestAnimationFrame(() => {
    __emitMany(['APP_READY', window.event_types.APP_READY]);
    __emitEvent('GLOBAL_INITIALIZED');
    __emitEvent('VARIABLE_UPDATE_ENDED', currentMvuPayload(), currentMvuPayload());
    __emitMany(['CHAT_CHANGED', window.event_types.CHAT_CHANGED]);
    __emitMany(['MESSAGE_SWIPED', window.event_types.MESSAGE_SWIPED]);
  });

  // Notify the host that the sandbox content is rendered and visible
  setTimeout(() => {
    post({ type: 'card-sandbox-action', action: 'rendered', payload: { at: Date.now() } });
  }, 100);
})();
</script>`;

  const injected = `${earlyBridge}${shim}${bridge}`;
  if (/<head[\s\S]*?>/i.test(body)) {
    return body.replace(/<head([\s\S]*?)>/i, `<head$1>${injected}`);
  }
  if (/<script\b/i.test(body)) {
    return body.replace(/<script\b/i, `${injected}<script`);
  }
  if (/<\/body>/i.test(body)) {
    return body.replace(/<\/body>/i, `${injected}</body>`);
  }
  return `${injected}${body}`;
}
