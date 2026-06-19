// StRuntimeStore — single source of truth for character card runtime state.
//
// Ported from JS-Slash-Runner (JSR) function/variables.ts + function/chat_message.ts
// Reference: SillyTavern-release/public/scripts/extensions/third-party/JS-Slash-Runner/
//
// Responsibilities:
//   1. Load messages + variables from backend REST API, normalize to ST shapes
//   2. Synchronous read/write of in-memory state
//   3. Debounced persistence to backend REST
//   4. subscribe() for React useSyncExternalStore integration
//
// This is a pure TypeScript module — no React dependency.

import * as api from '../../api/client';
import type {
  Message,
  CharacterCard,
  SessionRuntimeAssets,
} from '../../api/types';
import type { RegexScript } from '../st-regex-executor';
import { getRegexScripts } from '../st-regex-scripts';
import { eventSource } from './events';

// ---------------------------------------------------------------------------
// Store-internal event name (for subscribe/unsubscribe)
// ---------------------------------------------------------------------------

const STORE_CHANGED = '__store_changed';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** ST-shaped chat message (compatible with JSR ChatMessage / ChatMessageSwiped) */
export interface StChatMessage {
  message_id: number;        // = backend turn_number
  name: string;              // character name
  role: 'user' | 'assistant' | 'system';
  is_hidden: boolean;        // backend has no this field; default false
  message: string;           // current active swipe text = backend content
  swipes: string[];          // all swipe texts; [content, ...variants] or greetings
  swipe_id: number;          // 0-based index into swipes
  /** Per-swipe variable snapshots.  Key = swipe index. */
  variables: Record<number, Record<string, any>>;
  /** Non-variable metadata from backend (stat_data, display_data, etc.) */
  data: Record<string, any>;
  extra?: Record<string, any>;
  /** Backend primary key — kept for API round-trips */
  _backendId?: string;
}

export type StVariableScope = 'chat' | 'message' | 'global' | 'character';

export interface StGetVariablesOpts {
  messageId?: number | 'latest';
}

export interface StSetVariablesOpts {
  messageId?: number | 'latest';
  merge?: boolean;
  insertOnly?: boolean;  // only insert new keys, don't overwrite existing
}

export interface StRuntimeStoreState {
  chat: StChatMessage[];
  chatVariables: Record<string, any>;   // scope: chat (maps to session_variables)
  regexScripts: RegexScript[];
  character: CharacterCard | null;
  userName: string;
  sessionId: string | null;
  _version: number;                     // monotonically increasing snapshot token
}

export interface StRuntimeStore extends StRuntimeStoreState {
  // --- Load ---
  load(sessionId: string, card?: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): Promise<void>;

  /** Lightweight load without API calls — for /lab dev page. */
  loadLocal(sessionId: string, card?: CharacterCard | null, runtimeAssets?: SessionRuntimeAssets | null): void;

  /** Re-fetch chat variables from backend (lighter than full load). */
  reloadChatVariables(): Promise<void>;

  // --- Synchronous reads ---
  getMessages(range?: string): StChatMessage[];
  getVariables(scope: StVariableScope, opts?: StGetVariablesOpts): Record<string, any>;
  getAllVariables(opts?: StGetVariablesOpts): Record<string, any>;

  // --- Synchronous writes (memory + emit + schedule flush) ---
  setVariables(scope: StVariableScope, data: Record<string, any>, opts?: StSetVariablesOpts): void;
  setChatMessage(fields: Partial<StChatMessage>, messageId?: number): void;
  /** Batch update multiple messages (JSR/TavernHelper setChatMessages). */
  setChatMessages(
    messages: Array<{ message_id?: number | string } & Partial<StChatMessage>>,
    options?: { refresh?: 'affected' | 'all' | null } & Record<string, unknown>,
  ): void;
  deleteVariable(scope: StVariableScope, key: string): void;
  replaceRegexScripts(scripts: RegexScript[]): void;

