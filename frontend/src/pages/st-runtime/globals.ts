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
    SillyTavern: {
      getContext: () => Record<string, unknown>;
    };
    z?: unknown;
    Mvu?: unknown;
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

  // z (zod) — loaded separately via zod-v3-umd.js <script> tag in card-content.tsx headBridge.
  // window.z is expected to already exist from that script. We do NOT override it here.

  // TavernHelper — the full API object
  const tavernHelper = getTavernHelper(store);
  window.TavernHelper = tavernHelper;

  // SillyTavern — context proxy (predefine.js: Object.defineProperty get: SillyTavern.getContext())
  window.SillyTavern = {
    getContext: () => ({
      chat: store.chat,
      name1: store.userName,
      name2: store.character?.name || '',
      chat_metadata: { variables: store.chatVariables },
      eventSource,
      characters: store.character ? [store.character] : [],
      // Fields will be added incrementally as fixtures require them
    }),
  };

  return tavernHelper;
}

/**
 * Uninstall ST globals (for cleanup on session exit).
 */
export function uninstallStGlobals(): void {
  delete (window as any).TavernHelper;
  delete (window as any).SillyTavern;
  // Note: _, $, YAML, showdown stay — they're shared libs, not session-scoped
}
