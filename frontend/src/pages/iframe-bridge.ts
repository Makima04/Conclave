// Iframe bridge script (v4)
// JS-Slash-Runner compatible API shim for card iframes.
// Provides window.TavernHelper, window.Mvu, window.triggerSlash,
// window.getLorebookEntries, window.eventEmit, and lodash-like `_`.
//
// All API calls use postMessage to the parent window, which routes
// them to our Rust backend. Responses come back asynchronously.

/**
 * Build the complete bridge script for injection into iframe srcdoc.
 * Accepts session ID and world book ID for API routing.
 */
export function buildIframeBridgeScript(sessionId?: string, worldBookId?: string): string {
  return `
(function() {
  'use strict';
  var _sessionId = ${JSON.stringify(sessionId || '')};
  var _worldBookId = ${JSON.stringify(worldBookId || '')};
  var _runtime = window.__XRP_INITIAL_RUNTIME || null;
  var _chatMessages = [];
  var _runtimeInitialized = false;

  // ── Async request/response infrastructure ──
  var _pendingRequests = {};
  var _requestCounter = 0;

  function _apiCall(method, params) {
    return new Promise(function(resolve, reject) {
      var id = ++_requestCounter;
      _pendingRequests[id] = { resolve: resolve, reject: reject };
      var msg = { type: 'th_api', method: method, requestId: id };
      if (params !== undefined) msg.params = params;
      window.parent.postMessage(msg, '*');
      // Timeout after 30s
      setTimeout(function() {
        if (_pendingRequests[id]) {
          delete _pendingRequests[id];
          reject(new Error('API call timeout: ' + method));
        }
      }, 30000);
    });
  }

  // ── Event system ──
  var _eventListeners = {};

  function eventEmit(eventType) {
    var args = Array.prototype.slice.call(arguments, 1);
    var listeners = _eventListeners[eventType];
    if (listeners) {
      // Copy to avoid mutation during iteration
      listeners = listeners.slice();
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i].apply(null, args); } catch(e) { console.error('eventEmit error:', eventType, e); }
      }
    }
  }

  function eventOn(eventType, callback) {
    if (!_eventListeners[eventType]) _eventListeners[eventType] = [];
    _eventListeners[eventType].push(callback);
    return { stop: function() { eventRemoveListener(eventType, callback); } };
  }

  function eventOnce(eventType, callback) {
    var wrapper = function() {
      eventRemoveListener(eventType, wrapper);
      callback.apply(null, arguments);
    };
    _eventListeners[eventType] = _eventListeners[eventType] || [];
    _eventListeners[eventType].push(wrapper);
    return { stop: function() { eventRemoveListener(eventType, wrapper); } };
  }

  function eventRemoveListener(eventType, callback) {
    var list = _eventListeners[eventType];
    if (list) {
      var i = list.indexOf(callback);
      if (i >= 0) list.splice(i, 1);
    }
  }

  function eventClearAll() {
    _eventListeners = {};
  }

  function eventClearEvent(eventType) {
    if (eventType) delete _eventListeners[eventType];
  }

  function eventClearListener(callback) {
    for (var eventType in _eventListeners) {
      var list = _eventListeners[eventType] || [];
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] === callback) list.splice(i, 1);
      }
    }
  }

  function eventEmitAndWait(eventType) {
    eventEmit.apply(null, arguments);
    return Promise.resolve();
  }

  // ── Minimal lodash-like _ for deep object access ──
  window._ = (function() {
    function get(obj, path, defaultValue) {
      if (obj == null) return defaultValue;
      var keys = String(path).split('.');
      var result = obj;
      for (var i = 0; i < keys.length; i++) {
        if (result == null) return defaultValue;
        result = result[keys[i]];
      }
      return result !== undefined ? result : defaultValue;
    }

    function set(obj, path, value) {
      var keys = String(path).split('.');
      var current = obj;
      for (var i = 0; i < keys.length - 1; i++) {
        var key = keys[i];
        if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
          current[key] = {};
        }
        current = current[key];
      }
      current[keys[keys.length - 1]] = value;
      return obj;
    }

    function has(obj, path) {
      if (obj == null) return false;
      var keys = String(path).split('.');
      var current = obj;
      for (var i = 0; i < keys.length; i++) {
        if (current == null || !(keys[i] in current)) return false;
        current = current[keys[i]];
      }
      return true;
    }

    function clamp(value, lower, upper) {
      if (value < lower) return lower;
      if (value > upper) return upper;
      return value;
    }

    function omit(obj, keys) {
      var result = {};
      for (var k in obj) {
        if (obj.hasOwnProperty(k) && keys.indexOf(k) === -1) {
          result[k] = obj[k];
        }
      }
      return result;
    }

    function pick(obj, keys) {
      var result = {};
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] in obj) result[keys[i]] = obj[keys[i]];
      }
      return result;
    }

    function range(start, end) {
      if (end === undefined) { end = start; start = 0; }
      var result = [];
      for (var i = start; i < end; i++) result.push(i);
      return result;
    }

    function cloneDeep(value) {
      if (value == null) return value;
      try { return JSON.parse(JSON.stringify(value)); } catch(e) { return value; }
    }

    return {
      get: get, set: set, has: has, clamp: clamp,
      omit: omit, pick: pick, range: range, cloneDeep: cloneDeep
    };
  })();

  function _clone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch(e) { return value; }
  }

  function _asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function _isPlainObject(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
  }

  function _hasKeys(value) {
    return _isPlainObject(value) && Object.keys(value).length > 0;
  }

  function _wrapMessageData(value) {
    var data = _isPlainObject(value) ? value : {};
    var variables = _isPlainObject(data.variables) ? data.variables
      : _isPlainObject(data.stat_data) ? data.stat_data
      : _isPlainObject(data.display_data) ? data.display_data
      : data;
    var wrapped = {};
    for (var key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) wrapped[key] = data[key];
    }
    wrapped.stat_data = _isPlainObject(data.stat_data) ? data.stat_data : variables;
    wrapped.display_data = _isPlainObject(data.display_data) ? data.display_data : variables;
    wrapped.variables = variables;
    wrapped.chat_variables = _isPlainObject(data.chat_variables) ? data.chat_variables : variables;
    if (data.platform_state !== undefined) wrapped.platform_state = data.platform_state;
    if (data.writable_state !== undefined) wrapped.writable_state = data.writable_state;
    return wrapped;
  }

  function _runtimeMessageId(message, fallbackIndex) {
    if (!message) return fallbackIndex;
    if (message.message_id != null) return message.message_id;
    if (message.messageId != null) return message.messageId;
    if (message.id != null) return message.id;
    return fallbackIndex;
  }

  function _activeText(message) {
    return String(message && (message.message != null ? message.message : message.content != null ? message.content : '') || '');
  }

  function _normalizeRuntimeMessage(message, index) {
    message = message || {};
    var role = String(message.role || (message.is_user ? 'user' : 'assistant'));
    var text = _activeText(message);
    var swipes = _asArray(message.swipes).map(function(item) { return String(item == null ? '' : item); });
    var rawSwipeId = Number(message.swipe_id != null ? message.swipe_id : message.swipeId != null ? message.swipeId : 0);
    var swipeId = Number.isFinite(rawSwipeId) ? Math.max(0, Math.floor(rawSwipeId)) : 0;
    if (swipes.length === 0) {
      swipes = [text];
      swipeId = 0;
    } else if (swipeId >= swipes.length) {
      swipes = swipes.concat([text]);
      swipeId = swipes.length - 1;
    }
    if (!swipes[swipeId] && text) swipes[swipeId] = text;

    var baseData = message.data || message.variables || {};
    var swipesData = _asArray(message.swipes_data || message.swipesData).map(function(item) { return item || {}; });
    var swipesInfo = _asArray(message.swipes_info || message.swipesInfo).map(function(item) { return item || {}; });
    while (swipesData.length < swipes.length) swipesData.push(swipeId === swipesData.length ? baseData : {});
    while (swipesInfo.length < swipes.length) swipesInfo.push({});
    var activeData = _hasKeys(swipesData[swipeId]) ? swipesData[swipeId] : baseData;

    return {
      id: message.id,
      message_id: _runtimeMessageId(message, index),
      name: String(message.name || (role === 'user' ? '{{user}}' : '{{char}}')),
      role: role,
      is_hidden: Boolean(message.is_system || message.is_hidden),
      message: swipes[swipeId] || text,
      content: swipes[swipeId] || text,
      data: _wrapMessageData(activeData),
      extra: swipesInfo[swipeId] || {},
      swipe_id: swipeId,
      swipes: swipes,
      swipes_data: swipesData.map(_wrapMessageData),
      swipes_info: swipesInfo,
      created_at: message.created_at,
      send_date: message.send_date || message.created_at
    };
  }

  function _normalizeRuntime(runtime) {
    var source = runtime && Array.isArray(runtime.messages) ? runtime.messages : [];
    _chatMessages = source.map(function(message, index) { return _normalizeRuntimeMessage(message, index); });
    window.chat = _chatMessages;
    window.__xpRuntime = runtime || null;
    window.__xpChatMessages = _chatMessages;
  }

  function _lastMessageId() {
    return _chatMessages.length > 0 ? _chatMessages[_chatMessages.length - 1].message_id : -1;
  }

  function _currentMessageId() {
    if (_runtime && _runtime.currentMessageId != null) return _runtime.currentMessageId;
    if (_runtime && _runtime.currentMessage && _runtime.currentMessage.message_id != null) return _runtime.currentMessage.message_id;
    if (_runtime && _runtime.currentMessage && _runtime.currentMessage.id != null) return _runtime.currentMessage.id;
    return _lastMessageId();
  }

  function _demacroText(text) {
    return String(text == null ? '' : text)
      .replace(/\\{\\{lastMessageId\\}\\}/gi, String(_lastMessageId()))
      .replace(/\\{\\{user\\}\\}/gi, '你')
      .replace(/\\{\\{char\\}\\}/gi, '');
  }

  function _clampIndex(value, min, max) {
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 0) n = max + n + 1;
    n = Math.max(min, Math.min(max, n));
    return n;
  }

  function _findMessageIndex(input) {
    if (input === undefined || input === null) return -1;
    var text = String(input);
    for (var i = 0; i < _chatMessages.length; i++) {
      var message = _chatMessages[i];
      if (!message) continue;
      if (String(message.message_id) === text || String(message.id) === text) return i;
    }
    return -1;
  }

  function _parseMessageRange(input) {
    var max = _chatMessages.length - 1;
    if (max < 0) return null;
    if (input === undefined || input === null || input === 'all') return { start: 0, end: max };
    if (input === 'latest') return { start: max, end: max };
    var exactIndex = _findMessageIndex(input);
    if (exactIndex >= 0) return { start: exactIndex, end: exactIndex };
    var text = _demacroText(input);
    var single = text.match(/^\\s*(-?\\d+)\\s*$/);
    if (single) {
      var idx = _clampIndex(single[1], 0, max);
      return idx == null ? null : { start: idx, end: idx };
    }
    var range = text.match(/^\\s*(-?\\d+)\\s*-\\s*(-?\\d+)\\s*$/);
    if (!range) return null;
    var a = _clampIndex(range[1], 0, max);
    var b = _clampIndex(range[2], 0, max);
    if (a == null || b == null) return null;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  function _getLocalChatMessages(range, options) {
    options = options || {};
    var parsed = _parseMessageRange(range);
    if (!parsed) return [];
    var result = [];
    for (var i = parsed.start; i <= parsed.end; i++) {
      var message = _chatMessages[i];
      if (!message) continue;
      if (options.role && options.role !== 'all' && message.role !== options.role) continue;
      if (options.hide_state && options.hide_state !== 'all') {
        if (options.hide_state === 'hidden' && !message.is_hidden) continue;
        if (options.hide_state === 'unhidden' && message.is_hidden) continue;
      }
      if (options.include_swipes) {
        result.push({
          message_id: message.message_id,
          name: message.name,
          role: message.role,
          is_hidden: message.is_hidden,
          swipe_id: message.swipe_id,
          swipes: _clone(message.swipes),
          swipes_data: _clone(message.swipes_data),
          swipes_info: _clone(message.swipes_info)
        });
      } else {
        result.push({
          message_id: message.message_id,
          name: message.name,
          role: message.role,
          is_hidden: message.is_hidden,
          message: message.message,
          data: _clone(message.data),
          extra: _clone(message.extra),
          swipe_id: message.swipe_id,
          swipes: _clone(message.swipes),
          swipes_data: _clone(message.swipes_data)
        });
      }
    }
    return result;
  }

  function _emitRuntimeEvents(previous, next, reason) {
    if (!_runtimeInitialized) {
      eventEmit('chatLoaded');
      if (next.length > 0) {
        var current = next[next.length - 1];
        eventEmit(current.role === 'user' ? 'user_message_rendered' : 'character_message_rendered', current.message_id);
      }
      _runtimeInitialized = true;
      return;
    }
    if (next.length < previous.length) {
      eventEmit('message_deleted');
    }
    var max = Math.max(previous.length, next.length);
    for (var i = 0; i < max; i++) {
      var before = previous[i];
      var after = next[i];
      if (!after) continue;
      if (!before) {
        eventEmit(after.role === 'user' ? 'user_message_rendered' : 'character_message_rendered', after.message_id);
        continue;
      }
      if (before.swipe_id !== after.swipe_id) {
        eventEmit('message_swiped', after.message_id);
      }
      if (before.message !== after.message || before.swipe_id !== after.swipe_id) {
        eventEmit('message_updated', after.message_id);
      }
    }
    if (reason) eventEmit('xrp_runtime_updated', reason);
  }

  function _setRuntime(runtime, reason) {
    var previous = _chatMessages.slice();
    _runtime = runtime || null;
    _normalizeRuntime(_runtime);
    _emitRuntimeEvents(previous, _chatMessages, reason || 'runtimeUpdated');
  }

  // ── Variables store (mirrors host state) ──
  // Must be synchronous for Mvu.getMvuData() compatibility.
  // Initialized from host via 'variablesUpdated' message.
  window.__xpVariables = {};

  // ── Mvu shim ──
  // IMPORTANT: getMvuData() must be SYNCHRONOUS.
  window.Mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initiailized',
      VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
      COMMAND_PARSED: 'mag_command_parsed',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
      BEFORE_MESSAGE_UPDATE: 'mag_before_message_update'
    },

    getMvuData: function(options) {
      // SYNC: read from cached variables. Returns a MvuData-like object.
      var vars = window.__xpVariables || {};
      return {
        stat_data: vars,
        initialized_lorebooks: {}
      };
    },

    replaceMvuData: function(mvuData, options) {
      return _apiCall('mvu_replaceData', { data: mvuData, options: options || {} });
    },

    parseMessage: function(message, oldData) {
      return _apiCall('mvu_parseMessage', { message: message, oldData: oldData });
    },

    isDuringExtraAnalysis: function() { return false; }
  };

  // ── Global API functions (mirror JS-Slash-Runner interface) ──

  // triggerSlash: send a slash command to the host
  window.triggerSlash = function(cmd) {
    return _apiCall('triggerSlash', { cmd: String(cmd) });
  };

  // World book / lorebook entries
  window.getLorebookEntries = function(bookName) {
    return _apiCall('getLorebookEntries', { bookName: String(bookName) });
  };

  window.setLorebookEntries = function(bookName, entries) {
    return _apiCall('setLorebookEntries', { bookName: String(bookName), entries: entries });
  };

  window.getLorebookSettings = function(bookName) {
    return _apiCall('getLorebookSettings', { bookName: String(bookName) });
  };

  window.setLorebookSettings = function(bookName, settings) {
    return _apiCall('setLorebookSettings', { bookName: String(bookName), settings: settings });
  };

  // Chat messages
  window.getChatMessages = function(messageId, options) {
    if (_chatMessages.length > 0) {
      return Promise.resolve(_getLocalChatMessages(messageId, options || {}));
    }
    return _apiCall('getChatMessages', { messageId: messageId, options: options || {} });
  };

  window.setChatMessage = function(fieldValues, messageId, options) {
    options = options || {};
    var payload = {};
    if (fieldValues && typeof fieldValues === 'object' && !Array.isArray(fieldValues)) {
      for (var key in fieldValues) payload[key] = fieldValues[key];
    } else if (fieldValues !== undefined) {
      payload.message = String(fieldValues);
    }
    if (messageId !== undefined) payload.messageId = messageId;
    if (payload.message_id !== undefined && payload.messageId === undefined) payload.messageId = payload.message_id;
    if (options.swipe_id !== undefined && payload.swipeId === undefined) payload.swipeId = options.swipe_id;
    if (payload.swipe_id !== undefined && payload.swipeId === undefined) payload.swipeId = payload.swipe_id;
    payload.options = options;
    return _apiCall('setChatMessage', payload);
  };

  window.setChatMessages = function(messages, options) {
    return _apiCall('setChatMessages', { messages: messages, options: options || {} });
  };

  // Variables
  window.getVariables = function(keys) {
    return _apiCall('getVariables', { keys: keys });
  };

  window.replaceVariables = function(data) {
    return _apiCall('replaceVariables', { data: data });
  };

  // Event functions
  window.eventEmit = eventEmit;
  window.eventOn = eventOn;
  window.eventOnce = eventOnce;
  window.eventMakeFirst = eventOn;
  window.eventMakeLast = eventOn;
  window.eventEmitAndWait = eventEmitAndWait;
  window.eventRemoveListener = eventRemoveListener;
  window.eventClearEvent = eventClearEvent;
  window.eventClearListener = eventClearListener;
  window.eventClearAll = eventClearAll;

  // Generation
  window.generate = function(options) {
    return _apiCall('generate', options || {});
  };

  window.stopGeneration = function() {
    return _apiCall('stopGeneration', {});
  };

  // Extension prompts
  window.setExtensionPrompt = function(promptId, content, position, depth, scan, role, filter) {
    return _apiCall('setExtensionPrompt', {
      promptId: promptId, content: content, position: position,
      depth: depth, scan: scan, role: role
    });
  };

  window.injectPrompts = function(prompts, options) {
    return _apiCall('injectPrompts', { prompts: prompts, options: options || {} });
  };

  window.uninjectPrompts = function(ids) {
    return _apiCall('uninjectPrompts', { ids: ids });
  };

  // Utility
  window.getLastMessageId = function() {
    if (_chatMessages.length > 0) return Promise.resolve(_lastMessageId());
    return _apiCall('getLastMessageId', {});
  };

  window.getCurrentMessageId = function() {
    return _currentMessageId();
  };

  window.substitudeMacros = function(text) {
    if (_chatMessages.length > 0) return Promise.resolve(_demacroText(text));
    return _apiCall('substitudeMacros', { text: text });
  };

  window.initializeGlobal = function(name) {
    return _apiCall('initializeGlobal', { name: name });
  };

  window.waitGlobalInitialized = function(name) {
    return _apiCall('waitGlobalInitialized', { name: name });
  };

  // ── TavernHelper (wrapped bind functions matching JS-Slash-Runner) ──
  window.TavernHelper = {
    triggerSlash: window.triggerSlash,
    triggerSlashWithResult: window.triggerSlash,
    getLorebookEntries: window.getLorebookEntries,
    setLorebookEntries: window.setLorebookEntries,
    getLorebookSettings: window.getLorebookSettings,
    setLorebookSettings: window.setLorebookSettings,
    getChatMessages: window.getChatMessages,
    setChatMessage: window.setChatMessage,
    setChatMessages: window.setChatMessages,
    generate: window.generate,
    stopGeneration: window.stopGeneration,
    setExtensionPrompt: window.setExtensionPrompt,
    injectPrompts: window.injectPrompts,
    uninjectPrompts: window.uninjectPrompts,
    getVariables: window.getVariables,
    replaceVariables: window.replaceVariables,
    getLastMessageId: window.getLastMessageId,
    getCurrentMessageId: window.getCurrentMessageId,
    substitudeMacros: window.substitudeMacros,
    initializeGlobal: window.initializeGlobal,
    waitGlobalInitialized: window.waitGlobalInitialized,
    eventOn: window.eventOn,
    eventOnce: window.eventOnce,
    eventMakeFirst: window.eventMakeFirst,
    eventMakeLast: window.eventMakeLast,
    eventEmit: window.eventEmit,
    eventEmitAndWait: window.eventEmitAndWait,
    eventRemoveListener: window.eventRemoveListener,
    eventClearEvent: window.eventClearEvent,
    eventClearListener: window.eventClearListener,
    eventClearAll: window.eventClearAll,
  };

  // ── Message handler: responses from host + variable updates ──
  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data) return;

    // API response
    if (data.type === 'th_api_response' && data.requestId) {
      var pending = _pendingRequests[data.requestId];
      if (pending) {
        delete _pendingRequests[data.requestId];
        if (data.error) {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(data.result);
        }
      }
      return;
    }

    // Variable updates from host
    if (data.type === 'variablesUpdated' && data.variables) {
      window.__xpVariables = data.variables;
      var els = document.querySelectorAll('[data-xp-var]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var key = el.getAttribute('data-xp-var');
        if (key && key in data.variables) {
          el.textContent = data.variables[key] != null ? String(data.variables[key]) : '';
        }
      }
      return;
    }

    if (data.type === 'runtimeUpdated') {
      _setRuntime(data.runtime || null, data.reason || 'runtimeUpdated');
      return;
    }

    // Direct event from host
    if (data.type === 'th_event') {
      var args = [data.eventType].concat(data.args || []);
      eventEmit.apply(null, args);
      return;
    }
  });

  // ── Existing bridge: height reporting, rendered notification ──
  function notifyRendered() {
    window.parent.postMessage({ type: 'rendered' }, '*');
  }

  function reportHeight() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    window.parent.postMessage({ type: 'sandbox-resize', height: h }, '*');
  }

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function() { reportHeight(); });
    ro.observe(document.documentElement);
    ro.observe(document.body);
  }

  // Expose bridge API on window for card scripts to use
  window.__xpBridge = {
    setVariables: function(changes) {
      window.parent.postMessage({ type: 'setVariables', changes: changes }, '*');
    },
    sendAction: function(action, payload) {
      window.parent.postMessage({ type: 'card-sandbox-action', action: action, payload: payload || {} }, '*');
    },
    getVariables: function() {
      return window.__xpVariables || {};
    },
  };

  // ── Cleanup stale floating UI DOM: when iframe is rebuilt (greeting switch),
  // the old iframe's JS context is dead but its parent-DOM-injected widgets remain.
  // Delete them via postMessage so the new iframe instance recreates them fresh.
  window.parent.postMessage({ type: 'cleanup-floating-ui' }, '*');

  _setRuntime(_runtime, 'initial');

  // Report initial height and notify rendered
  if (document.readyState === 'complete') {
    notifyRendered();
    reportHeight();
  } else {
    window.addEventListener('load', function() {
      notifyRendered();
      reportHeight();
    });
  }
})();
`.trim();
}