  // --- Lifecycle ---
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the backend variants JSON string into an array. */
function parseVariants(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** Parse the backend metadata JSON string. */
function parseMetadata(raw?: string): Record<string, any> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Convert backend Message → StChatMessage.
 *
 * Mapping:
 *   turn_number → message_id
 *   content     → message  (current active swipe text)
 *   variants    → swipes   ([content, ...variants])
 *   variant_index → swipe_id  (−1 → 0, else variant_index + 1)
 *   metadata.st_variables → variables[swipe_id]
 *   metadata.*            → data
 *   role        → role (passthrough, cast)
 */
function normalizeMessage(msg: Message, card: CharacterCard | null): StChatMessage {
  const backendVariants = parseVariants(msg.variants);
  const meta = parseMetadata(msg.metadata);
  const { st_variables: _sv, ...metaRest } = meta;

  // --- Build swipes ---
  let swipes: string[];
  if (msg.turn_number === 0 && card) {
    // Opening message: use card greetings
    const altGreetings = card.alternate_greetings ?? [];
    swipes = [card.first_mes, ...altGreetings];
  } else {
    // Regular message: content is the active variant text.
    // swipes = [content, ...remaining variants not matching content]
    // The backend keeps variants as the full array; content is always the
    // currently active variant's text. We rebuild swipes by prepending content
    // and then appending any variant strings not consumed by content.
    swipes = buildSwipes(msg.content, backendVariants);
  }

  // --- Derive swipe_id ---
  // variant_index: −1 = use content directly (swipe 0), 0+ = variants[idx]
  // swipe_id = variant_index + 1
  let swipe_id = msg.variant_index + 1;
  if (swipe_id < 0) swipe_id = 0;
  if (swipe_id >= swipes.length) swipe_id = Math.max(0, swipes.length - 1);

  // --- Active message text ---
  const activeMessage = swipes[swipe_id] ?? msg.content;

  // --- Variables per-swipe ---
  const variables: Record<number, Record<string, any>> = {};
  if (_sv && typeof _sv === 'object') {
    // st_variables may be a single object (legacy) or per-swipe map
    if (Array.isArray(_sv)) {
      _sv.forEach((v: any, i: number) => { if (v && typeof v === 'object') variables[i] = v; });
    } else {
      // Single object: apply to current swipe only
      variables[swipe_id] = _sv as Record<string, any>;
    }
  }

  const role = (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')
    ? msg.role as StChatMessage['role']
    : 'assistant';

  return {
    message_id: msg.turn_number,
    name: role === 'user' ? '' : (meta.character_name || ''),
    role,
    is_hidden: false,
    message: activeMessage,
    swipes,
    swipe_id,
    variables,
    data: metaRest,
    _backendId: msg.id,
  };
}

/**
 * Build the swipes array from content + backend variants.
 *
 * The backend stores `content` (the currently active text) and `variants` (a
 * JSON array of all variant texts). We need `swipes` where swipes[swipe_id]
 * === content.
 *
 * Strategy:
 *   - If variants is empty → [content]
 *   - If content matches variants[variant_index] → variants is the swipes array
 *   - Otherwise → [content, ...variants]
 *
 * This function does NOT know variant_index; the caller handles swipe_id
 * separately. We just need the full set of texts.
 */
function buildSwipes(content: string, variants: string[]): string[] {
  if (variants.length === 0) return [content];
  // If content is already one of the variants, variants IS the swipes array
  if (variants.includes(content)) return [...variants];
  // Otherwise prepend content
  return [content, ...variants];
}

/**
 * Parse ST range string into indices.
 *   "0"     → [0]
 *   "0-5"   → [0,1,2,3,4,5]
 *   "-1"    → [last]
 *   undefined → all
 */
function parseMessageRange(range: string | undefined, length: number): number[] | null {
  if (range === undefined || range === '') return null; // null = all
  const clamp = (v: number) => Math.max(0, Math.min(v, length - 1));
  const m = range.match(/^(-?\d+)-(-?\d+)$/);
  if (m) {
    let start = Number(m[1]);
    let end = Number(m[2]);
    if (start < 0) start = length + start;
    if (end < 0) end = length + end;
    [start, end] = [Math.min(start, end), Math.max(start, end)];
    start = clamp(start); end = clamp(end);
    const result: number[] = [];
    for (let i = start; i <= end; i++) result.push(i);
    return result;
  }
  const single = Number(range);
  if (!Number.isFinite(single)) return [];
  const idx = single < 0 ? length + single : single;
  return [clamp(idx)];
}

/**
 * Deep merge source into target, matching lodash mergeWith semantics for
 * arrays (arrays are replaced, not concatenated).
 * Mutates and returns target.
 */
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (Array.isArray(srcVal)) {
      target[key] = srcVal;
    } else if (srcVal && typeof srcVal === 'object' && tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
      deepMerge(tgtVal, srcVal);
    } else {
      target[key] = srcVal;
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const FLUSH_DEBOUNCE_MS = 1000;

export function createStRuntimeStore(): StRuntimeStore {
  // --- Internal state ---
  let _chat: StChatMessage[] = [];
  let _chatVariables: Record<string, any> = {};
  let _regexScripts: RegexScript[] = [];
  let _character: CharacterCard | null = null;
  let _userName = '';
  let _sessionId: string | null = null;
  let _localOnly = false;
  let _version = 0;
  let _disposed = false;


  // --- Dirty tracking for debounced flush ---
  let _chatVarsDirty = false;
  let _msgVarsDirty = new Set<number>(); // message_ids with dirty variables
  let _flushTimer: ReturnType<typeof setTimeout> | null = null;

  function bump() {
    _version++;
    eventSource.emitAndWait(STORE_CHANGED);
  }

  // --- Flush / persistence ---

  async function flush(): Promise<void> {
    const sid = _sessionId;
    if (!sid || _localOnly) return;

    const promises: Promise<any>[] = [];

    // Flush chat variables
    if (_chatVarsDirty) {
      _chatVarsDirty = false;
      promises.push(
        api.updateSessionVariables(sid, _chatVariables)
          .catch((err) => {
            console.error('[StRuntimeStore] chat variables flush failed, retrying:', err);
            return api.updateSessionVariables(sid, _chatVariables)
              .catch((retryErr) => {
                console.error('[StRuntimeStore] chat variables flush retry failed:', retryErr);
              });
          }),
      );
    }

    // Flush per-message variables
    for (const messageId of _msgVarsDirty) {
      const msg = _chat.find(m => m.message_id === messageId);
      if (!msg || !msg._backendId) continue;
      const backendId = msg._backendId;
      const stVars = msg.variables[msg.swipe_id];
      if (!stVars) continue;
      const fullMeta = { ...msg.data, st_variables: stVars };
      promises.push(
        api.updateMessageMetadata(sid, backendId, fullMeta)
          .catch((err) => {
            console.error(`[StRuntimeStore] message ${messageId} variables flush failed:`, err);
            return api.updateMessageMetadata(sid, backendId, fullMeta)
              .catch((retryErr) => {
                console.error(`[StRuntimeStore] message ${messageId} variables flush retry failed:`, retryErr);
              });
          }),
      );
    }
    _msgVarsDirty.clear();

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  function scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      void flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  // Apply a partial field update to a single in-memory message, persisting the
  // side effects to the backend. Shared by setChatMessage (single) and
  // setChatMessages (batch) so the two never drift. Does NOT bump() — callers
  // decide whether/how to notify subscribers.
  function applyMessageFields(msg: StChatMessage, fields: Partial<StChatMessage>) {
    if (!_sessionId) return;

    // swipe_id change (switch variant / apply opening)
    if (fields.swipe_id !== undefined && fields.swipe_id !== msg.swipe_id) {
      const newSwipeId = Math.max(0, Math.min(fields.swipe_id, msg.swipes.length - 1));
      msg.swipe_id = newSwipeId;
      msg.message = msg.swipes[newSwipeId] ?? msg.message;

      if (msg._backendId && _sessionId) {
        if (msg.message_id === 0) {
          // Opening message — use applyOpeningMessage
          void api.applyOpeningMessage(_sessionId, msg.message).catch(err => {
            console.error('[StRuntimeStore] applyOpeningMessage failed:', err);
          });
        } else {
          // Regular message — switch variant (backend variant_index = swipe_id - 1)
          const backendVariantIndex = newSwipeId - 1;
          void api.switchVariant(_sessionId, msg._backendId, backendVariantIndex).catch(err => {
            console.error('[StRuntimeStore] switchVariant failed:', err);
          });
        }
      }
    }

    // text change
    if (fields.message !== undefined && fields.message !== msg.message) {
      msg.message = fields.message;
      msg.swipes[msg.swipe_id] = fields.message;

      if (msg._backendId && _sessionId) {
        void api.editMessage(_sessionId, msg._backendId, fields.message).catch(err => {
          console.error('[StRuntimeStore] editMessage failed:', err);
        });
      }
    }

    if (fields.name !== undefined) msg.name = fields.name;
    if (fields.is_hidden !== undefined) msg.is_hidden = fields.is_hidden;
    if (fields.data !== undefined) msg.data = { ...fields.data };
  }

  // --- Public API ---

  const store: StRuntimeStore = {
    // --- State accessors (getter properties via defineProperty below) ---
    get chat() { return _chat; },
    get chatVariables() { return _chatVariables; },
    get regexScripts() { return _regexScripts; },
    get character() { return _character; },
    get userName() { return _userName; },
    get sessionId() { return _sessionId; },
    get _version() { return _version; },

    // -------------------------------------------------------------------
    // load
    // -------------------------------------------------------------------
    async load(sessionId, card, runtimeAssets) {
      // Revive a previously-disposed store. This store lives in a useRef, so
      // React StrictMode (dev) double-invokes effects: the unmount cleanup
      // disposes it, then the remount calls load() again on the SAME instance.
      // Without reviving, load() is a no-op (_disposed guard), _chat stays [],
      // and the card status-bar JS throws "无法加载状态数据" because the
      // iframe mounts before any message data exists. dispose() is only ever
      // the final teardown of this instance, so re-loading is always intended.
      _disposed = false;
      _sessionId = sessionId;
      _localOnly = false;

      const [messagesResult, varsResult] = await Promise.allSettled([
        api.listMessages(sessionId),
        api.readSessionVariables(sessionId, 'chat', []),
      ]);

      // Normalize messages
      const cardToUse = card ?? null;
      _character = cardToUse;
      if (messagesResult.status === 'fulfilled') {
        _chat = messagesResult.value.items.map(m => normalizeMessage(m, cardToUse));
      } else {
        console.error('[StRuntimeStore] failed to load messages:', messagesResult.reason);
        _chat = [];
      }

      // Chat variables
      if (varsResult.status === 'fulfilled') {
        _chatVariables = varsResult.value.values ?? {};
      } else {
        console.error('[StRuntimeStore] failed to load chat variables:', varsResult.reason);
        _chatVariables = {};
      }

      // Regex scripts
      _regexScripts = getRegexScripts(cardToUse, runtimeAssets ?? undefined);

      // Character name for user placeholder
      _userName = ''; // Will be set by caller if needed

      bump();
    },

    loadLocal(sessionId, card, runtimeAssets) {
      _disposed = false; // revive on re-load — see load()
      _sessionId = sessionId;
      _localOnly = true;
      _character = card ?? null;
      if (card) {
        const swipes = [card.first_mes, ...(card.alternate_greetings ?? [])].filter(
          message => typeof message === 'string' && message.trim().length > 0,
        );
        const opening = swipes[0] ?? '';
        _chat = [{
          message_id: 0,
          name: card.name,
          role: 'assistant',
          is_hidden: false,
          message: opening,
          swipes: swipes.length > 0 ? swipes : [opening],
          swipe_id: 0,
          variables: { 0: {} },
          data: {},
        }];
      } else {
        _chat = [];
      }
      _chatVariables = {};
      _regexScripts = getRegexScripts(card ?? null, runtimeAssets ?? undefined);
      _userName = '';
      bump();
    },

    // -------------------------------------------------------------------
    // reloadChatVariables — lightweight refresh of chat variables only
    // (used after opening swipe to pick up backend-persisted <UpdateVariable> changes)
    // -------------------------------------------------------------------
    async reloadChatVariables() {
      const sid = _sessionId;
      if (!sid || _disposed) return;
      try {
        const result = await api.readSessionVariables(sid, 'chat', []);
        _chatVariables = result.values ?? {};
        bump();
      } catch (err) {
        console.error('[StRuntimeStore] reloadChatVariables failed:', err);
      }
    },

    // -------------------------------------------------------------------
    // getMessages
    // -------------------------------------------------------------------
    getMessages(range) {
      const indices = parseMessageRange(range, _chat.length);
      if (indices === null) return [..._chat]; // all
      return indices.map(i => _chat[i]).filter(Boolean).map(m => ({ ...m }));
    },

    // -------------------------------------------------------------------
    // getVariables
    // -------------------------------------------------------------------
    getVariables(scope, opts) {
      switch (scope) {
        case 'chat':
          return structuredClone(_chatVariables);
        case 'message': {
          const msg = resolveMessage(opts?.messageId);
          if (!msg) return {};
          return structuredClone(msg.variables[msg.swipe_id] ?? {});
        }
        case 'global':
          // Global vars are not stored in this store; return empty.
          // Callers that need global vars should use the backend API directly.
          return {};
        case 'character':
          // Character-level vars are not stored in this store; return empty.
          return {};
        default:
          return {};
      }
    },

    // -------------------------------------------------------------------
    // getAllVariables
    // -------------------------------------------------------------------
    getAllVariables(opts) {
      // Merge order matches ST: global → character → chat → message
      return {
        ...structuredClone(_chatVariables),
        ...(() => {
          const msg = resolveMessage(opts?.messageId);
          return msg ? structuredClone(msg.variables[msg.swipe_id] ?? {}) : {};
        })(),
      };
    },

    // -------------------------------------------------------------------
    // setVariables
    // -------------------------------------------------------------------
    setVariables(scope, data, opts) {
      const insertOnly = opts?.insertOnly ?? false;
      switch (scope) {
        case 'chat': {
          if (insertOnly) {
            for (const [k, v] of Object.entries(data)) {
              if (!(k in _chatVariables)) _chatVariables[k] = structuredClone(v);
            }
          } else if (opts?.merge) {
            deepMerge(_chatVariables, data);
          } else {
            _chatVariables = structuredClone(data);
          }
          _chatVarsDirty = true;
          bump();
          scheduleFlush();
          break;
        }
        case 'message': {
          const msg = resolveMessage(opts?.messageId);
          if (!msg) return;
          if (opts?.merge) {
            const current = msg.variables[msg.swipe_id] ?? {};
            deepMerge(current, data);
            msg.variables[msg.swipe_id] = current;
          } else {
            msg.variables[msg.swipe_id] = structuredClone(data);
          }
          _msgVarsDirty.add(msg.message_id);
          bump();
          scheduleFlush();
          break;
        }
        case 'global':
        case 'character':
          // These scopes are not persisted through this store.
          console.warn(`[StRuntimeStore] setVariables('${scope}') is not supported — use backend API directly`);
          break;
      }
    },

    // -------------------------------------------------------------------
    // setChatMessage
    // -------------------------------------------------------------------
    setChatMessage(fields, messageId) {
      if (_disposed || !_sessionId) return;

      const targetId = fields.message_id ?? messageId;
      if (targetId == null) return;

      const msg = _chat.find(m => m.message_id === targetId);
      if (!msg) return;

      applyMessageFields(msg, fields);
      bump();
    },

    // -------------------------------------------------------------------
    // setChatMessages — batch update (JSR/TavernHelper setChatMessages).
    // Applies each partial update to its message_id, then notifies once.
    // MVU and card UIs use this to mutate several messages at once (e.g.
    // appending a status placeholder, switching openings).
    // -------------------------------------------------------------------
    setChatMessages(messages, _options) {
      if (_disposed || !_sessionId) return;

      let changed = false;
      for (const fields of Array.isArray(messages) ? messages : []) {
        if (!fields || typeof fields !== 'object') continue;

        // message_id may arrive as string (JSON) or number; normalize.
        const rawId = (fields as { message_id?: number | string }).message_id;
        const numericId = typeof rawId === 'string' ? Number(rawId) : rawId;
        if (numericId == null || !Number.isFinite(numericId as number)) continue;

        const msg = _chat.find(m => m.message_id === (numericId as number));
        if (!msg) continue;

        applyMessageFields(msg, fields);
        changed = true;
      }

      if (changed) bump();
    },

    // -------------------------------------------------------------------
    // deleteVariable
    // -------------------------------------------------------------------
    deleteVariable(scope: StVariableScope, key: string) {
      if (scope === 'chat') {
        delete _chatVariables[key];
        _chatVarsDirty = true;
        bump();
        scheduleFlush();
      } else {
        console.warn(`[StRuntimeStore] deleteVariable('${scope}') is not supported`);
      }
    },

    // -------------------------------------------------------------------
    // replaceRegexScripts
    // -------------------------------------------------------------------
    replaceRegexScripts(scripts: RegexScript[]) {
      _regexScripts = scripts;
      bump();
    },

    // -------------------------------------------------------------------
    // subscribe
    // -------------------------------------------------------------------
    subscribe(listener) {
      return eventSource.on(STORE_CHANGED, listener).stop;
    },

    // -------------------------------------------------------------------
    // dispose
    // -------------------------------------------------------------------
    dispose() {
      _disposed = true;
      if (_flushTimer) {
        clearTimeout(_flushTimer);
        _flushTimer = null;
      }
      // Synchronous flush of remaining dirty state
      if (_chatVarsDirty || _msgVarsDirty.size > 0) {
        void flush();
      }
    },
  };

  // --- Internal helper ---
  function resolveMessage(ref: number | 'latest' | undefined): StChatMessage | undefined {
    if (ref === undefined || ref === 'latest') return _chat[_chat.length - 1];
    return _chat.find(m => m.message_id === ref);
  }

  return store;
}
