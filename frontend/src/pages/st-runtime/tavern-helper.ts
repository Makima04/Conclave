// TavernHelper — ST + JS-Slash-Runner compatible API object
//
// Ported from JS-Slash-Runner:
//   SillyTavern-release/public/scripts/extensions/third-party/JS-Slash-Runner/src/function/index.ts
//
// Two categories of members:
//   - Normal: directly on the TavernHelper object, no iframe identity needed
//   - _bind: in the `_bind` map, require `this` (iframe window) to resolve identity
//
// In the real JSR, predefine.js merges normal members into the iframe window global,
// and `.bind(window)`-s each _bind member and injects it under the stripped name
// (e.g. `_eventOn` → `eventOn`).
//
// In v4 same-origin architecture, the host page installs TavernHelper on window,
// and predefine.js (inside the iframe) does:
//   _.omit(TavernHelper, '_bind') → merge into iframe window
//   _.entries(TavernHelper._bind).forEach(([k,v]) => window[k.replace('_','')] = v.bind(window))

import type { StRuntimeStore } from './store';
import { eventSource, tavern_events, iframe_events } from './events';
import type { RegexScript } from '../st-regex-executor';

// ── iframe identity helpers (ported from JSR function/util.ts) ──

function _getIframeName(this: Window): string {
  const frameElement = this.frameElement as Element | null;
  const cachedId = (this as any).__TH_IFRAME_ID || this.name;
  if (frameElement?.id) {
    (this as any).__TH_IFRAME_ID = frameElement.id;
    if (!this.name) this.name = frameElement.id;
    return frameElement.id;
  }
  if (cachedId) {
    if (!this.name) this.name = cachedId;
    return cachedId;
  }
  throw new TypeError('frameElement is null while resolving iframe id');
}

function getMessageId(iframeName: string): number {
  const match = iframeName.match(/^TH-message--(\d+)--\d+(_\d+)?$/);
  if (!match) {
    throw Error(`获取 ${iframeName} 所在楼层 id 时出错: 不要对全局脚本 iframe 调用 getMessageId!`);
  }
  return parseInt(match[1].toString());
}

function _getCurrentMessageId(this: Window): number {
  return getMessageId(_getIframeName.call(this));
}

function _getScriptId(this: Window): string {
  const iframeName = _getIframeName.call(this);
  if (!iframeName.startsWith('TH-script--')) {
    throw new Error('你只能在脚本 iframe 内获取 getScriptId!');
  }
  return iframeName.replace(/TH-script--.+--/, '');
}

function _reloadIframe(this: Window): void {
  this.location.reload();
}

function substitudeMacros(text: string): string {
  // Simple {{user}} / {{char}} substitution (full macro engine in macro-engine.ts)
  return text;
}

function getLastMessageId(store: StRuntimeStore): number {
  const chat = store.chat;
  return chat.length > 0 ? chat[chat.length - 1].message_id : -1;
}

function errorCatched<T extends any[], U>(fn: (...args: T) => U): (...args: T) => U {
  const onError = (error: Error) => {
    console.error('[TavernHelper]', error);
    throw error;
  };
  return (...args: T): U => {
    try {
      const result = fn(...args);
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(undefined, (error: Error) => onError(error));
      }
      return result;
    } catch (error) {
      return onError(error as Error);
    }
  };
}

function _errorCatched<T extends any[], U>(this: Window, fn: (...args: T) => U): (...args: T) => U {
  const iframeName = (() => { try { return _getIframeName.call(this); } catch { return 'unknown'; } })();
  const onError = (error: Error) => {
    console.error(`[TavernHelper:${iframeName}]`, error);
    throw error;
  };
  return (...args: T): U => {
    try {
      const result = fn(...args);
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(undefined, (error: Error) => onError(error));
      }
      return result;
    } catch (error) {
      return onError(error as Error);
    }
  };
}

// ── Stub helper ──

function stub(name: string): () => never {
  return () => {
    const msg = `[TavernHelper] ${name} 尚未实现（stub）。此 API 将在后续里程碑按需实现。`;
    console.warn(msg);
    throw new Error(msg);
  };
}

// ── Main factory ──

