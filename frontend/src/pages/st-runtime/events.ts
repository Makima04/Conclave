/**
 * SillyTavern-compatible event system for the card rendering runtime.
 *
 * Ported from JS-Slash-Runner (JSR):
 *   SillyTavern-release/public/scripts/extensions/third-party/JS-Slash-Runner/src/function/event.ts
 *
 * Provides:
 *  - eventSource: a singleton EventEmitter with ST-compatible API
 *    (on / once / emit / emitAndWait / makeFirst / makeLast / removeListener / clearEvent / clearListener / clearAll)
 *  - tavern_events: all ~60 SillyTavern event name constants
 *  - iframe_events: iframe-specific event name constants
 *  - Full TypeScript listener type map (ListenerType)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Returned by `on` / `once` / `makeFirst` / `makeLast`. Call `stop()` to unsubscribe. */
export interface EventSubscription {
  stop: () => void;
}

export type EventType = IframeEventType | TavernEventType | string;

export type IframeEventType = (typeof iframe_events)[keyof typeof iframe_events];

export type TavernEventType = (typeof tavern_events)[keyof typeof tavern_events];

/** Shape of the message payload used in prompt-related events. */
export type SendingMessage = {
  role: 'user' | 'assistant' | 'system';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail: 'auto' | 'low' | 'high' } }
        | { type: 'video_url'; video_url: { url: string } }
      >;
};

/**
 * Maps every known event string to the expected listener signature.
 * The index signature `[custom_event: string]` allows arbitrary user-defined events.
 */
