/**
 * @deprecated Sandbox document builder -- FALLBACK ONLY.
 *
 * The primary path for external character card rendering is now the
 * import-time normalization pipeline (ConclaveCardPackage).
 *
 * This module is retained for:
 * - Import normalization failure fallback (cards without conclave_package)
 * - Raw ST sandbox preview in the Import Workbench
 * - Explicit user opt-in for "raw sandbox mode" (render_mode = 'sandbox')
 *
 * New cards should be imported via /charactercards/import and rendered
 * through PlatformPackageRenderer instead.
 */

// Sandbox document builder with MiniQuery shim and bridge script
// Extracted from Chat.tsx GROUP 10

import { serializeSandboxData } from './card-content';
import vueGlobalRuntime from 'vue/dist/vue.global.prod.js?raw';

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

export function buildSandboxDocument(innerHtml: string, variables: any): string {
  const body = normalizeSandboxHtml(innerHtml);
  const variablesJson = serializeSandboxData(variables);

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
    show() { this.items.forEach(el => { if (el?.style) el.style.display = ''; }); return this; }
    hide() { this.items.forEach(el => { if (el?.style) el.style.display = 'none'; }); return this; }
    append(value) { this.items.forEach(el => { if (!el) return; if (typeof value === 'string') el.insertAdjacentHTML('beforeend', value); else if (value instanceof Node) el.appendChild(value.cloneNode(true)); }); return this; }
    slideDown(duration, callback) { this.items.forEach(el => { if (el?.style) el.style.display = ''; if (typeof duration === 'function') duration.call(el); else if (typeof callback === 'function') setTimeout(() => callback.call(el), Number(duration) || 0); }); return this; }
    slideUp(duration, callback) { this.items.forEach(el => { const done = () => { if (el?.style) el.style.display = 'none'; if (typeof callback === 'function') callback.call(el); }; if (typeof duration === 'function') { done(); duration.call(el); } else setTimeout(done, Number(duration) || 0); }); return this; }
    remove() { this.items.forEach(el => el?.remove && el.remove()); return this; }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }
  window.$ = window.jQuery = (value) => new MiniQuery(value);
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
  const post = (message) => parent.postMessage(message, '*');
  const safeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const notify = () => post({ type: 'sandbox-resize', height: Math.min(1800, Math.max(360, document.documentElement.scrollHeight || document.body.scrollHeight || 0)) });
  const runtimeVariables = ${variablesJson};
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
  const installStorageShim = (name) => {
    let usable = false;
    try {
      const storage = window[name];
      const key = '__xrp_storage_probe__';
      storage.setItem(key, '1');
      storage.removeItem(key);
      usable = true;
    } catch {}
    if (!usable) {
      try {
        Object.defineProperty(window, name, { value: createMemoryStorage(), configurable: true });
      } catch {
        window[name] = createMemoryStorage();
      }
    }
  };
  installStorageShim('localStorage');
  installStorageShim('sessionStorage');

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
    const makeObjectStore = (state, storeName, keyPath = 'id') => {
      if (!state.stores.has(storeName)) state.stores.set(storeName, { keyPath, rows: new Map() });
      const store = state.stores.get(storeName);
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
  const runtimeMessage = Object.freeze({
    message_id: 0,
    id: 0,
    swipe_id: 0,
    swipes: [],
    data: Object.freeze({
      stat_data: runtimeVariables,
      display_data: runtimeVariables,
      variables: runtimeVariables,
    }),
    variables: runtimeVariables,
  });
  window.__XRPBridge = Object.freeze({
    applyGreeting: (index) => post({ type: 'card-sandbox-action', action: 'applyGreeting', payload: { index: Number(index) } }),
    readVariables: (paths) => post({ type: 'card-sandbox-action', action: 'readVariables', payload: { paths: Array.isArray(paths) ? paths.slice(0, 50) : [] } }),
    writeVariables: (changes) => post({ type: 'card-sandbox-action', action: 'writeVariables', payload: { changes: changes && typeof changes === 'object' ? changes : {} } }),
    openStatusPanel: () => post({ type: 'card-sandbox-action', action: 'openStatusPanel', payload: {} }),
    submitFreeStart: (payload) => post({ type: 'card-sandbox-action', action: 'submitFreeStart', payload: payload && typeof payload === 'object' ? payload : {} }),
  });
  window.getCurrentMessageId = () => 0;
  window.getChatMessages = async () => [runtimeMessage];
  window.getChatMessage = async () => runtimeMessage;
  window.getVariables = async () => runtimeVariables;
  window.__XRPVariables = runtimeVariables;
  window.updateVariablesWith = (updater, options) => {
    const next = { ...(runtimeVariables || {}) };
    try {
      if (typeof updater === 'function') {
        updater(next);
      } else if (updater && typeof updater === 'object') {
        Object.assign(next, updater);
      }
    } catch (error) {
      post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(error?.message || error).slice(0, 1000), stack: String(error?.stack || '').slice(0, 2000) } });
      return;
    }
    post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: next, options: options || {} } });
  };
  window.setChatMessage = (message, messageId, options) => {
    const swipeId = Number(options?.swipe_id);
    post({ type: 'card-sandbox-action', action: 'setChatMessage', payload: { message: String(message || '').slice(0, 8000), swipeId: Number.isFinite(swipeId) ? swipeId : undefined } });
  };
  window.setChatMessages = async (messages) => {
    const first = Array.isArray(messages) ? messages[0] : null;
    const swipeId = Number(first?.swipe_id);
    if (Number.isFinite(swipeId)) {
      post({ type: 'card-sandbox-action', action: 'applyOpeningSwipe', payload: { swipeId } });
      return;
    }
    if (first?.message) {
      post({ type: 'card-sandbox-action', action: 'setChatMessage', payload: { message: String(first.message).slice(0, 8000) } });
    }
  };
  window.triggerSlash = (command) => post({ type: 'card-sandbox-action', action: 'triggerSlash', payload: { command: String(command || '').slice(0, 2000) } });

  // --- setVariables global ---
  window.setVariables = (vars) => post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: vars && typeof vars === 'object' ? vars : {} } });
  window.getMvuData = () => ({ stat_data: runtimeVariables });
  window.replaceMvuData = (data, options) => post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: data?.stat_data || data || {}, options: options || {} } });
  // --- Event Bus ---
  const __eventHandlers = new Map();
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
  window.waitGlobalInitialized = (name) => {
    const moduleName = String(name || '').toLowerCase();
    const makeResult = () => {
      if (moduleName === 'mvu') {
        return {
          events: { VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED' },
          getMvuData: window.getMvuData,
          replaceMvuData: window.replaceMvuData,
        };
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
    setVariables: (...args) => window.setVariables(...args),
    triggerSlash: (...args) => window.triggerSlash(...args),
    updateVariablesWith: (...args) => window.updateVariablesWith(...args),
    getMvuData: (...args) => window.getMvuData(...args),
    replaceMvuData: (...args) => window.replaceMvuData(...args),
    eventOn: (...args) => window.eventOn(...args),
    eventOff: (...args) => window.eventOff(...args),
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
    post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(message || '').slice(0, 1000), source: String(source || '').slice(0, 500), lineno, colno, stack: String(error?.stack || '').slice(0, 2000) } });
  };
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(reason?.message || reason || 'Unhandled rejection').slice(0, 1000), stack: String(reason?.stack || '').slice(0, 2000) } });
  });

  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('button,a,[role="button"],[data-action]') : null;
    if (!target) return;
    post({
      type: 'card-sandbox-action',
      action: 'uiClick',
      payload: {
        text: safeText(target.innerText || target.textContent || target.value),
        id: safeText(target.id),
        className: safeText(target.className),
        dataAction: safeText(target.getAttribute && target.getAttribute('data-action')),
        value: safeText(target.value),
      },
    });
  }, true);
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = {};
    try {
      new FormData(event.target).forEach((value, key) => { data[key] = String(value).slice(0, 1000); });
    } catch {}
    post({ type: 'card-sandbox-action', action: 'formSubmit', payload: data });
  }, true);
  new ResizeObserver(notify).observe(document.documentElement);
  window.addEventListener('load', notify);
  setTimeout(notify, 80);
  setTimeout(notify, 500);

  // Emit initialization events so Vue/MVU code can proceed
  requestAnimationFrame(() => {
    __emitEvent('APP_READY');
    __emitEvent('GLOBAL_INITIALIZED');
    __emitEvent('VARIABLE_UPDATE_ENDED');
    __emitEvent('CHAT_CHANGED');
    __emitEvent('MESSAGE_SWIPED');
  });
})();
</script>`;

  const injected = `${shim}${bridge}`;
  if (/<\/head>/i.test(body)) {
    return body.replace(/<\/head>/i, `${injected}</head>`);
  }
  if (/<script\b/i.test(body)) {
    return body.replace(/<script\b/i, `${injected}<script`);
  }
  if (/<\/body>/i.test(body)) {
    return body.replace(/<\/body>/i, `${injected}</body>`);
  }
  return `${injected}${body}`;
}