export function getTavernHelper(store: StRuntimeStore) {
  return {
    // ── _th_impl: internal logging bridge ──
    _th_impl: {
      _init: () => {},
      _log: (...args: any[]) => console.log('[TH]', ...args),
      _clearLog: () => {},
      writeExtensionField: stub('writeExtensionField'),
    },

    // ── _bind: members that need `this` (iframe window) ──
    _bind: {
      _eventOn: function (this: Window, type: string, listener: (...args: any[]) => void) {
        return eventSource.on(type, listener);
      },
      _eventOnce: function (this: Window, type: string, listener: (...args: any[]) => void) {
        return eventSource.once(type, listener);
      },
      _eventMakeFirst: function (this: Window, type: string, listener: (...args: any[]) => void) {
        return eventSource.makeFirst(type, listener);
      },
      _eventMakeLast: function (this: Window, type: string, listener: (...args: any[]) => void) {
        return eventSource.makeLast(type, listener);
      },
      _eventEmit: function (this: Window, type: string, ...args: any[]) {
        return eventSource.emit(type, ...args);
      },
      _eventEmitAndWait: function (this: Window, type: string, ...args: any[]) {
        eventSource.emitAndWait(type, ...args);
      },
      _eventRemoveListener: function (this: Window, type: string, listener: (...args: any[]) => void) {
        eventSource.removeListener(type, listener);
      },
      _eventClearEvent: function (this: Window, type: string) {
        eventSource.clearEvent(type);
      },
      _eventClearListener: function (this: Window, listener: (...args: any[]) => void) {
        eventSource.clearListener(listener);
      },
      _eventClearAll: function (this: Window) {
        eventSource.clearAll();
      },

      // variables (identity-aware: script scope needs iframe id)
      _getVariables: function (this: Window, opts?: any) {
        if (opts?.type === 'script') {
          return store.getVariables('chat'); // script scope not yet supported
        }
        return store.getVariables(opts?.type || 'chat', opts);
      },
      _getAllVariables: function (this: Window) {
        let iframeName: string | undefined;
        try { iframeName = _getIframeName.call(this); } catch {}
        const isMessageIframe = iframeName?.startsWith('TH-message');
        return store.getAllVariables({ messageId: isMessageIframe ? _getCurrentMessageId.call(this) : undefined });
      },
      _replaceVariables: function (this: Window, data: Record<string, any>) {
        store.setVariables('chat', data);
      },
      _insertOrAssignVariables: function (this: Window, data: Record<string, any>) {
        store.setVariables('chat', data, { merge: true });
      },
      _insertVariables: function (this: Window, data: Record<string, any>) {
        store.setVariables('chat', data, { merge: true, insertOnly: true });
      },
      _deleteVariable: function (this: Window, key: string) {
        store.deleteVariable('chat', key);
      },

      // identity helpers
      _getIframeName,
      _getScriptId,
      _getCurrentMessageId,
      _reloadIframe,
      _errorCatched,
    },

    // ── Normal members (no iframe identity needed) ──

    // -- audio (stub) --
    playAudio: stub('playAudio'),
    pauseAudio: stub('pauseAudio'),
    getAudioList: stub('getAudioList'),
    replaceAudioList: stub('replaceAudioList'),
    appendAudioList: stub('appendAudioList'),
    getAudioSettings: stub('getAudioSettings'),
    setAudioSettings: stub('setAudioSettings'),
    getCurrentAudio: stub('getCurrentAudio'),

    // -- character (partial) --
    getCharacterNames: () => store.character ? [store.character.name] : [],
    getCurrentCharacterName: () => store.character?.name || '',
    getCharacter: () => store.character,
    getCharData: () => store.character,
    getCharAvatarPath: () => '', // no avatar path in v4 yet
    createCharacter: stub('createCharacter'),
    createOrReplaceCharacter: stub('createOrReplaceCharacter'),
    deleteCharacter: stub('deleteCharacter'),
    replaceCharacter: stub('replaceCharacter'),
    updateCharacterWith: stub('updateCharacterWith'),

    // -- chat_message --
    getChatMessages: (range?: string | number, opts?: any) => {
      return store.getMessages(range != null ? String(range) : undefined);
    },
    setChatMessage: (fields: any, messageId?: number) => {
      return store.setChatMessage(fields, messageId);
    },
    setChatMessages: stub('setChatMessages'),
    createChatMessages: stub('createChatMessages'),
    deleteChatMessages: stub('deleteChatMessages'),
    rotateChatMessages: stub('rotateChatMessages'),

    // -- displayed_message --
    formatAsDisplayedMessage: stub('formatAsDisplayedMessage'),
    retrieveDisplayedMessage: stub('retrieveDisplayedMessage'),
    refreshOneMessage: stub('refreshOneMessage'),

    // -- event --
    tavern_events,
    iframe_events,

    // -- generate (stub — will wire to useMessageStream SSE in M2) --
    generate: stub('generate'),
    generateRaw: stub('generateRaw'),
    stopAllGeneration: stub('stopAllGeneration'),
    stopGenerationById: stub('stopGenerationById'),
    getModelList: stub('getModelList'),
    getProxyPresetNames: stub('getProxyPresetNames'),

    // -- global --
    initializeGlobal: stub('initializeGlobal'),
    waitGlobalInitialized: stub('waitGlobalInitialized'),

    // -- import_raw (stub) --
    importRawCharacter: stub('importRawCharacter'),
    importRawChat: stub('importRawChat'),
    importRawPreset: stub('importRawPreset'),
    importRawWorldbook: stub('importRawWorldbook'),
    importRawTavernRegex: stub('importRawTavernRegex'),

    // -- inject (stub) --
    injectPrompts: stub('injectPrompts'),
    uninjectPrompts: stub('uninjectPrompts'),

    // -- lorebook (stub — maps to worldbooks REST in M2) --
    getLorebooks: stub('getLorebooks'),
    getChatLorebook: stub('getChatLorebook'),
    getCharLorebooks: stub('getCharLorebooks'),
    getOrCreateChatLorebook: stub('getOrCreateChatLorebook'),
    getLorebookEntries: stub('getLorebookEntries'),
    setLorebookEntries: stub('setLorebookEntries'),
    getLorebookSettings: stub('getLorebookSettings'),
    setLorebookSettings: stub('setLorebookSettings'),

    // -- macro_like (stub) --
    registerMacroLike: stub('registerMacroLike'),
    unregisterMacroLike: stub('unregisterMacroLike'),

    // -- preset (stub) --
    getPresetNames: stub('getPresetNames'),
    getLoadedPresetName: stub('getLoadedPresetName'),
    loadPreset: stub('loadPreset'),
    createPreset: stub('createPreset'),
    createOrReplacePreset: stub('createOrReplacePreset'),
    deletePreset: stub('deletePreset'),
    renamePreset: stub('renamePreset'),
    getPreset: stub('getPreset'),
    replacePreset: stub('replacePreset'),
    updatePresetWith: stub('updatePresetWith'),
    setPreset: stub('setPreset'),

    // -- script (stub) --
    getAllEnabledScriptButtons: stub('getAllEnabledScriptButtons'),
    getScriptTrees: stub('getScriptTrees'),
    replaceScriptTrees: stub('replaceScriptTrees'),
    updateScriptTreesWith: stub('updateScriptTreesWith'),

    // -- slash --
    triggerSlash: stub('triggerSlash'),
    triggerSlashWithResult: stub('triggerSlashWithResult'),

    // -- tavern_regex --
    getTavernRegexes: () => store.regexScripts,
    replaceTavernRegexes: (scripts: RegexScript[]) => { store.replaceRegexScripts(scripts); },
    updateTavernRegexesWith: stub('updateTavernRegexesWith'),
    formatAsTavernRegexedString: stub('formatAsTavernRegexedString'),
    isCharacterTavernRegexesEnabled: () => true,

    // -- util --
    substitudeMacros,
    getLastMessageId: () => getLastMessageId(store),
    errorCatched,
    getMessageId,

    // -- variables --
    getVariables: (opts?: any) => store.getVariables(opts?.type || 'chat', opts),
    replaceVariables: (data: Record<string, any>) => store.setVariables('chat', data),
    updateVariablesWith: (data: Record<string, any>) => store.setVariables('chat', data, { merge: true }),
    insertOrAssignVariables: (data: Record<string, any>) => store.setVariables('chat', data, { merge: true }),
    insertVariables: (data: Record<string, any>) => store.setVariables('chat', data, { merge: true, insertOnly: true }),
    deleteVariable: (key: string) => store.deleteVariable('chat', key),
    registerVariableSchema: stub('registerVariableSchema'),

    // -- version (stub) --
    getTavernHelperVersion: () => '0.0.1-conclave',
    getFrontendVersion: () => '0.0.1-conclave',
    getTavernVersion: stub('getTavernVersion'),
    updateTavernHelper: stub('updateTavernHelper'),

    // -- worldbook (stub — maps to worldbooks REST in M2) --
    getWorldbookNames: stub('getWorldbookNames'),
    getGlobalWorldbookNames: stub('getGlobalWorldbookNames'),
    rebindGlobalWorldbooks: stub('rebindGlobalWorldbooks'),
    getCharWorldbookNames: stub('getCharWorldbookNames'),
    rebindCharWorldbooks: stub('rebindCharWorldbooks'),
    getChatWorldbookName: stub('getChatWorldbookName'),
    rebindChatWorldbook: stub('rebindChatWorldbook'),
    getOrCreateChatWorldbook: stub('getOrCreateChatWorldbook'),
    createWorldbook: stub('createWorldbook'),
    createOrReplaceWorldbook: stub('createOrReplaceWorldbook'),
    deleteWorldbook: stub('deleteWorldbook'),
    getWorldbook: stub('getWorldbook'),
    replaceWorldbook: stub('replaceWorldbook'),
    updateWorldbookWith: stub('updateWorldbookWith'),
    createWorldbookEntries: stub('createWorldbookEntries'),
    deleteWorldbookEntries: stub('deleteWorldbookEntries'),

    // -- extension (stub) --
    isAdmin: () => true,
    getTavernHelperExtensionId: () => 'conclave',
    getExtensionType: stub('getExtensionType'),
    getExtensionStatus: stub('getExtensionStatus'),
    isInstalledExtension: stub('isInstalledExtension'),
    installExtension: stub('installExtension'),
    uninstallExtension: stub('uninstallExtension'),
    reinstallExtension: stub('reinstallExtension'),
    updateExtension: stub('updateExtension'),
  };
}

export type TavernHelperObject = ReturnType<typeof getTavernHelper>;