export type ListenerType = {
  // -- iframe events --
  [iframe_events.MESSAGE_IFRAME_RENDER_STARTED]: (iframe_name: string) => void;
  [iframe_events.MESSAGE_IFRAME_RENDER_ENDED]: (iframe_name: string) => void;
  [iframe_events.GENERATION_STARTED]: (generation_id: string) => void;
  [iframe_events.STREAM_TOKEN_RECEIVED_FULLY]: (full_text: string, generation_id: string) => void;
  [iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY]: (incremental_text: string, generation_id: string) => void;
  [iframe_events.GENERATION_ENDED]: (text: string, generation_id: string) => void;

  // -- tavern events --
  [tavern_events.APP_READY]: () => void;
  [tavern_events.EXTRAS_CONNECTED]: (modules: any) => void;
  [tavern_events.MESSAGE_SWIPED]: (message_id: number) => void;
  [tavern_events.MESSAGE_SENT]: (message_id: number) => void;
  [tavern_events.MESSAGE_RECEIVED]: (
    message_id: number,
    type:
      | 'normal'
      | 'quiet'
      | 'regenerate'
      | 'impersonate'
      | 'continue'
      | 'swipe'
      | 'append'
      | 'appendFinal'
      | 'first_message'
      | 'command'
      | 'extension'
      | string,
  ) => void;
  [tavern_events.MESSAGE_EDITED]: (message_id: number) => void;
  [tavern_events.MESSAGE_DELETED]: (message_id: number) => void;
  [tavern_events.MESSAGE_UPDATED]: (message_id: number) => void;
  [tavern_events.MESSAGE_FILE_EMBEDDED]: (message_id: number) => void;
  [tavern_events.MESSAGE_REASONING_EDITED]: (message_id: number) => void;
  [tavern_events.MESSAGE_REASONING_DELETED]: (message_id: number) => void;
  [tavern_events.MESSAGE_SWIPE_DELETED]: (event_data: {
    messageId: number;
    swipeId: number;
    newSwipeId: number;
  }) => void;
  [tavern_events.MORE_MESSAGES_LOADED]: () => void;
  [tavern_events.IMPERSONATE_READY]: (message: string) => void;
  [tavern_events.CHAT_CHANGED]: (chat_file_name: string) => void;
  [tavern_events.GENERATION_AFTER_COMMANDS]: (
    type: string,
    option: {
      automatic_trigger?: boolean;
      force_name2?: boolean;
      quiet_prompt?: string;
      quietToLoud?: boolean;
      skipWIAN?: boolean;
      force_chid?: number;
      signal?: AbortSignal;
      quietImage?: string;
      quietName?: string;
      depth?: number;
    },
    dry_run: boolean,
  ) => void;
  [tavern_events.GENERATION_STARTED]: (
    type: string,
    option: {
      automatic_trigger?: boolean;
      force_name2?: boolean;
      quiet_prompt?: string;
      quietToLoud?: boolean;
      skipWIAN?: boolean;
      force_chid?: number;
      signal?: AbortSignal;
      quietImage?: string;
      quietName?: string;
      depth?: number;
    },
    dry_run: boolean,
  ) => void;
  [tavern_events.GENERATION_STOPPED]: () => void;
  [tavern_events.GENERATION_ENDED]: (message_id: number) => void;
  [tavern_events.SD_PROMPT_PROCESSING]: (event_data: {
    prompt: string;
    generationType: number;
    message: string;
    trigger: string;
  }) => void;
  [tavern_events.EXTENSIONS_FIRST_LOAD]: () => void;
  [tavern_events.EXTENSION_SETTINGS_LOADED]: () => void;
  [tavern_events.SETTINGS_LOADED]: () => void;
  [tavern_events.SETTINGS_UPDATED]: () => void;
  [tavern_events.MOVABLE_PANELS_RESET]: () => void;
  [tavern_events.SETTINGS_LOADED_BEFORE]: (settings: object) => void;
  [tavern_events.SETTINGS_LOADED_AFTER]: (settings: object) => void;
  [tavern_events.CHATCOMPLETION_SOURCE_CHANGED]: (source: string) => void;
  [tavern_events.CHATCOMPLETION_MODEL_CHANGED]: (model: string) => void;
  [tavern_events.OAI_PRESET_CHANGED_BEFORE]: (result: {
    preset: object;
    presetName: string;
    settingsToUpdate: object;
    settings: object;
    savePreset: Function;
  }) => void;
  [tavern_events.OAI_PRESET_CHANGED_AFTER]: () => void;
  [tavern_events.OAI_PRESET_EXPORT_READY]: (preset: object) => void;
  [tavern_events.OAI_PRESET_IMPORT_READY]: (result: { data: object; presetName: string }) => void;
  [tavern_events.WORLDINFO_SETTINGS_UPDATED]: () => void;
  [tavern_events.WORLDINFO_UPDATED]: (name: string, data: { entries: object[] }) => void;
  [tavern_events.CHARACTER_EDITOR_OPENED]: (chid: string) => void;
  [tavern_events.CHARACTER_EDITED]: (result: { detail: { id: string; character: object } }) => void;
  [tavern_events.CHARACTER_PAGE_LOADED]: () => void;
  [tavern_events.USER_MESSAGE_RENDERED]: (message_id: number) => void;
  [tavern_events.CHARACTER_MESSAGE_RENDERED]: (message_id: number, type: string) => void;
  [tavern_events.FORCE_SET_BACKGROUND]: (background: { url: string; path: string }) => void;
  [tavern_events.CHAT_DELETED]: (chat_file_name: string) => void;
  [tavern_events.CHAT_CREATED]: () => void;
  [tavern_events.GENERATE_BEFORE_COMBINE_PROMPTS]: () => void;
  [tavern_events.GENERATE_AFTER_COMBINE_PROMPTS]: (result: { prompt: string; dryRun: boolean }) => void;
  [tavern_events.GENERATE_AFTER_DATA]: (
    generate_data: { prompt: SendingMessage[] },
    dry_run: boolean,
  ) => void;
  [tavern_events.WORLD_INFO_ACTIVATED]: (entries: any[]) => void;
  [tavern_events.TEXT_COMPLETION_SETTINGS_READY]: () => void;
  [tavern_events.CHAT_COMPLETION_SETTINGS_READY]: (generate_data: {
    messages: SendingMessage[];
    model: string;
    temprature: number;
    frequency_penalty: number;
    presence_penalty: number;
    top_p: number;
    max_tokens: number;
    stream: boolean;
    logit_bias: object;
    stop: string[];
    chat_comletion_source: string;
    n?: number;
    user_name: string;
    char_name: string;
    group_names: string[];
    include_reasoning: boolean;
    reasoning_effort: string;
    json_schema: {
      name: string;
      value: Record<string, any>;
      description?: string;
      strict?: boolean;
    };
    [others: string]: any;
  }) => void;
  [tavern_events.CHAT_COMPLETION_PROMPT_READY]: (event_data: { chat: SendingMessage[]; dryRun: boolean }) => void;
  [tavern_events.CHARACTER_FIRST_MESSAGE_SELECTED]: (event_args: {
    input: string;
    output: string;
    character: object;
  }) => void;
  [tavern_events.CHARACTER_DELETED]: (result: { id: string; character: object }) => void;
  [tavern_events.CHARACTER_DUPLICATED]: (result: { oldAvatar: string; newAvatar: string }) => void;
  [tavern_events.CHARACTER_RENAMED]: (old_avatar: string, new_avatar: string) => void;
  [tavern_events.CHARACTER_RENAMED_IN_PAST_CHAT]: (
    current_chat: Record<string, any>,
    old_avatar: string,
    new_avatar: string,
  ) => void;
  [tavern_events.STREAM_TOKEN_RECEIVED]: (text: string) => void;
  [tavern_events.STREAM_REASONING_DONE]: (
    reasoning: string,
    duration: number | null,
    message_id: number,
    state: 'none' | 'thinking' | 'done' | 'hidden',
  ) => void;
  [tavern_events.FILE_ATTACHMENT_DELETED]: (url: string) => void;
  [tavern_events.WORLDINFO_FORCE_ACTIVATE]: (entries: object[]) => void;
  [tavern_events.OPEN_CHARACTER_LIBRARY]: () => void;
  [tavern_events.ONLINE_STATUS_CHANGED]: () => void;
  [tavern_events.IMAGE_SWIPED]: (result: {
    message: object;
    element: any;
    direction: 'left' | 'right';
  }) => void;
  [tavern_events.CONNECTION_PROFILE_LOADED]: (profile_name: string) => void;
  [tavern_events.CONNECTION_PROFILE_CREATED]: (profile: Record<string, any>) => void;
  [tavern_events.CONNECTION_PROFILE_DELETED]: (profile: Record<string, any>) => void;
  [tavern_events.CONNECTION_PROFILE_UPDATED]: (
    old_profile: Record<string, any>,
    new_profile: Record<string, any>,
  ) => void;
  [tavern_events.TOOL_CALLS_PERFORMED]: (tool_invocations: object[]) => void;
  [tavern_events.TOOL_CALLS_RENDERED]: (tool_invocations: object[]) => void;
  [tavern_events.CHARACTER_MANAGEMENT_DROPDOWN]: (target: any) => void;
  [tavern_events.SECRET_WRITTEN]: (secret: string) => void;
  [tavern_events.SECRET_DELETED]: (secret: string) => void;
  [tavern_events.SECRET_ROTATED]: (secret: string) => void;
  [tavern_events.SECRET_EDITED]: (secret: string) => void;
  [tavern_events.PRESET_CHANGED]: (data: { apiId: string; name: string }) => void;
  [tavern_events.PRESET_DELETED]: (data: { apiId: string; name: string }) => void;
  [tavern_events.PRESET_RENAMED]: (data: { apiId: string; oldName: string; newName: string }) => void;
  [tavern_events.PRESET_RENAMED_BEFORE]: (data: { apiId: string; oldName: string; newName: string }) => void;
  [tavern_events.MAIN_API_CHANGED]: (data: { apiId: string }) => void;
  [tavern_events.WORLDINFO_ENTRIES_LOADED]: (lores: {
    globalLore: Record<string, any>[];
    characterLore: Record<string, any>[];
    chatLore: Record<string, any>[];
    personaLore: Record<string, any>[];
  }) => void;
  [tavern_events.WORLDINFO_SCAN_DONE]: (event_data: {
    state: { current: number; next: number; loopCount: number };
    new: { all: Record<string, any>[]; successful: Record<string, any>[] };
    activated: { entries: Map<`${string}.${string}`, Record<string, any>>; text: string };
    sortedEntries: Record<string, any>[];
    recursionDelay: { availableLevels: number[]; currentLevel: number };
    budget: { current: number; overflowed: boolean };
    timedEffects: Record<string, any>;
  }) => void;

  // Custom / user-defined events
  [custom_event: string]: (...args: any[]) => any;
};

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

