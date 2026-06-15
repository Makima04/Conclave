// installStGlobals — host-side global installation for ST-compatible runtime
//
// Installs window._ / $ / YAML / showdown / toastr / z / TavernHelper / SillyTavern
// so that card JS running in same-origin iframes can access them directly via window.parent.
//
// Ported from JSR predefine.js merge logic:
//   SillyTavern-release/public/scripts/extensions/third-party/JS-Slash-Runner/src/iframe/predefine.js

import _ from 'lodash';
import $ from 'jquery';
import * as YAML from 'yaml';
import showdown from 'showdown';
import { getTavernHelper, type TavernHelperObject } from './tavern-helper';
import { eventSource } from './events';
import type { StRuntimeStore } from './store';

// ── toastr facade (temporary — console-backed) ──
// In M2+ this will be wired to the existing Toast React component via a bridge.
const toastrFacade = {
  success: (msg: string, title?: string) => console.info(`[toastr:success] ${title ? title + ': ' : ''}${msg}`),
  info:    (msg: string, title?: string) => console.info(`[toastr:info] ${title ? title + ': ' : ''}${msg}`),
  warning: (msg: string, title?: string) => console.warn(`[toastr:warning] ${title ? title + ': ' : ''}${msg}`),
  error:   (msg: string, title?: string) => console.error(`[toastr:error] ${title ? title + ': ' : ''}${msg}`),
};

declare global {
  interface Window {
    _: typeof _;
    $: typeof $;
    jQuery: typeof $;
    YAML: typeof YAML;
    showdown: typeof showdown;
    toastr: typeof toastrFacade;
    TavernHelper: TavernHelperObject;
    SillyTavern: Record<string, any> & {
      getContext: () => Record<string, unknown>;
    };
    z?: unknown;
    Mvu?: unknown;
    getAllVariables?: () => Record<string, any>;
    getCurrentMessageId?: () => number;
  }
}

/**
 * Install ST-compatible globals on window.
 * Call once when entering a card-enabled session.
 * Returns the TavernHelper object for direct use.
 */
export function installStGlobals(store: StRuntimeStore): TavernHelperObject {
  // lodash — predefine.js line 1: `window._ = window.parent._`
  window._ = _;

  // jQuery — needed by card scripts that manipulate parent DOM (floating UI)
  window.$ = $;
  window.jQuery = $;

  // YAML — predefine.js merge list
  window.YAML = YAML;

  // showdown — markdown converter, used by card scripts
  window.showdown = showdown;

  // toastr — notification facade
  (window as any).toastr = toastrFacade;

  // z (zod) — loaded via CDN in createScriptSrcContent (iframe-doc.ts) as window.Zod,
  // bridged to window.z by an inline shim. We do NOT override it here so that
  // iframes that load their own Zod (via CDN) get their own copy.

  // TavernHelper — the full API object
  const tavernHelper = getTavernHelper(store);
  window.TavernHelper = tavernHelper;

  const extensionSettings = ((window as any).__ST_EXTENSION_SETTINGS ??= {});
  const macros = ((window as any).__ST_MACROS ??= new Map<string, () => string>());
  const popupType = {
    TEXT: 'text',
    INPUT: 'input',
    CONFIRM: 'confirm',
  };
  const popupResult = {
    AFFIRMATIVE: 1,
    NEGATIVE: 0,
    CANCELLED: null,
    CUSTOM1: 2,
  };
  const saveChat = async () => {};
  const saveSettingsDebounced = () => {};
  const getCurrentChatId = () => store.sessionId ?? 'conclave-local';
  const getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
  const callGenericPopup = async (_content: string, type?: string, defaultValue?: string) => {
    if (type === popupType.INPUT) return defaultValue ?? '';
    if (type === popupType.CONFIRM) return popupResult.NEGATIVE;
    return undefined;
  };
  const registerMacro = (name: string, fn: () => string) => { macros.set(name, fn); };
  const unregisterMacro = (name: string) => { macros.delete(name); };
  const toolManager = {
    isToolCallingSupported: () => false,
    registerFunctionTool: () => {},
    unregisterFunctionTool: () => {},
  };
  const getContext = () => ({
      chat: store.chat,
      name1: store.userName,
      name2: store.character?.name || '',
      chat_metadata: { variables: store.chatVariables },
      eventSource,
      characters: store.character ? [store.character] : [],
      characterId: 0,
      extensionSettings,
      POPUP_TYPE: popupType,
      POPUP_RESULT: popupResult,
      ToolManager: toolManager,
      SendingMessage: {},
      saveChat,
      saveSettingsDebounced,
      getCurrentChatId,
      getRequestHeaders,
      callGenericPopup,
      registerMacro,
      unregisterMacro,
      getChatCompletionModel: () => '',
      registerFunctionTool: toolManager.registerFunctionTool,
      unregisterFunctionTool: toolManager.unregisterFunctionTool,
      // Fields will be added incrementally as fixtures require them
    });

  // SillyTavern — context proxy (predefine.js expands SillyTavern.getContext()).
  const sillyTavern: Record<string, any> & { getContext: () => Record<string, unknown> } = {
    ...getContext(),
    getContext,
  };
  Object.defineProperties(sillyTavern, {
    chat: { get: () => store.chat, configurable: true },
    name2: { get: () => store.character?.name || '', configurable: true },
    characters: { get: () => (store.character ? [store.character] : []), configurable: true },
  });
  window.SillyTavern = sillyTavern;

  // Expose key helpers on window for card scripts (statusbar bridgeGlobals needs these)
  (window as any).getAllVariables = tavernHelper._bind._getAllVariables.bind(window);
  (window as any).getCurrentMessageId = () => {
    const chat = store.chat;
    return chat.length > 0 ? chat[chat.length - 1].message_id : 0;
  };

  return tavernHelper;
}

/**
 * Uninstall ST globals (for cleanup on session exit).
 */
export function uninstallStGlobals(): void {
  delete (window as any).TavernHelper;
  delete (window as any).SillyTavern;
  delete (window as any).getAllVariables;
  delete (window as any).getCurrentMessageId;
  // Note: _, $, YAML, showdown stay — they're shared libs, not session-scoped
}
