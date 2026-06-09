import { SANDBOX_HOST_BRIDGE_SOURCE } from './sandbox-host-bridge';
import { SANDBOX_QUIET_RUNTIME_SOURCE } from './sandbox-quiet-runtime';

export function buildSandboxEarlyBridgeSource(runtimeJson: string, variablesJson: string): string {
  return `
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
${SANDBOX_QUIET_RUNTIME_SOURCE}
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
    try {
      const result = await requestHost('generateRaw', { request: payload });
      const content = String(result?.content || '');
      post({
        type: 'card-sandbox-action',
        action: 'diagnostic',
        payload: {
          event: 'generateRaw-quiet-result',
          generationId,
          contentLength: content.length,
          model: String(result?.model || ''),
          at: Date.now(),
        },
      });
      return content;
    } catch (error) {
      post({
        type: 'card-sandbox-action',
        action: 'diagnostic',
        payload: {
          event: 'generateRaw-quiet-error',
          generationId,
          message: String(error?.message || error).slice(0, 1000),
          at: Date.now(),
        },
      });
      throw error;
    }
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
}