/** SillyTavern-compatible iframe event name constants. */
export const iframe_events = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
} as const;

/** SillyTavern-compatible tavern event name constants (~60 events). */
export const tavern_events = {
  APP_READY: 'app_ready',
  EXTRAS_CONNECTED: 'extras_connected',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
  MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
  MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  IMPERSONATE_READY: 'impersonate_ready',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  SD_PROMPT_PROCESSING: 'sd_prompt_processing',
  EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  MOVABLE_PANELS_RESET: 'movable_panels_reset',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
  OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
  OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
  OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  FORCE_SET_BACKGROUND: 'force_set_background',
  CHAT_DELETED: 'chat_deleted',
  CHAT_CREATED: 'chat_created',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
  GENERATE_AFTER_DATA: 'generate_after_data',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  CHARACTER_DELETED: 'characterDeleted',
  CHARACTER_DUPLICATED: 'character_duplicated',
  CHARACTER_RENAMED: 'character_renamed',
  CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
  SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  OPEN_CHARACTER_LIBRARY: 'open_character_library',
  ONLINE_STATUS_CHANGED: 'online_status_changed',
  IMAGE_SWIPED: 'image_swiped',
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_CREATED: 'connection_profile_created',
  CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
  TOOL_CALLS_RENDERED: 'tool_calls_rendered',
  CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
  SECRET_WRITTEN: 'secret_written',
  SECRET_DELETED: 'secret_deleted',
  SECRET_ROTATED: 'secret_rotated',
  SECRET_EDITED: 'secret_edited',
  PRESET_CHANGED: 'preset_changed',
  PRESET_DELETED: 'preset_deleted',
  PRESET_RENAMED: 'preset_renamed',
  PRESET_RENAMED_BEFORE: 'preset_renamed_before',
  MAIN_API_CHANGED: 'main_api_changed',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
  MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
} as const;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ListenerEntry {
  fn: (...args: any[]) => any;
  source: 'default' | 'first' | 'last';
}

