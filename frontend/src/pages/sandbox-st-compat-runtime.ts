export const SANDBOX_ST_COMPAT_RUNTIME_SOURCE = String.raw`
  postDiagnostic('st-bridge-globals-ready', {
    getChatMessages: typeof getChatMessages,
    setChatMessages: typeof setChatMessages,
    setChatMessage: typeof setChatMessage,
    triggerSlash: typeof triggerSlash,
    mvu: typeof window.Mvu,
    directWindowCheck: typeof window.getChatMessages,
    globalThisCheck: typeof globalThis.getChatMessages,
  });
  const __eventHandlers = window.__XRPEventHandlers instanceof Map ? window.__XRPEventHandlers : new Map();
  window.__XRPEventHandlers = __eventHandlers;
  const __emittedEvents = new Set();
  const __resolveEventName = (eventName) => {
    if (typeof eventName === 'string') return eventName;
    if (eventName && typeof eventName === 'object') {
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
      const currentMessageVariables = getVariableStore({ type: 'message' });
      const next = window._.merge({}, currentMessageVariables, vars);
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
      if (moduleName === 'mvu') return window.Mvu;
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
  window.onerror = (message, source, lineno, colno, error) => {
    postDiagnostic('error', { message: String(message || '').slice(0, 1000), source: String(source || '').slice(0, 500), lineno, colno, stack: String(error?.stack || '').slice(0, 2000) });
    post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(message || '').slice(0, 1000), source: String(source || '').slice(0, 500), lineno, colno, stack: String(error?.stack || '').slice(0, 2000) } });
  };
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    postDiagnostic('unhandledrejection', describeError(reason));
    post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(reason?.message || reason || 'Unhandled rejection').slice(0, 1000), stack: String(reason?.stack || '').slice(0, 2000) } });
  });
`;
