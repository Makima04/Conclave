export const SANDBOX_STORAGE_RUNTIME_SOURCE = String.raw`
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
`;