// ---------------------------------------------------------------------------
// EventSource implementation
// ---------------------------------------------------------------------------

class EventSource {
  private listeners: Map<string, ListenerEntry[]> = new Map();

  private _getEntries(eventType: string): ListenerEntry[] {
    let entries = this.listeners.get(eventType);
    if (!entries) {
      entries = [];
      this.listeners.set(eventType, entries);
    }
    return entries;
  }

  /**
   * Re-sort the listener array for an event type so that:
   *  1. 'first' listeners run first (in registration order among themselves)
   *  2. 'default' listeners run in the middle
   *  3. 'last' listeners run last
   *
   * Stable within each group, matching JSR's makeFirst/makeLast semantics.
   */
  private _resort(eventType: string): void {
    const entries = this._getEntries(eventType);
    const first = entries.filter(e => e.source === 'first');
    const def = entries.filter(e => e.source === 'default');
    const last = entries.filter(e => e.source === 'last');
    const sorted = [...first, ...def, ...last];
    entries.length = 0;
    entries.push(...sorted);
  }

  /**
   * Execute all listeners for an event sequentially.
   * If a listener is async (returns a Promise), it is awaited before the next
   * listener runs. Errors are caught and logged but do not stop subsequent
   * listeners from executing.
   */
  private async _executeListeners(entries: ListenerEntry[], args: any[]): Promise<void> {
    for (const entry of entries) {
      try {
        await entry.fn(...args);
      } catch (err) {
        console.error(`[eventSource] Error in listener for event:`, err);
      }
    }
  }

  /**
   * Add a listener for an event type.
   * Returns a subscription object with a `stop()` method to unsubscribe.
   */
  on<T extends EventType>(
    eventType: T,
    listener: T extends keyof ListenerType ? ListenerType[T] : (...args: any[]) => any,
  ): EventSubscription {
    const entries = this._getEntries(eventType as string);
    entries.push({ fn: listener as (...args: any[]) => any, source: 'default' });
    return {
      stop: () => this._removeByFn(eventType as string, listener as (...args: any[]) => any),
    };
  }

  /**
   * Add a one-shot listener. It is automatically removed after its first
   * invocation. Returns a subscription object with `stop()`.
   */
  once<T extends EventType>(
    eventType: T,
    listener: T extends keyof ListenerType ? ListenerType[T] : (...args: any[]) => any,
  ): EventSubscription {
    const typeStr = eventType as string;
    const wrappedOnce = async (...args: any[]) => {
      this._removeByFn(typeStr, wrappedOnce);
      await (listener as (...a: any[]) => any)(...args);
    };
    // Store the wrapped function so _removeByFn can find it.
    // Also keep a back-reference from the original listener for clearListener.
    (wrappedOnce as any).__originalListener = listener;
    const entries = this._getEntries(typeStr);
    entries.push({ fn: wrappedOnce, source: 'default' });
    return {
      stop: () => this._removeByFn(typeStr, wrappedOnce),
    };
  }

