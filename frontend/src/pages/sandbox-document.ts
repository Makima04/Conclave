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
  const describeError = (error) => ({
    message: String(error?.message || error || '').slice(0, 1000),
    stack: String(error?.stack || '').slice(0, 2000),
  });
  const postDiagnostic = (event, payload = {}) => post({
    type: 'card-sandbox-action',
    action: 'diagnostic',
    payload: { event, ...payload, at: Date.now() },
  });
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
  let lastNotifiedHeight = 0;
  let notifyFrame = 0;
  const readHeight = () => Math.min(1800, Math.max(360, document.documentElement.scrollHeight || document.body.scrollHeight || 0));
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
  const runtimeVariables = ${variablesJson};
  const runtimeContext = ${runtimeJson};
  const runtimeSubmission = runtimeContext.submission && typeof runtimeContext.submission === 'object'
    ? runtimeContext.submission
    : { status: 'idle' };
  const sharedSaves = Array.isArray(runtimeContext.sharedSaves) ? runtimeContext.sharedSaves : [];
  const sharedSaveIndex = {};
  const sharedSavePayloads = {};
  const sharedSaveSessionById = {};
  for (const save of sharedSaves) {
    if (!save || !save.saveId) continue;
    const saveId = String(save.saveId);
    sharedSaveIndex[saveId] = save.meta && typeof save.meta === 'object' ? save.meta : {};
    sharedSavePayloads[saveId] = save.payload && typeof save.payload === 'object' ? save.payload : {};
    if (save.sessionId) sharedSaveSessionById[saveId] = String(save.sessionId);
  }
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
  const seedSharedSaveLocalStorage = () => {
    if (!sharedSaves.length) return;
    try {
      window.localStorage.setItem('islandmilfcode:save-index:v2', JSON.stringify(sharedSaveIndex));
      for (const [saveId, payload] of Object.entries(sharedSavePayloads)) {
        window.localStorage.setItem('islandmilfcode:save-payload:v2:' + saveId, JSON.stringify(payload));
      }
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
    const makeObjectStore = (state, storeName, keyPath = 'id') => {
      if (!state.stores.has(storeName)) state.stores.set(storeName, { keyPath, rows: new Map() });
      const store = state.stores.get(storeName);
      if (sharedSaves.length && storeName === 'save-index' && !store.rows.has('__index__')) {
        store.rows.set('__index__', { id: '__index__', key: '__index__', value: sharedSaveIndex });
      }
      if (sharedSaves.length && storeName === 'save-payload') {
        for (const [saveId, payload] of Object.entries(sharedSavePayloads)) {
          if (!store.rows.has(saveId)) store.rows.set(saveId, { id: saveId, key: saveId, value: payload });
        }
      }
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
  window._ = window._ || {
    get: getPath,
    set: setPath,
    clamp: (value, lower, upper) => {
      const number = Number(value);
      const min = Number(lower);
      const max = Number(upper);
      if (!Number.isFinite(number)) return Number.isFinite(min) ? min : 0;
      return Math.min(Number.isFinite(max) ? max : number, Math.max(Number.isFinite(min) ? min : number, number));
    },
    pickBy: (source, predicate = Boolean) => Object.fromEntries(Object.entries(source || {}).filter(([key, value]) => predicate(value, key))),
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
  const runtimeMessages = Array.isArray(runtimeContext.messages) && runtimeContext.messages.length
    ? runtimeContext.messages.map(normalizeMessage)
    : [normalizeMessage({
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
  const requestedCurrentId = runtimeContext.currentMessageId ?? runtimeContext.currentMessage?.message_id ?? runtimeContext.currentMessage?.id;
  const runtimeMessage = normalizeMessage(
    runtimeContext.currentMessage || runtimeMessages.find(item => String(item.message_id) === String(requestedCurrentId) || String(item.id) === String(requestedCurrentId)) || runtimeMessages[runtimeMessages.length - 1],
    runtimeMessages.length - 1,
  );
  const runtimeMessagesJson = JSON.stringify(runtimeMessages);
  const runtimeMessageJson = JSON.stringify(runtimeMessage);
  const runtimeMessagesByIdJson = new Map();
  runtimeMessages.forEach(item => {
    const json = JSON.stringify(item);
    runtimeMessagesByIdJson.set(String(item.message_id), json);
    runtimeMessagesByIdJson.set(String(item.id), json);
  });
  const cloneJsonString = (value) => {
    try { return JSON.parse(value); } catch { return null; }
  };
  window.__XRPBridge = Object.freeze({
    applyGreeting: (index) => post({ type: 'card-sandbox-action', action: 'applyGreeting', payload: { index: Number(index) } }),
    readVariables: (paths) => post({ type: 'card-sandbox-action', action: 'readVariables', payload: { paths: Array.isArray(paths) ? paths.slice(0, 50) : [] } }),
    writeVariables: (changes) => post({ type: 'card-sandbox-action', action: 'writeVariables', payload: { changes: changes && typeof changes === 'object' ? changes : {} } }),
    openStatusPanel: () => post({ type: 'card-sandbox-action', action: 'openStatusPanel', payload: {} }),
    submitFreeStart: (payload) => post({
      type: 'card-sandbox-action',
      action: 'submitFreeStart',
      payload: { ...(payload && typeof payload === 'object' ? payload : {}), sourceMessageId: runtimeMessage.message_id ?? runtimeMessage.id ?? null },
    }),
  });
  window.__XRPRuntime = Object.freeze({
    variables: runtimeVariables,
    messages: runtimeMessages,
    currentMessage: runtimeMessage,
    submission: runtimeSubmission,
  });
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
  window.getChatMessages = async () => cloneJsonString(runtimeMessagesJson) || cloneJson(runtimeMessages);
  window.getChatMessage = async (messageId) => {
    const id = messageId ?? runtimeMessage.message_id ?? runtimeMessage.id;
    return cloneJsonString(runtimeMessagesByIdJson.get(String(id)) || runtimeMessageJson) || cloneJson(runtimeMessage);
  };
  window.getVariables = async () => runtimeVariables;
  window.getAllVariables = async () => ({
    global: {},
    chat: runtimeVariables,
    character: runtimeVariables,
    message: runtimeMessage.data || {},
    variables: runtimeVariables,
  });
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
  window.triggerSlash = (command) => post({
    type: 'card-sandbox-action',
    action: 'triggerSlash',
    payload: { command: String(command || '').slice(0, 2000), sourceMessageId: runtimeMessage.message_id ?? runtimeMessage.id ?? null },
  });

  // --- setVariables global ---
  window.setVariables = (vars) => post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: vars && typeof vars === 'object' ? vars : {} } });
  window.getMvuData = async (options = {}) => {
    const message = resolveRuntimeMessage(options);
    const data = message?.data && typeof message.data === 'object' ? message.data : {};
    return cloneJson({
      stat_data: data.stat_data || runtimeVariables,
      display_data: data.display_data || data.stat_data || runtimeVariables,
      variables: data.variables || message?.variables || runtimeVariables,
      message_id: message?.message_id ?? message?.id,
      swipe_id: message?.swipe_id ?? 0,
    });
  };
  window.replaceMvuData = async (data, options = {}) => {
    const next = data?.stat_data || data?.variables || data || {};
    post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: next && typeof next === 'object' ? next : {}, options: options || {} } });
    __emitEvent('VARIABLE_UPDATE_ENDED', data, options);
    return true;
  };
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
  window.eventEmit = __emitEvent;
  window.tavern_events = {
    APP_READY: 'APP_READY',
    GLOBAL_INITIALIZED: 'GLOBAL_INITIALIZED',
    VARIABLE_UPDATE_ENDED: 'VARIABLE_UPDATE_ENDED',
    CHAT_CHANGED: 'CHAT_CHANGED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
  };
  window.name1 = runtimeMessages.find(item => item.is_user)?.name || '你';
  window.SillyTavern = window.SillyTavern || { getContext: () => ({ name1: window.name1, characters: [], chat: runtimeMessages }) };
  window.substituteMacros = window.substitudeMacros = (source) => String(source ?? '')
    .replace(/{{user}}/g, window.name1 || '你')
    .replace(/{{char}}/g, runtimeMessage.name || '');
  window.errorCatched = async (fn) => {
    try {
      return typeof fn === 'function' ? await fn() : undefined;
    } catch (error) {
      post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(error?.message || error).slice(0, 1000), stack: String(error?.stack || '').slice(0, 2000) } });
      return undefined;
    }
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
      const next = window._.merge({}, runtimeVariables, vars);
      post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: next, options: { source: 'Mvu.insertVariables' } } });
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
  const looksLikeSubmitControl = (target) => {
    if (!target) return false;
    const text = safeText(target.innerText || target.textContent || target.value);
    const aria = safeText(target.getAttribute && (target.getAttribute('aria-label') || target.getAttribute('title')));
    const dataAction = safeText(target.getAttribute && target.getAttribute('data-action'));
    const type = safeText(target.getAttribute && target.getAttribute('type')).toLowerCase();
    const haystack = [text, aria, dataAction, type].join(' ').toLowerCase();
    return /(?:send|submit|continue|record|发送|提交|继续|书写|记录|开始)/i.test(haystack);
  };
  const findNearestTextField = (target) => {
    if (!target) return null;
    const direct = isTextField(target) ? target : null;
    if (direct) return direct;
    const active = document.activeElement;
    if (isTextField(active) && readFieldValue(active)) return active;
    const containers = [
      target.closest && target.closest('form'),
      target.closest && target.closest('[data-action]'),
      target.closest && target.closest('section,article,main,aside,div'),
      document,
    ].filter(Boolean);
    for (const container of containers) {
      const fields = Array.from(container.querySelectorAll('textarea,input,[contenteditable="true"]')).filter(isTextField);
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
    post({
      type: 'card-sandbox-action',
      action: 'submitText',
      payload: {
        message,
        source,
        sourceMessageId: runtimeMessage.message_id ?? runtimeMessage.id ?? null,
        clear: true,
        label: safeText(target?.innerText || target?.textContent || target?.value),
      },
    });
    postDiagnostic('submitText', { source, length: message.length, label: safeText(target?.innerText || target?.textContent || target?.value) });
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

  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('button,a,[role="button"],[data-action]') : null;
    if (!target) return;
    const dataAction = safeText(target.getAttribute && target.getAttribute('data-action'));
    const saveId = safeText(target.getAttribute && target.getAttribute('data-save-id'));
    if (dataAction === 'load-save' && saveId && sharedSaveSessionById[saveId]) {
      post({
        type: 'card-sandbox-action',
        action: 'loadSaveSession',
        payload: { saveId, sessionId: sharedSaveSessionById[saveId] },
      });
      if (!debugTelemetry) return;
    }
    if (looksLikeSubmitControl(target) && postTextSubmit(target, 'click')) {
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
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!isTextField(event.target)) return;
    if (postTextSubmit(event.target, 'enter')) {
      event.preventDefault();
    }
  }, true);
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = {};
    try {
      new FormData(event.target).forEach((value, key) => { data[key] = String(value).slice(0, 1000); });
    } catch {}
    data.sourceMessageId = runtimeMessage.message_id ?? runtimeMessage.id ?? null;
    post({ type: 'card-sandbox-action', action: 'formSubmit', payload: data });
  }, true);
  ensureSubmissionOverlay();
  new ResizeObserver(notify).observe(document.documentElement);
  window.addEventListener('load', notify);
  setTimeout(notify, 80);
  setTimeout(notify, 500);
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
