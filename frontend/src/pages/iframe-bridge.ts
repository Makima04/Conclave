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
  }

  function eventOnce(eventType, callback) {
    var wrapper = function() {
      eventRemoveListener(eventType, wrapper);
      callback.apply(null, arguments);
    };
    _eventListeners[eventType] = _eventListeners[eventType] || [];
    _eventListeners[eventType].push(wrapper);
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

    return {
      get: get, set: set, has: has, clamp: clamp,
      omit: omit, pick: pick
    };
  })();

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
    return _apiCall('getChatMessages', { messageId: messageId, options: options || {} });
  };

  window.setChatMessage = function(message, messageId, options) {
    return _apiCall('setChatMessage', { message: message, messageId: messageId, options: options || {} });
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
  window.eventRemoveListener = eventRemoveListener;

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
    return _apiCall('getLastMessageId', {});
  };

  window.substitudeMacros = function(text) {
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
    substitudeMacros: window.substitudeMacros,
    initializeGlobal: window.initializeGlobal,
    waitGlobalInitialized: window.waitGlobalInitialized,
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