  /**
   * Emit an event, executing all registered listeners sequentially.
   * Async listeners are awaited in order.
   * Returns a Promise that resolves when all listeners have finished.
   */
  async emit<T extends EventType>(
    eventType: T,
    ...args: T extends keyof ListenerType ? Parameters<ListenerType[T]> : any[]
  ): Promise<void> {
    const entries = [...this._getEntries(eventType as string)];
    await this._executeListeners(entries, args);
  }

  /**
   * Fire all registered listeners for the event type synchronously.
   * Unlike `emit`, this method does not wait for async listeners to resolve.
   * Errors in individual listeners are caught and logged.
   */
  emitAndWait<T extends EventType>(
    eventType: T,
    ...args: T extends keyof ListenerType ? Parameters<ListenerType[T]> : any[]
  ): void {
    const entries = [...this._getEntries(eventType as string)];
    for (const entry of entries) {
      try {
        entry.fn(...args);
      } catch (err) {
        console.error(`[eventSource] Error in listener for event:`, err);
      }
    }
  }

  /**
   * Register a listener to execute before all 'default' and 'last' listeners.
   * Among multiple 'first' listeners, registration order is preserved.
   * Returns a subscription object with `stop()`.
   */
  makeFirst<T extends EventType>(
    eventType: T,
    listener: T extends keyof ListenerType ? ListenerType[T] : (...args: any[]) => any,
  ): EventSubscription {
    const typeStr = eventType as string;
    const entries = this._getEntries(typeStr);
    entries.push({ fn: listener as (...args: any[]) => any, source: 'first' });
    this._resort(typeStr);
    return {
      stop: () => this._removeByFn(typeStr, listener as (...args: any[]) => any),
    };
  }

  /**
   * Register a listener to execute after all 'default' and 'first' listeners.
   * Among multiple 'last' listeners, registration order is preserved.
   * Returns a subscription object with `stop()`.
   */
  makeLast<T extends EventType>(
    eventType: T,
    listener: T extends keyof ListenerType ? ListenerType[T] : (...args: any[]) => any,
  ): EventSubscription {
    const typeStr = eventType as string;
    const entries = this._getEntries(typeStr);
    entries.push({ fn: listener as (...args: any[]) => any, source: 'last' });
    this._resort(typeStr);
    return {
      stop: () => this._removeByFn(typeStr, listener as (...args: any[]) => any),
    };
  }

  /**
   * Remove a specific listener from an event type.
   * Also handles listeners registered via `once` (searches by wrapper).
   */
  removeListener<T extends EventType>(
    eventType: T,
    listener: T extends keyof ListenerType ? ListenerType[T] : (...args: any[]) => any,
  ): void {
    this._removeByFn(eventType as string, listener as (...args: any[]) => any);
  }

  /** Internal: remove a listener by raw function reference (untyped). */
  private _removeByFn(eventType: string, fn: (...args: any[]) => any): void {
    const entries = this.listeners.get(eventType);
    if (!entries) return;

    const idx = entries.findIndex(
      e => e.fn === fn || (e.fn as any).__originalListener === fn,
    );
    if (idx !== -1) {
      entries.splice(idx, 1);
    }
  }

  /**
   * Remove all listeners for a specific event type.
   */
  clearEvent(eventType: EventType): void {
    this.listeners.delete(eventType);
  }

  /**
   * Remove a listener from ALL event types it is registered under.
   */
  clearListener(listener: (...args: any[]) => any): void {
    for (const [eventType, entries] of this.listeners) {
      const filtered = entries.filter(
        e => e.fn !== listener && (e.fn as any).__originalListener !== listener,
      );
      if (filtered.length === 0) {
        this.listeners.delete(eventType);
      } else {
        this.listeners.set(eventType, filtered);
      }
    }
  }

  /**
   * Remove all listeners for all event types.
   */
  clearAll(): void {
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The global event source singleton.
 * Compatible with SillyTavern's `eventSource` API used by JS-Slash-Runner
 * and other TavernHelper extensions.
 */
export const eventSource = new EventSource();
