// SillyTavern-style sandbox document builder with MiniQuery shim and bridge script.
// Extracted from Chat.tsx GROUP 10

import { serializeSandboxData } from './card-content';
import vueGlobalRuntime from 'vue/dist/vue.global.prod.js?raw';

export interface SandboxRuntimeMessage {
  id: string | number;
  message_id: string | number;
  swipe_id?: number;
  swipes?: string[];
  role?: string;
  name?: string;
  message?: string;
  content?: string;
  created_at?: string;
  send_date?: string;
  turn_number?: number;
  is_user?: boolean;
  is_system?: boolean;
  data?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

export interface SandboxRuntimeContext {
  sessionId?: string | null;
  messages?: SandboxRuntimeMessage[];
  currentMessage?: SandboxRuntimeMessage | null;
  currentMessageId?: string | number | null;
  sharedSaves?: SandboxSharedSave[];
  submission?: SandboxRuntimeSubmission | null;
}

export interface SandboxSharedSave {
  saveId: string;
  sessionId: string;
  runId?: string;
  meta: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface SandboxRuntimeSubmission {
  status: 'idle' | 'pending' | 'streaming' | 'finalizing' | 'error' | 'done';
  sourceMessageId?: string | number | null;
  generationId?: string | number | null;
  userMessage?: string;
  assistantMessage?: string;
  error?: string | null;
  updatedAt?: number;
}

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

export function buildTavernHelperDocument(scripts: TavernHelperScript[], variables: any, runtime: SandboxRuntimeContext = {}): string {
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
  );
}

export function buildSandboxDocument(innerHtml: string, variables: any, runtime: SandboxRuntimeContext = {}): string {
  const body = normalizeSandboxHtml(innerHtml);
  const variablesJson = serializeSandboxData(variables);
  const runtimeJson = serializeSandboxData(runtime);

  const earlyBridge = `
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
  const postEarlyDiagnostic = (event, payload = {}) => post({
    type: 'card-sandbox-action',
    action: 'diagnostic',
    payload: { event, ...payload, at: Date.now() },
  });
  window.addEventListener('error', (event) => {
    postEarlyDiagnostic('early-window-error', {
      message: String(event.message || '').slice(0, 1000),
      source: String(event.filename || '').slice(0, 500),
      lineno: event.lineno,
      colno: event.colno,
      stack: String(event.error?.stack || '').slice(0, 2000),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    postEarlyDiagnostic('early-unhandledrejection', {
      message: String(reason?.message || reason || '').slice(0, 1000),
      stack: String(reason?.stack || '').slice(0, 2000),
    });
  });
  const globalNames = [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'eventOn',
    'eventOff',
    'eventEmit',
    'eventSource',
    'event_types',
    'eventTypes',
    'tavern_events',
    'iframe_events',
    'Generate',
    'generate',
    'generateRaw',
    'SillyTavern',
    'TavernHelper',
    'Mvu',
    'insertVariables',
    'registerMvuSchema',
    'waitGlobalInitialized',
    'updateTavernRegexesWith',
    'z',
  ];
  if (!window.__XRPOriginalGlobals) {
    window.__XRPOriginalGlobals = {};
    globalNames.forEach((name) => {
      window.__XRPOriginalGlobals[name] = {
        descriptor: Object.getOwnPropertyDescriptor(window, name) || null,
        hadOwn: Object.prototype.hasOwnProperty.call(window, name),
      };
    });
  }
  const restoreOriginalGlobals = () => {
    if (!directRuntimeBridge?.preserveTavernGlobals && document.querySelector('.session-tavern-helper-runtime-host')) {
      return;
    }
    const originals = window.__XRPOriginalGlobals || {};
    globalNames.forEach((name) => {
      const original = originals[name];
      try {
        if (original?.descriptor) {
          Object.defineProperty(window, name, original.descriptor);
        } else if (original?.hadOwn) {
          window[name] = undefined;
        } else {
          delete window[name];
        }
      } catch {}
    });
    try { delete window.__XRPOriginalGlobals; } catch {}
    try { delete window.__XRPEventHandlers; } catch {}
  };
  if (directRuntimeBridge && typeof directRuntimeBridge.disposeEventName === 'string') {
    window.addEventListener(directRuntimeBridge.disposeEventName, restoreOriginalGlobals, { once: true });
  }
  const eventHandlers = window.__XRPEventHandlers instanceof Map ? window.__XRPEventHandlers : new Map();
  window.__XRPEventHandlers = eventHandlers;
  const resolveEventName = (eventName) => {
    if (typeof eventName === 'string') return eventName;
    if (eventName && typeof eventName === 'object') {
      const values = Object.values(eventName);
      if (values.length === 1 && typeof values[0] === 'string') return values[0];
      if (typeof eventName.name === 'string') return eventName.name;
      if (typeof eventName.event === 'string') return eventName.event;
    }
    return String(eventName);
  };
  window.eventOff = window.eventOff || ((eventName, handler) => {
    const handlers = eventHandlers.get(resolveEventName(eventName));
    handlers && handlers.delete(handler);
  });
  window.eventOn = window.eventOn || ((eventName, handler) => {
    if (typeof handler !== 'function') return { stop: () => {} };
    const name = resolveEventName(eventName);
    if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
    eventHandlers.get(name).add(handler);
    return { stop: () => window.eventOff(name, handler) };
  });
  window.eventEmit = window.eventEmit || ((eventName, ...args) => {
    const handlers = eventHandlers.get(resolveEventName(eventName));
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(...args); } catch (error) { console.error('[xrp early event handler]', error); }
    }
  });
  window.iframe_events = window.iframe_events || {
    MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
    MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_STARTED: 'js_generation_started',
    STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
    GENERATION_ENDED: 'js_generation_ended',
  };
  const legacyIframeEvents = {
    GENERATION_STARTED: 'GENERATION_STARTED',
    STREAM_TOKEN_RECEIVED_FULLY: 'STREAM_TOKEN_RECEIVED_FULLY',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'STREAM_TOKEN_RECEIVED_INCREMENTALLY',
    GENERATION_ENDED: 'GENERATION_ENDED',
  };
  window.event_types = window.event_types || {
    APP_INITIALIZED: 'app_initialized',
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_UPDATED: 'message_updated',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    GENERATION_STOPPED: 'generation_stopped',
  };
  window.eventTypes = window.eventTypes || window.event_types;
  window.eventSource = window.eventSource || {
    on: (eventName, handler) => window.eventOn(eventName, handler),
    makeLast: (eventName, handler) => window.eventOn(eventName, handler),
    once: (eventName, handler) => {
      const subscription = window.eventOn(eventName, (...args) => {
        subscription.stop();
        handler(...args);
      });
      return subscription;
    },
    removeListener: (eventName, handler) => window.eventOff(eventName, handler),
    off: (eventName, handler) => window.eventOff(eventName, handler),
    emit: async (eventName, ...args) => window.eventEmit(eventName, ...args),
    emitAndWait: async (eventName, ...args) => window.eventEmit(eventName, ...args),
  };
  const makeGenerationId = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch {}
    return 'xrp-gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  };
  const earlyRuntimeContext = ${runtimeJson};
  const earlyRuntimeSessionId = earlyRuntimeContext?.sessionId ? String(earlyRuntimeContext.sessionId) : '';
  const exposeEarlyGlobal = (name, value) => {
    for (const target of [window, self, globalThis].filter(Boolean)) {
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
  const cloneEarlyJson = (value) => {
    try {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  };
  const makeEarlyZodShim = () => {
    const chainMethods = [
      'array',
      'brand',
      'catch',
      'default',
      'describe',
      'max',
      'min',
      'nullable',
      'nullish',
      'optional',
      'or',
      'prefault',
      'readonly',
      'refine',
      'regex',
      'superRefine',
      'transform',
    ];
    const makeSchema = (kind = 'any', definition = null) => {
      const schema = {
        _def: { typeName: kind, definition },
        _xrpZodShim: true,
        parse: (value) => value,
        safeParse: (value) => ({ success: true, data: value }),
        unwrap: () => schema,
      };
      chainMethods.forEach((method) => {
        schema[method] = (...args) => {
          if (method === 'array') return makeSchema('array', schema);
          if (method === 'or') return makeSchema('union', [schema, args[0]]);
          return schema;
        };
      });
      return schema;
    };
    const z = {
      any: () => makeSchema('any'),
      array: (schema) => makeSchema('array', schema),
      boolean: () => makeSchema('boolean'),
      coerce: {
        boolean: () => makeSchema('coerce.boolean'),
        number: () => makeSchema('coerce.number'),
        string: () => makeSchema('coerce.string'),
      },
      date: () => makeSchema('date'),
      discriminatedUnion: (key, schemas) => makeSchema('discriminatedUnion', { key, schemas }),
      enum: (values) => makeSchema('enum', values),
      literal: (value) => makeSchema('literal', value),
      nativeEnum: (values) => makeSchema('nativeEnum', values),
      never: () => makeSchema('never'),
      null: () => makeSchema('null'),
      nullable: (schema) => (schema && typeof schema.nullable === 'function' ? schema.nullable() : makeSchema('nullable', schema)),
      number: () => makeSchema('number'),
      object: (shape = {}) => {
        const schema = makeSchema('object', shape);
        schema.shape = shape;
        schema.extend = (extra = {}) => z.object({ ...(schema.shape || {}), ...extra });
        schema.merge = (other) => z.object({ ...(schema.shape || {}), ...(other?.shape || {}) });
        schema.partial = () => schema;
        schema.pick = () => schema;
        schema.omit = () => schema;
        schema.passthrough = () => schema;
        schema.strict = () => schema;
        return schema;
      },
      optional: (schema) => (schema && typeof schema.optional === 'function' ? schema.optional() : makeSchema('optional', schema)),
      record: (...args) => makeSchema('record', args),
      string: () => makeSchema('string'),
      tuple: (schemas) => makeSchema('tuple', schemas),
      undefined: () => makeSchema('undefined'),
      union: (schemas) => makeSchema('union', schemas),
      unknown: () => makeSchema('unknown'),
    };
    return z;
  };
  exposeEarlyGlobal('z', window.z || makeEarlyZodShim());
  const earlyRuntimeMessages = Array.isArray(earlyRuntimeContext?.messages) ? earlyRuntimeContext.messages : [];
  const earlyInitialVariables = ${variablesJson};
  let earlyVariableStore = cloneEarlyJson(
    earlyInitialVariables && typeof earlyInitialVariables === 'object' ? earlyInitialVariables : {},
  ) || {};
  const normalizeEarlyMessageId = (messageId) => {
    const number = Number(messageId);
    if (!Number.isFinite(number)) return null;
    const index = Math.trunc(number);
    return index < 0 ? earlyRuntimeMessages.length + index : index;
  };
  const roleOfEarlyMessage = (message) => {
    const role = String(message?.role || '').toLowerCase();
    if (role === 'user' || role === 'assistant' || role === 'system') return role;
    if (message?.is_user === true) return 'user';
    if (message?.is_system === true) return 'system';
    return 'assistant';
  };
  const toEarlyChatMessage = (message, messageId, includeSwipes = false) => {
    const swipeId = Number(message?.swipe_id ?? 0);
    const content = String(message?.message ?? message?.content ?? '');
    const swipes = Array.isArray(message?.swipes) && message.swipes.length > 0 ? message.swipes : [content];
    const data = message?.data && typeof message.data === 'object' ? message.data : {};
    const extra = message?.extra && typeof message.extra === 'object' ? message.extra : {};
    const base = {
      message_id: messageId,
      name: String(message?.name || ''),
      role: roleOfEarlyMessage(message),
      is_hidden: Boolean(message?.is_system),
    };
    if (includeSwipes) {
      return {
        ...base,
        swipe_id: Number.isFinite(swipeId) ? swipeId : 0,
        swipes,
        swipes_data: Array.isArray(message?.variables) ? message.variables : swipes.map(() => data),
        swipes_info: Array.isArray(message?.swipe_info) ? message.swipe_info : swipes.map(() => extra),
      };
    }
    return {
      ...base,
      message: content,
      data,
      extra,
      swipe_id: Number.isFinite(swipeId) ? swipeId : 0,
      swipes,
      swipes_data: Array.isArray(message?.variables) ? message.variables : swipes.map(() => data),
    };
  };
  const parseEarlyMessageRange = (range) => {
    if (earlyRuntimeMessages.length === 0) return [];
    const source = String(range ?? '0-' + (earlyRuntimeMessages.length - 1)).trim();
    const normalize = (value) => {
      const id = normalizeEarlyMessageId(value);
      if (id == null) return null;
      return Math.max(0, Math.min(earlyRuntimeMessages.length - 1, id));
    };
    const single = source.match(/^-?\\d+$/);
    if (single) {
      const id = normalize(source);
      return id == null ? [] : [id];
    }
    const pair = source.match(/^(-?\\d+)\\s*-\\s*(-?\\d+)$/);
    if (!pair) return [];
    const start = normalize(pair[1]);
    const end = normalize(pair[2]);
    if (start == null || end == null) return [];
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    return Array.from({ length: max - min + 1 }, (_, offset) => min + offset);
  };
  const earlyGetChatMessages = (range = '0-' + Math.max(0, earlyRuntimeMessages.length - 1), options = {}) => {
    const includeSwipes = options?.include_swipes === true;
    const role = options?.role || 'all';
    const hideState = options?.hide_state || 'all';
    const result = parseEarlyMessageRange(range)
      .map(messageId => {
        const message = earlyRuntimeMessages[messageId];
        return message ? toEarlyChatMessage(message, messageId, includeSwipes) : null;
      })
      .filter(Boolean)
      .filter(message => role === 'all' || message.role === role)
      .filter(message => hideState === 'all' || (hideState === 'hidden') === message.is_hidden);
    return cloneEarlyJson(result);
  };
  const earlySetChatMessages = async (messages, options = {}) => {
    const list = Array.isArray(messages) ? messages : [];
    const first = list[0];
    const swipeId = Number(first?.swipe_id);
    postEarlyDiagnostic('early-setChatMessages-call', {
      count: list.length,
      firstKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 12) : [],
      swipeId: Number.isFinite(swipeId) ? swipeId : null,
      refresh: String(options?.refresh || ''),
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
  const earlySetChatMessage = async (fieldValues, messageId, options = {}) => {
    const value = typeof fieldValues === 'string' ? { message: fieldValues } : (fieldValues || {});
    const swipeId = Number(options?.swipe_id);
    postEarlyDiagnostic('early-setChatMessage-call', {
      messageId,
      swipeId: Number.isFinite(swipeId) ? swipeId : null,
      hasMessage: Boolean(String(value?.message || '').trim()),
    });
    if (Number.isFinite(swipeId)) {
      post({ type: 'card-sandbox-action', action: 'applyOpeningSwipe', payload: { swipeId } });
      return;
    }
    if (value?.message) {
      post({ type: 'card-sandbox-action', action: 'setChatMessage', payload: { message: String(value.message).slice(0, 8000) } });
    }
  };
  exposeEarlyGlobal('getChatMessages', earlyGetChatMessages);
  exposeEarlyGlobal('setChatMessages', earlySetChatMessages);
  exposeEarlyGlobal('setChatMessage', earlySetChatMessage);
  const earlyGetVariables = async () => cloneEarlyJson(earlyVariableStore);
  const earlySetVariables = async (variables) => {
    earlyVariableStore = cloneEarlyJson(variables && typeof variables === 'object' ? variables : {}) || {};
    window.eventEmit?.('VARIABLE_UPDATE_ENDED', { stat_data: earlyVariableStore, variables: earlyVariableStore });
    return true;
  };
  const earlyGetMvuData = async (options = {}) => {
    const messageIndex = normalizeEarlyMessageId(options?.message_id ?? options?.messageId ?? -1);
    const message = messageIndex == null ? null : earlyRuntimeMessages[messageIndex];
    const data = message?.data && typeof message.data === 'object' ? message.data : {};
    const variables = data.variables || data.stat_data || earlyVariableStore;
    return cloneEarlyJson({
      stat_data: variables,
      display_data: data.display_data || variables,
      variables,
      message_id: message?.message_id ?? message?.id ?? messageIndex,
      swipe_id: message?.swipe_id ?? 0,
    });
  };
  const earlyReplaceMvuData = async (data) => {
    const next = data?.stat_data || data?.variables || data || {};
    await earlySetVariables(next && typeof next === 'object' ? next : {});
    return true;
  };
  exposeEarlyGlobal('getVariables', earlyGetVariables);
  exposeEarlyGlobal('getAllVariables', earlyGetVariables);
  exposeEarlyGlobal('setVariables', earlySetVariables);
  exposeEarlyGlobal('getMvuData', earlyGetMvuData);
  exposeEarlyGlobal('replaceMvuData', earlyReplaceMvuData);
  const earlyMvu = window.Mvu || {
    events: { VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED' },
    getMvuData: earlyGetMvuData,
    replaceMvuData: earlyReplaceMvuData,
    insertVariables: async (variables = {}) => {
      await earlySetVariables({ ...(earlyVariableStore || {}), ...(variables || {}) });
      return true;
    },
    setVariables: earlySetVariables,
    getVariables: earlyGetVariables,
  };
  exposeEarlyGlobal('Mvu', earlyMvu);
  exposeEarlyGlobal('insertVariables', (...args) => window.Mvu.insertVariables(...args));
  exposeEarlyGlobal('registerMvuSchema', (schema) => {
    window.__XRPRegisteredMvuSchema = schema;
    return schema;
  });
  exposeEarlyGlobal('updateTavernRegexesWith', async () => true);
  const emittedEarlyEvents = new Set();
  const originalEarlyEventEmit = window.eventEmit;
  window.eventEmit = (...args) => {
    emittedEarlyEvents.add(resolveEventName(args[0]));
    return originalEarlyEventEmit?.(...args);
  };
  exposeEarlyGlobal('eventEmit', window.eventEmit);
  exposeEarlyGlobal('waitGlobalInitialized', (name) => {
    const moduleName = String(name || '').toLowerCase();
    const makeResult = () => {
      if (moduleName === 'mvu') return window.Mvu;
      return null;
    };
    if (emittedEarlyEvents.has('GLOBAL_INITIALIZED')) return Promise.resolve(makeResult());
    return new Promise((resolve) => {
      const subscription = window.eventOn('GLOBAL_INITIALIZED', () => {
        subscription.stop();
        resolve(makeResult());
      });
      setTimeout(() => resolve(makeResult()), 0);
    });
  });
  const quietGenerationIdFromRequest = (request) => {
    if (request && typeof request === 'object') {
      const explicit = request.generation_id ?? request.generationId ?? request.id;
      if (explicit != null && String(explicit).trim()) return String(explicit).trim();
    }
    return makeGenerationId();
  };
  const quietRequestPayload = (request, generationId) => {
    if (typeof request === 'string') return { prompt: request, generation_id: generationId };
    if (Array.isArray(request)) return { ordered_prompts: request, generation_id: generationId };
    if (request && typeof request === 'object') {
      return {
        ...request,
        generation_id: request.generation_id ?? request.generationId ?? generationId,
      };
    }
    return { prompt: '', generation_id: generationId };
  };
  const quietAuthHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const token = window.localStorage?.getItem('api_auth_token') || '';
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch {}
    return headers;
  };
  const quietGenerateRaw = async (request = {}) => {
    const generationId = quietGenerationIdFromRequest(request);
    if (!earlyRuntimeSessionId) {
      post({
        type: 'card-sandbox-action',
        action: 'diagnostic',
        payload: {
          event: 'generateRaw-quiet-fallback',
          reason: 'missing_session_id',
          generationId,
          at: Date.now(),
        },
      });
      return '<progress></progress>';
    }
    const payload = quietRequestPayload(request, generationId);
    post({
      type: 'card-sandbox-action',
      action: 'diagnostic',
      payload: {
        event: 'generateRaw-quiet-request',
        generationId,
        hasOrderedPrompts: Array.isArray(payload.ordered_prompts),
        hasMessages: Array.isArray(payload.messages),
        promptLength: typeof payload.prompt === 'string' ? payload.prompt.length : 0,
        at: Date.now(),
      },
    });
    const response = await fetch('/api/sessions/' + encodeURIComponent(earlyRuntimeSessionId) + '/quiet-generate', {
      method: 'POST',
      headers: quietAuthHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body?.error?.message || ('HTTP ' + response.status);
      post({
        type: 'card-sandbox-action',
        action: 'diagnostic',
        payload: {
          event: 'generateRaw-quiet-error',
          generationId,
          status: response.status,
          message: String(message).slice(0, 1000),
          at: Date.now(),
        },
      });
      throw new Error(String(message));
    }
    const data = await response.json();
    const content = String(data?.content || '');
    post({
      type: 'card-sandbox-action',
      action: 'diagnostic',
      payload: {
        event: 'generateRaw-quiet-result',
        generationId,
        contentLength: content.length,
        model: String(data?.model || ''),
        at: Date.now(),
      },
    });
    return content;
  };
  const textFromGenerateRequest = (request) => {
    if (typeof request === 'string') return request;
    if (!request || typeof request !== 'object') return '';
    for (const key of ['message', 'text', 'input', 'content', 'value']) {
      const value = request[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    for (const key of ['user_input', 'userInput', 'prompt']) {
      const value = request[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const currentInputMatch = value.match(/玩家当前输入[：:]\\s*([^\\n]+)/);
      if (currentInputMatch?.[1]?.trim()) return currentInputMatch[1].trim();
      const userHistoryMatches = Array.from(value.matchAll(/\\[user:[^\\]]+\\]\\s*\\n([^\\n]+)/g));
      const latestUserHistory = userHistoryMatches[userHistoryMatches.length - 1]?.[1]?.trim();
      if (latestUserHistory) return latestUserHistory;
      return value;
    }
    if (Array.isArray(request.ordered_prompts)) {
      return request.ordered_prompts
        .map(item => item && typeof item === 'object' ? item.content : item)
        .filter(item => typeof item === 'string' && item.trim())
        .join('\\n\\n');
    }
    return '';
  };
  const pendingGenerations = new Map();
  const settleGeneration = (generationId, assistantMessage = '') => {
    const pending = pendingGenerations.get(String(generationId));
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingGenerations.delete(String(generationId));
    pending.resolve(String(assistantMessage || ''));
  };
  const waitForGeneration = (generationId) => new Promise((resolve) => {
    const id = String(generationId);
    const timeoutId = window.setTimeout(() => {
      pendingGenerations.delete(id);
      resolve('');
    }, 120000);
    pendingGenerations.set(id, { resolve, timeoutId });
  });
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data?.type !== 'xrp-runtime-update') return;
    const submission = data.runtime?.submission || data.submission || null;
    if (!submission || typeof submission !== 'object') return;
    const generationId = String(submission.generationId || submission.sourceMessageId || '');
    const status = String(submission.status || '');
    const assistantMessage = String(submission.assistantMessage || '');
    if (!generationId || !pendingGenerations.has(generationId)) return;
    if (assistantMessage && (status === 'streaming' || status === 'finalizing' || status === 'done')) {
      window.eventEmit?.(window.iframe_events.STREAM_TOKEN_RECEIVED_FULLY, assistantMessage, generationId);
      window.eventEmit?.(legacyIframeEvents.STREAM_TOKEN_RECEIVED_FULLY, assistantMessage, generationId);
      window.eventEmit?.(window.iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY, assistantMessage, generationId);
      window.eventEmit?.(legacyIframeEvents.STREAM_TOKEN_RECEIVED_INCREMENTALLY, assistantMessage, generationId);
      window.eventEmit?.(window.event_types.STREAM_TOKEN_RECEIVED, assistantMessage, generationId);
    }
    if (status === 'finalizing' || status === 'done' || status === 'error') {
      window.eventEmit?.(window.iframe_events.GENERATION_ENDED, assistantMessage, generationId);
      window.eventEmit?.(legacyIframeEvents.GENERATION_ENDED, assistantMessage, generationId);
      window.eventEmit?.(window.event_types.GENERATION_ENDED, assistantMessage, generationId);
      settleGeneration(generationId, assistantMessage);
    }
  });
  if (directRuntimeBridge && typeof directRuntimeBridge.updateEventName === 'string') {
    window.addEventListener(directRuntimeBridge.updateEventName, (event) => {
      const detail = event.detail || {};
      window.dispatchEvent(new MessageEvent('message', { data: detail }));
    });
  }
  window.generate = window.Generate = window.generate || window.Generate || (async (request = {}) => {
    const generationId = String(request?.generation_id || request?.generationId || makeGenerationId());
    const message = textFromGenerateRequest(request).trim();
    window.eventEmit?.(window.iframe_events.GENERATION_STARTED, generationId);
    window.eventEmit?.(legacyIframeEvents.GENERATION_STARTED, generationId);
    window.eventEmit?.(window.event_types.GENERATION_STARTED, generationId);
    post({
      type: 'card-sandbox-action',
      action: 'submitText',
      payload: {
        message,
        source: 'early-generate',
        sourceMessageId: 'card-runtime',
        generationId,
        clear: true,
      },
    });
    return waitForGeneration(generationId);
  });
  window.generateRaw = window.generateRaw || quietGenerateRaw;
  window.SillyTavern = window.SillyTavern || {};
  window.SillyTavern.getContext = window.SillyTavern.getContext || (() => ({
    chat: cloneEarlyJson(earlyRuntimeMessages),
    characters: [],
    eventSource: window.eventSource,
    eventTypes: window.eventTypes,
    event_types: window.event_types,
    generate: window.generate,
    Generate: window.Generate,
    generateRaw: window.generateRaw,
    generateQuietPrompt: window.generateRaw,
    getChatMessages: window.getChatMessages,
    setChatMessages: window.setChatMessages,
    setChatMessage: window.setChatMessage,
  }));
  window.TavernHelper = window.TavernHelper || {};
  window.TavernHelper.getChatMessages = window.TavernHelper.getChatMessages || window.getChatMessages;
  window.TavernHelper.setChatMessages = window.TavernHelper.setChatMessages || window.setChatMessages;
  window.TavernHelper.setChatMessage = window.TavernHelper.setChatMessage || window.setChatMessage;
  window.TavernHelper._bind = window.TavernHelper._bind || {
    _getChatMessages: window.getChatMessages,
    _setChatMessages: window.setChatMessages,
    _setChatMessage: window.setChatMessage,
  };
  post({
    type: 'card-sandbox-action',
    action: 'diagnostic',
    payload: {
      event: 'early-st-bridge-ready',
      hasGenerate: typeof window.generate === 'function',
      hasGenerateRaw: typeof window.generateRaw === 'function',
      hasGetChatMessages: typeof window.getChatMessages === 'function',
      hasSetChatMessages: typeof window.setChatMessages === 'function',
      hasEventSource: Boolean(window.eventSource),
      hasSillyTavern: Boolean(window.SillyTavern?.getContext),
      hasTavernHelper: Boolean(window.TavernHelper),
      at: Date.now(),
    },
  });
})();
</script>`;

  const shim = `
<script>
(() => {
  const toArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Element || value === document || value === window) return [value];
    if (value instanceof MiniQuery) return value.items;
    if (typeof value.length === 'number') return Array.from(value);
    return [value];
  };
  const parseDataValue = (value) => {
    if (value == null) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (value !== '' && !Number.isNaN(Number(value)) && String(Number(value)) === value) return Number(value);
    if (/^[\\[{]/.test(value)) {
      try { return JSON.parse(value); } catch {}
    }
    return value;
  };
  class MiniQuery {
    constructor(value) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
          const template = document.createElement('template');
          template.innerHTML = trimmed;
          this.items = Array.from(template.content.childNodes).filter(node => node.nodeType === Node.ELEMENT_NODE);
        } else {
          try {
            this.items = Array.from(document.querySelectorAll(value));
          } catch {
            this.items = [];
          }
        }
      } else this.items = toArray(value);
      this.length = this.items.length;
      this.items.forEach((item, index) => { this[index] = item; });
    }
    on(type, selectorOrHandler, maybeHandler) {
      const delegated = typeof selectorOrHandler === 'string';
      const selector = delegated ? selectorOrHandler : '';
      const handler = delegated ? maybeHandler : selectorOrHandler;
      if (typeof handler !== 'function') return this;
      this.items.forEach(el => el && el.addEventListener && el.addEventListener(type, function(event) {
        if (!delegated) return handler.call(this, event);
        const target = event.target && event.target.closest ? event.target.closest(selector) : null;
        if (target && el.contains && el.contains(target)) handler.call(target, event);
      }));
      return this;
    }
    each(handler) { if (typeof handler === 'function') this.items.forEach((el, index) => handler.call(el, index, el)); return this; }
    addClass(name) { this.items.forEach(el => el.classList && el.classList.add(...String(name).split(/\\s+/).filter(Boolean))); return this; }
    removeClass(name) { this.items.forEach(el => el.classList && el.classList.remove(...String(name).split(/\\s+/).filter(Boolean))); return this; }
    toggleClass(name) { this.items.forEach(el => el.classList && el.classList.toggle(name)); return this; }
    hasClass(name) { return Boolean(this.items[0]?.classList?.contains(name)); }
    closest(selector) { return new MiniQuery(this.items.map(el => el?.closest ? el.closest(selector) : null).filter(Boolean)); }
    find(selector) { return new MiniQuery(this.items.flatMap(el => el?.querySelectorAll ? Array.from(el.querySelectorAll(selector)) : [])); }
    data(name, value) {
      const key = String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (value === undefined) return parseDataValue(this.items[0]?.dataset?.[key]);
      this.items.forEach(el => { if (el?.dataset) el.dataset[key] = String(value); });
      return this;
    }
    attr(name, value) { if (value === undefined) return this.items[0]?.getAttribute?.(name); this.items.forEach(el => el?.setAttribute?.(name, value)); return this; }
    prop(name, value) { if (value === undefined) return this.items[0]?.[name]; this.items.forEach(el => { if (el) el[name] = value; }); return this; }
    val(value) { if (value === undefined) return this.items[0]?.value; this.items.forEach(el => { if ('value' in el) el.value = value; }); return this; }
    text(value) { if (value === undefined) return this.items.map(el => el.textContent || '').join(''); this.items.forEach(el => { el.textContent = value; }); return this; }
    html(value) { if (value === undefined) return this.items[0]?.innerHTML || ''; this.items.forEach(el => { el.innerHTML = value; }); return this; }
    css(name, value) { if (value === undefined && typeof name === 'string') return getComputedStyle(this.items[0]).getPropertyValue(name); this.items.forEach(el => { if (!el?.style) return; if (typeof name === 'object') Object.assign(el.style, name); else el.style[name] = value; }); return this; }
    focus() { this.items[0]?.focus && this.items[0].focus(); return this; }
    trigger(type) { this.items.forEach(el => el?.dispatchEvent && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))); return this; }
    click(handler) { return typeof handler === 'function' ? this.on('click', handler) : this.trigger('click'); }
    show() { this.items.forEach(el => { if (el?.style) el.style.display = ''; }); return this; }
    hide() { this.items.forEach(el => { if (el?.style) el.style.display = 'none'; }); return this; }
    empty() { this.items.forEach(el => { if (el) el.textContent = ''; }); return this; }
    append(value) { this.items.forEach(el => { if (!el) return; if (typeof value === 'string') el.insertAdjacentHTML('beforeend', value); else if (value instanceof Node) el.appendChild(value.cloneNode(true)); }); return this; }
    slideDown(duration, callback) { this.items.forEach(el => { if (el?.style) el.style.display = ''; if (typeof duration === 'function') duration.call(el); else if (typeof callback === 'function') setTimeout(() => callback.call(el), Number(duration) || 0); }); return this; }
    slideUp(duration, callback) { this.items.forEach(el => { const done = () => { if (el?.style) el.style.display = 'none'; if (typeof callback === 'function') callback.call(el); }; if (typeof duration === 'function') { done(); duration.call(el); } else setTimeout(done, Number(duration) || 0); }); return this; }
    remove() { this.items.forEach(el => el?.remove && el.remove()); return this; }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }
  window.$ = window.jQuery = (value) => {
    if (typeof value === 'function') {
      const run = () => value.call(document, window.$);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
      } else {
        queueMicrotask(run);
      }
      return new MiniQuery(document);
    }
    return new MiniQuery(value);
  };
})();
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
    const elements = body ? Array.from(body.querySelectorAll('*')) : [];
    for (const element of elements) {
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
  let runtimeVariables = initialRuntimeVariables;
  let runtimeContext = initialRuntimeContext;
  let runtimeSubmission = runtimeContext.submission && typeof runtimeContext.submission === 'object'
    ? runtimeContext.submission
    : { status: 'idle' };
  const runtimeStorageScope = [
    'xrp-card-runtime',
    runtimeSessionId || 'preview',
  ].map(part => encodeURIComponent(String(part))).join(':') + ':';
  let sharedSaves = Array.isArray(runtimeContext.sharedSaves) ? runtimeContext.sharedSaves : [];
  let sharedSaveIndex = {};
  let sharedSavePayloads = {};
  let sharedSaveSessionById = {};
  const rebuildSharedSaveCaches = () => {
    sharedSaveIndex = {};
    sharedSavePayloads = {};
    sharedSaveSessionById = {};
    for (const save of sharedSaves) {
    if (!save || !save.saveId) continue;
    const saveId = String(save.saveId);
    sharedSaveIndex[saveId] = save.meta && typeof save.meta === 'object' ? save.meta : {};
    sharedSavePayloads[saveId] = save.payload && typeof save.payload === 'object' ? save.payload : {};
    if (save.sessionId) sharedSaveSessionById[saveId] = String(save.sessionId);
    }
  };
  rebuildSharedSaveCaches();
  const createMemoryStorage = () => {
    const store = new Map();
    return {
      get length() { return store.size; },
      key: (index) => Array.from(store.keys())[Number(index)] ?? null,
      getItem: (key) => store.has(String(key)) ? store.get(String(key)) : null,
      setItem: (key, value) => { store.set(String(key), String(value)); },
      removeItem: (key) => { store.delete(String(key)); },
      clear: () => { store.clear(); },
    };
  };
  const createScopedStorage = (realStorage, memoryStorage, scope) => {
    const platformKeys = new Set([
      'api_auth_token',
      'global_session_defaults_v1',
      'user_persona_presets_v1',
      'default_user_persona_preset_id_v1',
    ]);
    const scopedKey = (key) => scope + String(key);
    const ownKeys = () => {
      const keys = new Set();
      if (realStorage) {
        try {
          for (let index = 0; index < realStorage.length; index += 1) {
            const key = realStorage.key(index);
            if (key && key.startsWith(scope)) keys.add(key.slice(scope.length));
          }
        } catch {}
      }
      try {
        for (let index = 0; index < memoryStorage.length; index += 1) {
          const key = memoryStorage.key(index);
          if (key) keys.add(key);
        }
      } catch {}
      return Array.from(keys);
    };
    return {
      get length() { return ownKeys().length; },
      key: (index) => ownKeys()[Number(index)] ?? null,
      getItem: (key) => {
        const normalized = String(key);
        if (platformKeys.has(normalized) && realStorage) {
          try { return realStorage.getItem(normalized); } catch {}
        }
        if (realStorage) {
          try {
            const value = realStorage.getItem(scopedKey(normalized));
            if (value != null) return value;
          } catch {}
        }
        return memoryStorage.getItem(normalized);
      },
      setItem: (key, value) => {
        const normalized = String(key);
        if (platformKeys.has(normalized) && realStorage) {
          try {
            realStorage.setItem(normalized, String(value));
            return;
          } catch {}
        }
        if (realStorage) {
          try {
            realStorage.setItem(scopedKey(normalized), String(value));
            memoryStorage.removeItem(normalized);
            return;
          } catch {}
        }
        memoryStorage.setItem(normalized, value);
      },
      removeItem: (key) => {
        const normalized = String(key);
        if (platformKeys.has(normalized) && realStorage) {
          try { realStorage.removeItem(normalized); } catch {}
          return;
        }
        if (realStorage) {
          try { realStorage.removeItem(scopedKey(normalized)); } catch {}
        }
        memoryStorage.removeItem(normalized);
      },
      clear: () => {
        for (const key of ownKeys()) {
          if (realStorage) {
            try { realStorage.removeItem(scopedKey(key)); } catch {}
          }
          memoryStorage.removeItem(key);
        }
      },
    };
  };
  const installStorageShim = (name) => {
    let realStorage = null;
    try {
      const storage = window[name];
      const key = '__xrp_storage_probe__';
      storage.setItem(key, '1');
      storage.removeItem(key);
      realStorage = storage;
    } catch {}
    const scopedStorage = createScopedStorage(realStorage, createMemoryStorage(), runtimeStorageScope + name + ':');
    try {
      Object.defineProperty(window, name, { value: scopedStorage, configurable: true });
    } catch {
      window[name] = scopedStorage;
    }
  };
  installStorageShim('localStorage');
  installStorageShim('sessionStorage');
  const seedSharedSaveLocalStorage = () => {
    try {
      const payloadPrefix = 'islandmilfcode:save-payload:v2:';
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index);
        if (key && key.startsWith(payloadPrefix)) window.localStorage.removeItem(key);
      }
      if (!sharedSaves.length) {
        window.localStorage.removeItem('islandmilfcode:save-index:v2');
        return;
      }
      window.localStorage.setItem('islandmilfcode:save-index:v2', JSON.stringify(sharedSaveIndex));
      for (const [saveId, payload] of Object.entries(sharedSavePayloads)) {
        window.localStorage.setItem('islandmilfcode:save-payload:v2:' + saveId, JSON.stringify(payload));
      }
      const currentSave = sharedSaves.find(save => String(save.sessionId || '') === runtimeSessionId) || sharedSaves[0];
      if (currentSave?.saveId) {
        window.localStorage.setItem('islandmilfcode:active-save-id:v2', String(currentSave.saveId));
        window.localStorage.setItem('islandmilfcode:active-run-id:v2', String(currentSave.runId || currentSave.sessionId || currentSave.saveId));
      }
      postDiagnostic('shared-save-seeded', {
        count: sharedSaves.length,
        currentSaveId: currentSave?.saveId || '',
        currentRunId: currentSave?.runId || currentSave?.sessionId || '',
        payloadMessages: Array.isArray(currentSave?.payload?.chatLog) ? currentSave.payload.chatLog.length : null,
        lastRole: Array.isArray(currentSave?.payload?.chatLog) ? currentSave.payload.chatLog[currentSave.payload.chatLog.length - 1]?.role || '' : '',
        lastText: Array.isArray(currentSave?.payload?.chatLog) ? previewText(currentSave.payload.chatLog[currentSave.payload.chatLog.length - 1]?.text) : '',
      });
    } catch {}
  };
  seedSharedSaveLocalStorage();

  const createMemoryIndexedDB = () => {
    const databases = new Map();
    const asyncCall = (fn) => setTimeout(fn, 0);
    const makeRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });
    const fireSuccess = (request, result) => asyncCall(() => {
      request.result = result;
      request.onsuccess && request.onsuccess({ target: request });
    });
    const fireError = (request, error) => asyncCall(() => {
      request.error = error;
      request.onerror && request.onerror({ target: request });
    });
    const getDatabaseState = (name) => {
      if (!databases.has(name)) databases.set(name, { stores: new Map() });
      return databases.get(name);
    };
    const seedSharedSaveRows = (storeName, store) => {
      if (sharedSaves.length && storeName === 'save-index') {
        store.rows.set('__index__', { id: '__index__', key: '__index__', value: sharedSaveIndex });
      }
      if (sharedSaves.length && storeName === 'save-payload') {
        for (const [saveId, payload] of Object.entries(sharedSavePayloads)) {
          store.rows.set(saveId, { id: saveId, key: saveId, value: payload });
        }
      }
    };
    const makeObjectStore = (state, storeName, keyPath = 'id') => {
      if (!state.stores.has(storeName)) state.stores.set(storeName, { keyPath, rows: new Map() });
      const store = state.stores.get(storeName);
      seedSharedSaveRows(storeName, store);
      return {
        get(key) {
          const request = makeRequest();
          fireSuccess(request, store.rows.get(String(key)));
          return request;
        },
        put(value) {
          const request = makeRequest();
          const key = value && value[keyPath] != null ? value[keyPath] : value?.id;
          if (key == null) {
            fireError(request, new Error('IndexedDB shim put requires a key'));
          } else {
            store.rows.set(String(key), value);
            fireSuccess(request, key);
          }
          return request;
        },
        delete(key) {
          const request = makeRequest();
          store.rows.delete(String(key));
          fireSuccess(request, undefined);
          return request;
        },
        getAll() {
          const request = makeRequest();
          fireSuccess(request, Array.from(store.rows.values()));
          return request;
        },
      };
    };
    const makeDb = (name, state) => ({
      name,
      objectStoreNames: {
        contains: (storeName) => state.stores.has(String(storeName)),
      },
      createObjectStore: (storeName, options = {}) => {
        makeObjectStore(state, String(storeName), options.keyPath || 'id');
        return makeObjectStore(state, String(storeName), options.keyPath || 'id');
      },
      transaction: (storeName) => ({
        objectStore: (name) => makeObjectStore(state, String(name || storeName)),
      }),
      close: () => {},
    });
    return {
      open(name) {
        const request = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        asyncCall(() => {
          const state = getDatabaseState(String(name));
          const db = makeDb(String(name), state);
          request.result = db;
          request.onupgradeneeded && request.onupgradeneeded({ target: request });
          request.onsuccess && request.onsuccess({ target: request });
        });
        return request;
      },
      deleteDatabase(name) {
        const request = makeRequest();
        databases.delete(String(name));
        fireSuccess(request, undefined);
        return request;
      },
    };
  };
  try {
    let indexedDbUsable = false;
    try {
      if (window.indexedDB && typeof window.indexedDB.open === 'function') {
        const probe = window.indexedDB.open('__xrp_idb_probe__');
        indexedDbUsable = Boolean(probe);
      }
    } catch {}
    if (!indexedDbUsable) {
      Object.defineProperty(window, 'indexedDB', { value: createMemoryIndexedDB(), configurable: true });
    }
  } catch {
    try {
      Object.defineProperty(window, 'indexedDB', { value: createMemoryIndexedDB(), configurable: true });
    } catch {
      window.indexedDB = createMemoryIndexedDB();
    }
  }
  const cloneJson = (value) => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  };
  const getPath = (source, path, fallback) => {
    if (!path) return source ?? fallback;
    const parts = Array.isArray(path) ? path : String(path).split('.').filter(Boolean);
    let cursor = source;
    for (const part of parts) {
      if (cursor == null) return fallback;
      cursor = cursor[part];
    }
    return cursor === undefined ? fallback : cursor;
  };
  const setPath = (target, path, value) => {
    const parts = Array.isArray(path) ? path : String(path).split('.').filter(Boolean);
    if (!parts.length) return target;
    let cursor = target;
    parts.slice(0, -1).forEach(part => {
      if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
      cursor = cursor[part];
    });
    cursor[parts[parts.length - 1]] = value;
    return target;
  };
  const lodashShim = {
    get: getPath,
    set: setPath,
    cloneDeep: (value) => cloneJson(value),
    debounce: (fn, wait = 0) => {
      let timeoutId = null;
      const debounced = function(...args) {
        const context = this;
        if (timeoutId != null) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          timeoutId = null;
          if (typeof fn === 'function') fn.apply(context, args);
        }, Number(wait) || 0);
      };
      debounced.cancel = () => {
        if (timeoutId != null) clearTimeout(timeoutId);
        timeoutId = null;
      };
      debounced.flush = () => {
        if (timeoutId != null) {
          clearTimeout(timeoutId);
          timeoutId = null;
          if (typeof fn === 'function') return fn();
        }
        return undefined;
      };
      return debounced;
    },
    throttle: (fn, wait = 0) => {
      let lastRun = 0;
      let timeoutId = null;
      const throttled = function(...args) {
        const context = this;
        const delay = Number(wait) || 0;
        const now = Date.now();
        const remaining = delay - (now - lastRun);
        const run = () => {
          timeoutId = null;
          lastRun = Date.now();
          if (typeof fn === 'function') fn.apply(context, args);
        };
        if (remaining <= 0) {
          if (timeoutId != null) clearTimeout(timeoutId);
          run();
        } else if (timeoutId == null) {
          timeoutId = setTimeout(run, remaining);
        }
      };
      throttled.cancel = () => {
        if (timeoutId != null) clearTimeout(timeoutId);
        timeoutId = null;
      };
      return throttled;
    },
    clamp: (value, lower, upper) => {
      const number = Number(value);
      const min = Number(lower);
      const max = Number(upper);
      if (!Number.isFinite(number)) return Number.isFinite(min) ? min : 0;
      return Math.min(Number.isFinite(max) ? max : number, Math.max(Number.isFinite(min) ? min : number, number));
    },
    isEqual: (left, right) => {
      try { return JSON.stringify(left) === JSON.stringify(right); } catch { return left === right; }
    },
    isNil: (value) => value == null,
    isObject: (value) => Boolean(value && typeof value === 'object'),
    isPlainObject: (value) => Boolean(value && Object.prototype.toString.call(value) === '[object Object]'),
    pickBy: (source, predicate = Boolean) => Object.fromEntries(Object.entries(source || {}).filter(([key, value]) => predicate(value, key))),
    uniqBy: (items = [], iteratee = item => item) => {
      const seen = new Set();
      return Array.from(items || []).filter((item) => {
        const key = typeof iteratee === 'function' ? iteratee(item) : getPath(item, iteratee);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    merge: (target, ...sources) => {
      const output = target && typeof target === 'object' ? target : {};
      for (const source of sources) {
        for (const [key, value] of Object.entries(source || {})) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            output[key] = window._.merge(output[key] && typeof output[key] === 'object' ? output[key] : {}, value);
          } else {
            output[key] = value;
          }
        }
      }
      return output;
    },
  };
  window._ = { ...(window._ && typeof window._ === 'object' ? window._ : {}), ...lodashShim };
  const normalizeMessage = (message, index) => {
    const source = message && typeof message === 'object' ? message : {};
    const fallbackId = index + 1;
    const id = source.id ?? source.message_id ?? fallbackId;
    const text = source.message ?? source.content ?? '';
    const data = source.data && typeof source.data === 'object' ? source.data : {};
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
        stat_data: runtimeVariables,
        display_data: runtimeVariables,
        variables: runtimeVariables,
        ...data,
      },
      variables: source.variables && typeof source.variables === 'object' ? source.variables : runtimeVariables,
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
        variables: runtimeVariables,
      }, 0)];
  const refreshRuntimeSnapshot = (nextContext, nextVariables) => {
    if (nextVariables && typeof nextVariables === 'object') runtimeVariables = nextVariables;
    if (nextContext && typeof nextContext === 'object') runtimeContext = nextContext;
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
      variables: runtimeVariables,
      messages: runtimeMessages,
      currentMessage: runtimeMessage,
      submission: runtimeSubmission,
    };
    window.__XRPVariables = runtimeVariables;
  };
  refreshRuntimeSnapshot(runtimeContext, runtimeVariables);
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
  const quietRequestPayload = (request, generationId) => {
    if (typeof request === 'string') return { prompt: request, generation_id: generationId };
    if (Array.isArray(request)) return { ordered_prompts: request, generation_id: generationId };
    if (request && typeof request === 'object') {
      return {
        ...request,
        generation_id: request.generation_id ?? request.generationId ?? generationId,
      };
    }
    return { prompt: '', generation_id: generationId };
  };
  const quietAuthHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const token = window.localStorage?.getItem('api_auth_token') || '';
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch {}
    return headers;
  };
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
    const response = await fetch('/api/sessions/' + encodeURIComponent(runtimeSessionId) + '/quiet-generate', {
      method: 'POST',
      headers: quietAuthHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body?.error?.message || ('HTTP ' + response.status);
      postDiagnostic('generateRaw-quiet-error', {
        generationId,
        status: response.status,
        message: String(message).slice(0, 1000),
      });
      throw new Error(String(message));
    }
    const data = await response.json();
    const content = String(data?.content || '');
    postDiagnostic('generateRaw-quiet-result', {
      generationId,
      contentLength: content.length,
      model: String(data?.model || ''),
    });
    return content;
  };
  const inputTextFromGenerateRequest = (request) => {
    if (request && typeof request === 'object') {
      const direct = textFromCommandLike(request);
      if (direct) return direct;
      if (typeof request.user_input === 'string' && request.user_input.trim()) return request.user_input;
      if (typeof request.userInput === 'string' && request.userInput.trim()) return request.userInput;
      if (Array.isArray(request.ordered_prompts)) {
        return request.ordered_prompts
          .map(item => item && typeof item === 'object' ? item.content : item)
          .filter(item => typeof item === 'string' && item.trim())
          .join('\\n\\n');
      }
    }
    return '';
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
    readVariables: (paths) => post({ type: 'card-sandbox-action', action: 'readVariables', payload: { paths: Array.isArray(paths) ? paths.slice(0, 50) : [] } }),
    writeVariables: (changes) => post({ type: 'card-sandbox-action', action: 'writeVariables', payload: { changes: changes && typeof changes === 'object' ? changes : {} } }),
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
    __emitMany(['CHAT_CHANGED', window.event_types.CHAT_CHANGED]);
    __emitMany(['MESSAGE_UPDATED', window.event_types.MESSAGE_UPDATED]);
    __emitMany([window.event_types.MESSAGE_RECEIVED, window.event_types.CHARACTER_MESSAGE_RENDERED], window.getLastMessageId(), 'normal');
    if (data.submission) {
      emitGenerationEventsFromSubmission();
      ensureSubmissionOverlay();
    }
  };
  window.addEventListener('message', (event) => applyRuntimeUpdate(event.data || {}));
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
  const messageVariablesOf = (message) => {
    if (!message || typeof message !== 'object') return {};
    if (message.variables && typeof message.variables === 'object') return message.variables;
    const data = message.data && typeof message.data === 'object' ? message.data : {};
    return data.variables && typeof data.variables === 'object' ? data.variables : {};
  };
  const runtimeScopedStores = {
    global: {},
    character: {},
    preset: {},
    script: {},
    extension: {},
  };
  const normalizeVariableOption = (option = { type: 'chat' }) => {
    if (typeof option === 'string') return { type: option };
    if (!option || typeof option !== 'object') return { type: 'chat' };
    return { type: option.type || 'chat', ...option };
  };
  const getVariableStore = (option = { type: 'chat' }) => {
    const normalized = normalizeVariableOption(option);
    switch (normalized.type) {
      case 'message':
        return messageVariablesOf(resolveRuntimeMessage(normalized));
      case 'global':
      case 'character':
      case 'preset':
      case 'script':
      case 'extension':
        return runtimeScopedStores[normalized.type] || {};
      case 'chat':
      default:
        return runtimeVariables || {};
    }
  };
  const setVariableStore = (variables, option = { type: 'chat' }) => {
    const normalized = normalizeVariableOption(option);
    const next = variables && typeof variables === 'object' ? variables : {};
    if (normalized.type === 'message') {
      const message = resolveRuntimeMessage(normalized);
      if (message) {
        message.variables = next;
        message.data = { ...(message.data || {}), variables: next, stat_data: next, display_data: next };
      }
      post({
        type: 'card-sandbox-action',
        action: 'setVariables',
        payload: {
          variables: next,
          sourceMessageId: message?.id ?? message?.message_id ?? getRuntimeMessageId(),
          options: {
            ...normalized,
            message_id: normalized.message_id ?? normalized.messageId ?? message?.id ?? message?.message_id ?? getRuntimeMessageId(),
            source: normalized.source || 'message',
          },
        },
      });
      return next;
    }
    if (normalized.type === 'chat' || !normalized.type) {
      runtimeVariables = next;
      post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: next, options: { ...normalized, type: 'chat' } } });
      return next;
    }
    runtimeScopedStores[normalized.type] = next;
    postDiagnostic('setVariables-scoped-memory', { type: normalized.type });
    return next;
  };
  const getChatMessages = async () => cloneJsonString(runtimeMessagesJson) || cloneJson(runtimeMessages);
  exposeGlobal('getChatMessages', getChatMessages);
  const getChatMessage = async (messageId) => {
    const id = messageId ?? runtimeMessage.message_id ?? runtimeMessage.id;
    return cloneJsonString(runtimeMessagesByIdJson.get(String(id)) || runtimeMessageJson) || cloneJson(runtimeMessage);
  };
  exposeGlobal('getChatMessage', getChatMessage);
  const getVariables = async (option = { type: 'chat' }) => cloneJson(getVariableStore(option));
  exposeGlobal('getVariables', getVariables);
  const getAllVariables = async () => {
    const merged = window._.merge(
      {},
      runtimeScopedStores.global,
      runtimeScopedStores.character,
      runtimeScopedStores.preset,
      runtimeScopedStores.script,
      runtimeScopedStores.extension,
      runtimeVariables,
      messageVariablesOf(runtimeMessage),
    );
    return {
      ...merged,
      global: cloneJson(runtimeScopedStores.global),
      character: cloneJson(runtimeScopedStores.character),
      preset: cloneJson(runtimeScopedStores.preset),
      script: cloneJson(runtimeScopedStores.script),
      extension: cloneJson(runtimeScopedStores.extension),
      chat: cloneJson(runtimeVariables),
      message: cloneJson(messageVariablesOf(runtimeMessage)),
      variables: cloneJson(runtimeVariables),
    };
  };
  exposeGlobal('getAllVariables', getAllVariables);
  window.__XRPVariables = runtimeVariables;
  const replaceVariables = (variables, options = { type: 'chat' }) => setVariableStore(cloneJson(variables), options);
  exposeGlobal('replaceVariables', replaceVariables);
  exposeGlobal('setVariables', replaceVariables);
  const updateVariablesWith = (updater, options = { type: 'chat' }) => {
    const next = cloneJson(getVariableStore(options));
    try {
      if (typeof updater === 'function') {
        const result = updater(next);
        if (result && typeof result.then === 'function') {
          return result.then((resolved) => {
            const finalVariables = resolved && typeof resolved === 'object' ? resolved : next;
            setVariableStore(finalVariables, options);
            return finalVariables;
          });
        }
        if (result && typeof result === 'object') {
          setVariableStore(result, options);
          return result;
        }
      } else if (updater && typeof updater === 'object') {
        Object.assign(next, updater);
      }
    } catch (error) {
      post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(error?.message || error).slice(0, 1000), stack: String(error?.stack || '').slice(0, 2000) } });
      return;
    }
    setVariableStore(next, options);
    return next;
  };
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

  const getMvuData = async (options = {}) => {
    const message = resolveRuntimeMessage(options);
    const data = message?.data && typeof message.data === 'object' ? message.data : {};
    return cloneJson({
      stat_data: data.stat_data || messageVariablesOf(message),
      display_data: data.display_data || data.stat_data || messageVariablesOf(message),
      variables: data.variables || messageVariablesOf(message),
      message_id: message?.message_id ?? message?.id,
      swipe_id: message?.swipe_id ?? 0,
    });
  };
  exposeGlobal('getMvuData', getMvuData);
  const replaceMvuData = async (data, options = {}) => {
    const next = data?.stat_data || data?.variables || data || {};
    setVariableStore(next && typeof next === 'object' ? next : {}, { type: 'message', ...(options || {}) });
    __emitEvent('VARIABLE_UPDATE_ENDED', data, options);
    return true;
  };
  exposeGlobal('replaceMvuData', replaceMvuData);
  postDiagnostic('st-bridge-globals-ready', {
    getChatMessages: typeof getChatMessages,
    setChatMessages: typeof setChatMessages,
    setChatMessage: typeof setChatMessage,
    triggerSlash: typeof triggerSlash,
    mvu: typeof window.Mvu,
    directWindowCheck: typeof window.getChatMessages,
    globalThisCheck: typeof globalThis.getChatMessages,
  });
  // --- Event Bus ---
  const __eventHandlers = window.__XRPEventHandlers instanceof Map ? window.__XRPEventHandlers : new Map();
  window.__XRPEventHandlers = __eventHandlers;
  const __emittedEvents = new Set();
  const __resolveEventName = (eventName) => {
    if (typeof eventName === 'string') return eventName;
    if (eventName && typeof eventName === 'object') {
      // Handle enum-style constants like { VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED' }
      const values = Object.values(eventName);
      if (values.length === 1 && typeof values[0] === 'string') return values[0];
      if (typeof eventName.name === 'string') return eventName.name;
      if (typeof eventName.event === 'string') return eventName.event;
    }
    return String(eventName);
  };
  window.eventOff = (eventName, handler) => {
    const name = __resolveEventName(eventName);
    const handlers = __eventHandlers.get(name);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) __eventHandlers.delete(name);
    }
  };
  window.eventOn = (eventName, handler) => {
    if (typeof handler !== 'function') return { stop: () => {} };
    const name = __resolveEventName(eventName);
    if (!__eventHandlers.has(name)) __eventHandlers.set(name, new Set());
    __eventHandlers.get(name).add(handler);
    return { stop: () => window.eventOff(name, handler) };
  };
  const __emitEvent = (eventName, ...args) => {
    const name = __resolveEventName(eventName);
    __emittedEvents.add(name);
    const handlers = __eventHandlers.get(name);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (error) {
          post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: ('Event handler error for "' + name + '": ' + String(error?.message || error)).slice(0, 1000), stack: String(error?.stack || '').slice(0, 2000), eventName: name } });
        }
      }
    }
  };
  const __emitMany = (eventNames, ...args) => {
    for (const eventName of eventNames) {
      __emitEvent(eventName, ...args);
    }
  };
  window.eventEmit = __emitEvent;
  window.event_types = { ...(window.event_types || {}), ...stEventTypes };
  window.eventTypes = window.event_types;
  window.tavern_events = {
    ...window.event_types,
    APP_READY: window.event_types.APP_READY,
    GLOBAL_INITIALIZED: 'GLOBAL_INITIALIZED',
    VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED',
    CHAT_CHANGED: window.event_types.CHAT_CHANGED,
    MESSAGE_SWIPED: window.event_types.MESSAGE_SWIPED,
    MESSAGE_UPDATED: window.event_types.MESSAGE_UPDATED,
  };
  window.iframe_events = {
    MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
    MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_STARTED: 'js_generation_started',
    STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
    GENERATION_ENDED: 'js_generation_ended',
  };
  const legacyIframeEvents = {
    GENERATION_STARTED: 'GENERATION_STARTED',
    STREAM_TOKEN_RECEIVED_FULLY: 'STREAM_TOKEN_RECEIVED_FULLY',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'STREAM_TOKEN_RECEIVED_INCREMENTALLY',
    GENERATION_ENDED: 'GENERATION_ENDED',
  };
  window.eventSource = {
    on: (eventName, handler) => window.eventOn(eventName, handler),
    makeLast: (eventName, handler) => window.eventOn(eventName, handler),
    once: (eventName, handler) => {
      const subscription = window.eventOn(eventName, (...args) => {
        subscription.stop();
        handler(...args);
      });
      return subscription;
    },
    removeListener: (eventName, handler) => window.eventOff(eventName, handler),
    off: (eventName, handler) => window.eventOff(eventName, handler),
    emit: async (eventName, ...args) => window.eventEmit(eventName, ...args),
    emitAndWait: async (eventName, ...args) => window.eventEmit(eventName, ...args),
  };
  let lastGenerationEventKey = '';
  const emitGenerationEventsFromSubmission = () => {
    const submission = runtimeSubmission || {};
    const assistantMessage = String(submission.assistantMessage || '');
    const generationId = String(submission.generationId || submission.sourceMessageId || 'main-chat');
    const status = String(submission.status || '');
    const eventKey = generationId + ':' + status + ':' + assistantMessage.length;
    if (eventKey === lastGenerationEventKey) return;
    lastGenerationEventKey = eventKey;
    if (status === 'pending') {
      __emitMany([window.iframe_events.GENERATION_STARTED, legacyIframeEvents.GENERATION_STARTED, window.event_types.GENERATION_STARTED], generationId);
      postDiagnostic('st-generation-event', { status, generationId, contentLength: 0 });
      return;
    }
    if (status === 'error') {
      settleGenerationRequest(generationId, status, assistantMessage, submission.error);
      return;
    }
    if (!assistantMessage.trim()) return;
    __emitMany([
      window.iframe_events.STREAM_TOKEN_RECEIVED_FULLY,
      legacyIframeEvents.STREAM_TOKEN_RECEIVED_FULLY,
      window.iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY,
      legacyIframeEvents.STREAM_TOKEN_RECEIVED_INCREMENTALLY,
      window.event_types.STREAM_TOKEN_RECEIVED,
    ], assistantMessage, generationId);
    postDiagnostic('st-generation-event', { status, generationId, contentLength: assistantMessage.length });
    if (status === 'finalizing' || status === 'done') {
      __emitMany([window.iframe_events.GENERATION_ENDED, legacyIframeEvents.GENERATION_ENDED, window.event_types.GENERATION_ENDED], assistantMessage, generationId);
      __emitMany([window.event_types.MESSAGE_RECEIVED, window.event_types.CHARACTER_MESSAGE_RENDERED], window.getLastMessageId(), 'normal');
      settleGenerationRequest(generationId, status, assistantMessage, submission.error);
    }
  };
  window.name1 = runtimeMessages.find(item => item.is_user)?.name || '你';
  window.SillyTavern = window.SillyTavern || {};
  window.SillyTavern.getContext = () => ({
    name1: window.name1,
    name2: runtimeMessage.name || '',
    characters: [],
    chat: runtimeMessages,
    messages: runtimeMessages,
    chatId: runtimeSessionId,
    eventSource: window.eventSource,
    eventTypes: window.eventTypes,
    event_types: window.event_types,
    getChatMessages: window.getChatMessages,
    getChatMessage: window.getChatMessage,
    generate: window.generate,
    Generate: window.Generate,
    generateRaw: window.generateRaw,
    generateQuietPrompt: window.generateRaw,
    substituteParams: window.substituteMacros,
    substituteParamsExtended: window.substituteMacros,
  });
  window.substituteMacros = window.substitudeMacros = (source) => String(source ?? '')
    .replace(/{{user}}/g, window.name1 || '你')
    .replace(/{{char}}/g, runtimeMessage.name || '');
  window.errorCatched = (fn) => {
    const run = async (...args) => {
      try {
        return typeof fn === 'function' ? await fn(...args) : undefined;
      } catch (error) {
        post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(error?.message || error).slice(0, 1000), stack: String(error?.stack || '').slice(0, 2000) } });
        return undefined;
      }
    };
    return run;
  };
  window.toastr = window.toastr || {
    success: (...args) => console.info('[toastr.success]', ...args),
    warning: (...args) => console.warn('[toastr.warning]', ...args),
    error: (...args) => console.error('[toastr.error]', ...args),
    info: (...args) => console.info('[toastr.info]', ...args),
  };
  window.getScriptId = () => 'xrp-tavern-helper-runtime';
  window.Mvu = window.Mvu || {
    events: { VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED' },
    getMvuData: window.getMvuData,
    replaceMvuData: window.replaceMvuData,
    insertVariables: async (vars = {}) => {
      const next = window._.merge({}, messageVariablesOf(runtimeMessage), vars);
      setVariableStore(next, { type: 'message', source: 'Mvu.insertVariables' });
      __emitEvent('VARIABLE_UPDATE_ENDED', { stat_data: next });
      return true;
    },
    setVariables: window.setVariables,
    getVariables: window.getVariables,
  };
  window.insertVariables = (...args) => window.Mvu.insertVariables(...args);
  window.registerMvuSchema = window.registerMvuSchema || (() => {});
  window.waitGlobalInitialized = (name) => {
    const moduleName = String(name || '').toLowerCase();
    const makeResult = () => {
      if (moduleName === 'mvu') {
        return window.Mvu;
      }
      return null;
    };
    if (__emittedEvents.has('GLOBAL_INITIALIZED')) {
      return Promise.resolve(makeResult());
    }
    return new Promise((resolve) => {
      const { stop } = window.eventOn('GLOBAL_INITIALIZED', () => {
        stop();
        resolve(makeResult());
      });
    });
  };

  // --- TavernHelper compatibility object ---
  window.TavernHelper = {
    getChatMessages: (...args) => window.getChatMessages(...args),
    getChatMessage: (...args) => window.getChatMessage(...args),
    setChatMessage: (...args) => window.setChatMessage(...args),
    setChatMessages: (...args) => window.setChatMessages(...args),
    getVariables: (...args) => window.getVariables(...args),
    getAllVariables: (...args) => window.getAllVariables(...args),
    setVariables: (...args) => window.setVariables(...args),
    triggerSlash: (...args) => window.triggerSlash(...args),
    generate: (...args) => window.generate(...args),
    generateRaw: (...args) => window.generateRaw(...args),
    updateVariablesWith: (...args) => window.updateVariablesWith(...args),
    getMvuData: (...args) => window.getMvuData(...args),
    replaceMvuData: (...args) => window.replaceMvuData(...args),
    eventOn: (...args) => window.eventOn(...args),
    eventOff: (...args) => window.eventOff(...args),
    eventEmit: (...args) => window.eventEmit(...args),
    waitGlobalInitialized: (...args) => window.waitGlobalInitialized(...args),
  };
  // Proxy any unrecognised TavernHelper method to missingApi notification
  window.TavernHelper = new Proxy(window.TavernHelper, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop !== 'then') {
        return (...args) => {
          post({ type: 'card-sandbox-action', action: 'missingApi', payload: { method: prop, args: String(args).slice(0, 500) } });
        };
      }
      return undefined;
    },
  });

  // --- Error handlers ---
  window.onerror = (message, source, lineno, colno, error) => {
    postDiagnostic('error', { message: String(message || '').slice(0, 1000), source: String(source || '').slice(0, 500), lineno, colno, stack: String(error?.stack || '').slice(0, 2000) });
    post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(message || '').slice(0, 1000), source: String(source || '').slice(0, 500), lineno, colno, stack: String(error?.stack || '').slice(0, 2000) } });
  };
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    postDiagnostic('unhandledrejection', describeError(reason));
    post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(reason?.message || reason || 'Unhandled rejection').slice(0, 1000), stack: String(reason?.stack || '').slice(0, 2000) } });
  });

  const readFieldValue = (field) => {
    if (!field) return '';
    const value = field.isContentEditable
      ? field.innerText || field.textContent
      : field.value || field.textContent;
    return String(value || '').replace(/\\r\\n/g, '\\n').trim().slice(0, 8000);
  };
  const isTextField = (element) => {
    if (!element) return false;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (element.isContentEditable) return true;
    if (tag !== 'input') return false;
    const type = String(element.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'search', 'url', 'email', 'tel', 'password', ''].includes(type);
  };
  const isExplicitChatSubmitControl = (target) => {
    if (!target || !target.getAttribute) return false;
    const id = safeText(target.getAttribute('id')).toLowerCase();
    const dataAction = safeText(target.getAttribute('data-action')).toLowerCase();
    const marker = safeText(target.getAttribute('data-xrp-submit-chat')).toLowerCase();
    return id === 'send_but'
      || id === 'send_textarea'
      || marker === 'true'
      || dataAction === 'submittext'
      || dataAction === 'submit-text'
      || dataAction === 'submit-free-start';
  };
  const looksLikeChatSubmitControl = (target) => {
    if (!target || !target.getAttribute) return false;
    if (isExplicitChatSubmitControl(target)) return true;
    const text = safeText(target.innerText || target.textContent || target.value);
    const aria = safeText(target.getAttribute('aria-label') || target.getAttribute('title'));
    const dataAction = safeText(target.getAttribute('data-action'));
    const className = safeText(target.className);
    const haystack = [text, aria, dataAction, className].join(' ').toLowerCase();
    return /(?:send|submit|continue|generate|record|发送|提交|继续|书写|续写|记录|开始剧情)/i.test(haystack);
  };
  const findNearestTextField = (target) => {
    if (!target) return null;
    const direct = isTextField(target) && !target.dataset?.xrpStInputProxy ? target : null;
    if (direct) return direct;
    const active = document.activeElement;
    if (isTextField(active) && !active.dataset?.xrpStInputProxy && readFieldValue(active)) return active;
    const containers = [
      target.closest && target.closest('form'),
      target.closest && target.closest('[data-action]'),
      target.closest && target.closest('section,article,main,aside,div'),
      document,
    ].filter(Boolean);
    for (const container of containers) {
      const fields = Array.from(container.querySelectorAll('textarea,input,[contenteditable="true"]'))
        .filter(field => isTextField(field) && !field.dataset?.xrpStInputProxy);
      const withValue = fields.find(field => readFieldValue(field));
      if (withValue) return withValue;
      if (fields[0]) return fields[0];
    }
    return null;
  };
  const postTextSubmit = (target, source) => {
    const field = findNearestTextField(target);
    const message = readFieldValue(field);
    if (!message) return false;
    const requestGenerationId = makeGenerationId();
    post({
      type: 'card-sandbox-action',
      action: 'submitText',
      payload: {
        message,
        source,
        sourceMessageId: getRuntimeMessageId(),
        generationId: requestGenerationId,
        clear: true,
        label: safeText(target?.innerText || target?.textContent || target?.value),
      },
    });
    postDiagnostic('submitText', { source, length: message.length, label: safeText(target?.innerText || target?.textContent || target?.value), generationId: requestGenerationId });
    if (field && field.value !== undefined) {
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (field && field.isContentEditable) {
      field.textContent = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  };
  const ensureSillyTavernInputProxy = () => {
    if (!document.getElementById('send_textarea')) {
      const textarea = document.createElement('textarea');
      textarea.id = 'send_textarea';
      textarea.setAttribute('aria-hidden', 'true');
      textarea.hidden = true;
      textarea.dataset.xrpStInputProxy = 'true';
      textarea.style.cssText = 'display:none!important;position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;';
      textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        if (postTextSubmit(textarea, 'st-send-textarea-enter')) event.preventDefault();
      });
      (document.body || document.documentElement).appendChild(textarea);
    }
    if (!document.getElementById('send_but')) {
      const button = document.createElement('button');
      button.id = 'send_but';
      button.type = 'button';
      button.setAttribute('aria-hidden', 'true');
      button.hidden = true;
      button.dataset.xrpStInputProxy = 'true';
      button.textContent = 'Send';
      button.style.cssText = 'display:none!important;position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;';
      button.addEventListener('click', () => postTextSubmit(button, 'st-send-button'));
      (document.body || document.documentElement).appendChild(button);
    }
    if (document.body) {
      document.querySelectorAll('[data-xrp-st-input-proxy]').forEach((element) => {
        if (element.parentElement !== document.body) document.body.appendChild(element);
      });
    }
  };
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

  const inferSharedSaveIdFromElement = (control) => {
    const directSaveElement = control && control.closest ? control.closest('[data-save-id]') : null;
    const directSaveId = safeText(directSaveElement?.getAttribute && directSaveElement.getAttribute('data-save-id'));
    if (directSaveId) return directSaveId;
    const saveIds = Object.keys(sharedSaveSessionById);
    if (!control || !saveIds.length) return '';
    let element = control;
    for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
      const nestedSaveElements = element.querySelectorAll ? Array.from(element.querySelectorAll('[data-save-id]')) : [];
      if (nestedSaveElements.length === 1) {
        const nestedSaveId = safeText(nestedSaveElements[0]?.getAttribute && nestedSaveElements[0].getAttribute('data-save-id'));
        if (nestedSaveId) return nestedSaveId;
      }
      const text = safeText(element.innerText || element.textContent);
      if (!text || text.length > 2500) continue;
      const ranked = saveIds
        .map((saveId) => {
          const meta = sharedSaveIndex[saveId] || {};
          const payload = sharedSavePayloads[saveId] || {};
          const chatLog = Array.isArray(payload.chatLog) ? payload.chatLog : [];
          const preview = safeText(meta.preview);
          const label = safeText(meta.label);
          const playerName = safeText(meta.playerProfile?.name);
          const characterName = safeText(meta.characterName);
          const messageCount = Number(meta.messageCount || chatLog.length || 0);
          let score = 0;
          if (preview && text.includes(preview.slice(0, Math.min(60, preview.length)))) score += 8;
          if (label && text.includes(label)) score += 3;
          if (playerName && text.includes(playerName)) score += 2;
          if (characterName && text.includes(characterName)) score += 1;
          if (messageCount && text.includes(String(messageCount)) && /条记录|條記錄|records?/i.test(text)) score += 3;
          return { saveId, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);
      if (ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score)) return ranked[0].saveId;
    }
    return '';
  };

  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('button,a,[role="button"],[data-action]') : null;
    if (!target) return;
    const dataAction = safeText(target.getAttribute && target.getAttribute('data-action'));
    const targetId = safeText(target.id);
    const controlText = safeText(target.innerText || target.textContent || target.value);
    if (
      targetId === 'cm-btn-select'
      || /(?:选定此缘|踏入苍玄|自由开局|听凭天意)/.test(controlText)
    ) {
      postDiagnostic('opening-control-click', {
        id: targetId,
        text: controlText.slice(0, 80),
        dataId: safeText(target.getAttribute && target.getAttribute('data-id')),
        datasetId: safeText(target.dataset?.id),
        hasGetChatMessages: typeof window.getChatMessages === 'function',
        hasBareGetChatMessages: (() => { try { return typeof getChatMessages === 'function'; } catch { return false; } })(),
        hasSetChatMessages: typeof window.setChatMessages === 'function',
        hasSetChatMessage: typeof window.setChatMessage === 'function',
      });
    }
    const saveId = inferSharedSaveIdFromElement(target);
    if (dataAction === 'load-save' && saveId && sharedSaveSessionById[saveId]) {
      post({
        type: 'card-sandbox-action',
        action: 'loadSaveSession',
        payload: { saveId, sessionId: sharedSaveSessionById[saveId] },
      });
      if (!debugTelemetry) return;
    }
    const controlLabel = safeText(target.getAttribute && (target.getAttribute('aria-label') || target.getAttribute('title')));
    const looksLikeDeleteSave = saveId && sharedSaveSessionById[saveId] && /(?:delete|remove|删除|刪除|×|✕)/i.test([dataAction, controlText, controlLabel].join(' '));
    if (looksLikeDeleteSave) {
      post({
        type: 'card-sandbox-action',
        action: 'deleteSaveSession',
        payload: { saveId, sessionId: sharedSaveSessionById[saveId] },
      });
      if (!debugTelemetry) return;
    }
    if (looksLikeChatSubmitControl(target) && postTextSubmit(target, 'click')) {
      return;
    }
    if (!debugTelemetry) return;
    post({
      type: 'card-sandbox-action',
      action: 'uiClick',
      payload: {
        text: safeText(target.innerText || target.textContent || target.value),
        id: safeText(target.id),
        className: safeText(target.className),
        dataAction,
        value: safeText(target.value),
      },
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!isTextField(event.target)) return;
    const target = event.target;
    if (postTextSubmit(target, isExplicitChatSubmitControl(target) ? 'enter' : 'text-enter')) {
      event.preventDefault();
    }
  });
  document.addEventListener('submit', (event) => {
    const target = event.target;
    event.preventDefault();
    if (!looksLikeChatSubmitControl(target)) return;
    const data = {};
    try {
      new FormData(target).forEach((value, key) => { data[key] = String(value).slice(0, 1000); });
    } catch {}
    data.sourceMessageId = getRuntimeMessageId();
    data.__xrpSubmitChat = true;
    post({ type: 'card-sandbox-action', action: 'formSubmit', payload: data });
  });
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
    __emitEvent('VARIABLE_UPDATE_ENDED');
    __emitMany(['CHAT_CHANGED', window.event_types.CHAT_CHANGED]);
    __emitMany(['MESSAGE_SWIPED', window.event_types.MESSAGE_SWIPED]);
  });
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
