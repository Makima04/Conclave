import type {
  Session, SessionConfig, Message, ProviderConfig,
  WorldBook, WorldBookDetail, WorldBookEntry, CharacterCard,
  ParsedWorldBookEntry, Preset, PresetDetail,
  RuntimeSettings, SessionRuntimeAssets,
  StHostRenderPayload,
  DebugMessage, DebugTurnSummary, AgentDebugSnapshot,
  AgentConfig,
} from './types';
import { consumeSseResponse, type ChatSseHandler } from './sse';

// Local type for shared saves
interface SandboxSharedSave {
  id: string;
  session_id: string;
  world_pack_id: string;
  group_id: string;
  label: string;
  state: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

const BASE_URL = '/api';

function authHeaders(): HeadersInit {
  const token = import.meta.env.VITE_API_AUTH_TOKEN || localStorage.getItem('api_auth_token') || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options?.headers },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

// Sessions
export async function createSession(title?: string, mode?: string, worldPackId?: string, config?: SessionConfig): Promise<Session> {
  return request('/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, mode, world_pack_id: worldPackId || null, config }),
  });
}

export async function listSessions(params?: { limit?: number; worldPackId?: string }): Promise<{ items: Session[] }> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.worldPackId) query.set('world_pack_id', params.worldPackId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request(`/sessions${suffix}`);
}

export async function listSharedSaves(params: { worldPackId: string; limit?: number }): Promise<{ items: SandboxSharedSave[] }> {
  const query = new URLSearchParams();
  query.set('world_pack_id', params.worldPackId);
  if (params.limit) query.set('limit', String(params.limit));
  return request(`/session-shared-saves?${query.toString()}`);
}

export async function getSession(id: string): Promise<Session> {
  return request(`/sessions/${id}`);
}

export async function getSessionRuntimeAssets(id: string): Promise<SessionRuntimeAssets> {
  return request(`/sessions/${id}/runtime-assets`);
}

export async function getSessionStHostRender(id: string): Promise<StHostRenderPayload> {
  return request(`/sessions/${id}/st-host-render`);
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/sessions/${id}`, { method: 'DELETE' });
}

export async function updateSession(id: string, data: { title?: string; config?: SessionConfig; world_pack_id?: string | null }): Promise<Session> {
  return request(`/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// Messages
export async function listMessages(sessionId: string): Promise<{ items: Message[] }> {
  return request(`/sessions/${sessionId}/messages`);
}

export async function applyOpeningMessage(sessionId: string, content: string): Promise<Message> {
  return request(`/sessions/${sessionId}/opening`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export async function quietGenerate(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<{ content: string; generation_id?: string; model: string }> {
  return request(`/sessions/${sessionId}/quiet-generate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// SSE streaming for sending messages
export function sendMessageStream(
  sessionId: string,
  content: string,
  onMessage: ChatSseHandler,
  onError: (error: Error) => void,
  onDone: () => void,
  stream: boolean = true,
  metadata?: Record<string, unknown>,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE_URL}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...authHeaders(),
        },
        body: JSON.stringify({ content, stream, metadata }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }

      await consumeSseResponse(res, onMessage);
      onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        onError(err);
      }
    }
  })();

  return controller;
}

/**
 * Reattach to a turn that is still running on the backend — used after the chat
 * page unmounts and remounts (navigating away and back, or a refresh) while a
 * generation is in flight. The backend keeps an in-memory broadcast per active
 * session (`active_turns`); this subscribes to it.
 *
 * If no turn is active the endpoint returns 404 / "no_active_turn" — handled
 * silently via `onDone` *without* firing `onActive`, so callers stay idle instead
 * of flashing a false "running" indicator. A live stream fires `onActive` first,
 * then the normal `onMessage`/`onDone` lifecycle.
 */
export function reconnectStream(
  sessionId: string,
  handlers: {
    onActive?: () => void;
    onMessage: ChatSseHandler;
    onError: (error: Error) => void;
    onDone: () => void;
  },
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE_URL}/sessions/${sessionId}/reconnect`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...authHeaders() },
        signal: controller.signal,
      });

      // Any non-OK status (notably 404 no_active_turn) means nothing is running —
      // resolve without signalling an active turn.
      if (!res.ok) {
        handlers.onDone();
        return;
      }

      handlers.onActive?.();
      await consumeSseResponse(res, handlers.onMessage);
      handlers.onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        handlers.onError(err);
      }
    }
  })();

  return controller;
}

// State
export async function getSessionState(sessionId: string): Promise<any> {
  return request(`/sessions/${sessionId}/state`);
}

export async function updateSessionVariables(sessionId: string, variables: Record<string, unknown>): Promise<{ variables: Record<string, unknown> }> {
  return request(`/sessions/${sessionId}/variables`, {
    method: 'PUT',
    body: JSON.stringify({ changes: variables }),
  });
}

export async function applyProjectionChanges(
  sessionId: string,
  changes: Array<{ path: string; value: unknown }>,
): Promise<{ variables: Record<string, unknown>; rejected_paths: string[] }> {
  return request(`/sessions/${sessionId}/variable-changes`, {
    method: 'POST',
    body: JSON.stringify({ changes }),
  });
}

export async function readSessionVariables(
  sessionId: string,
  scope: 'projection' | 'canonical' | 'message' | 'chat' | 'platform',
  paths: string[] = [],
): Promise<{ scope: string; values: Record<string, unknown> }> {
  return request(`/sessions/${sessionId}/variable-reads`, {
    method: 'POST',
    body: JSON.stringify({ scope, paths }),
  });
}

// Providers
export async function listProviders(): Promise<{ items: ProviderConfig[] }> {
  return request('/providers');
}

export async function createProvider(data: {
  name: string;
  base_url: string;
  api_key?: string;
  model: string;
  is_default?: boolean;
}): Promise<ProviderConfig> {
  return request('/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateProvider(id: string, data: {
  name?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  is_default?: boolean;
}): Promise<ProviderConfig> {
  return request(`/providers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteProvider(id: string): Promise<void> {
  await request(`/providers/${id}`, { method: 'DELETE' });
}

export async function fetchModels(base_url: string, api_key?: string, provider_id?: string): Promise<{ models: string[] }> {
  return request('/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify(provider_id ? { provider_id } : { base_url, api_key }),
  });
}

// Runtime Settings
export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return request('/settings/runtime');
}

export async function updateRuntimeSettings(data: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
  return request('/settings/runtime', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getSessionDebugOverview(sessionId: string): Promise<{ messages: DebugMessage[]; turns: DebugTurnSummary[] }> {
  return request(`/sessions/${sessionId}/debug`);
}

export async function getSessionDebugTurn(sessionId: string, turn: number): Promise<{ items: AgentDebugSnapshot[] }> {
  return request(`/sessions/${sessionId}/debug/${turn}`);
}

// Regenerate
export async function regenerateMessage(sessionId: string, messageId: string): Promise<{ id: string; content: string; variants: string; turn_number: number }> {
  return request(`/sessions/${sessionId}/messages/${messageId}/regenerate`, {
    method: 'POST',
  });
}

// Switch variant
export async function switchVariant(sessionId: string, messageId: string, index: number): Promise<{ id: string; content: string; variants: string; variant_index: number }> {
  return request(`/sessions/${sessionId}/messages/${messageId}/switch-variant`, {
    method: 'PUT',
    body: JSON.stringify({ index }),
  });
}

// Edit message
export async function editMessage(sessionId: string, messageId: string, content: string): Promise<{ id: string; content: string; variants: string; variant_index: number }> {
  return request(`/sessions/${sessionId}/messages/${messageId}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

export async function updateMessageMetadata(sessionId: string, messageId: string, metadata: Record<string, unknown>): Promise<{ id: string; metadata: Record<string, unknown> }> {
  return request(`/sessions/${sessionId}/messages/${messageId}/metadata`, {
    method: 'PUT',
    body: JSON.stringify({ metadata }),
  });
}

// Delete message
export async function deleteMessage(sessionId: string, messageId: string): Promise<void> {
  await request(`/sessions/${sessionId}/messages/${messageId}`, {
    method: 'DELETE',
  });
}

// --- Sub-Agents ---

export interface SubAgent {
  id: string;
  session_id: string;
  agent_type: string;
  character_id: string | null;
  label: string;
  status: string;
  last_active_turn: number;
  context: string;
  context_preview: string;
  config: AgentConfig;
  fixed: boolean;
}

export async function listAgents(sessionId: string): Promise<{ items: SubAgent[] }> {
  return request(`/sessions/${sessionId}/agents`);
}

export async function createAgent(sessionId: string, data: { agent_type: string; label?: string; character_id?: string; context?: string; system_prompt?: string; model?: string }): Promise<{ id: string }> {
  return request(`/sessions/${sessionId}/agents`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateAgent(sessionId: string, agentId: string, data: { label?: string; system_prompt?: string; context?: string; config?: Partial<AgentConfig> }): Promise<void> {
  await request(`/sessions/${sessionId}/agents/${agentId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function cooldownAgent(sessionId: string, agentId: string): Promise<void> {
  await request(`/sessions/${sessionId}/agents/${agentId}/cooldown`, { method: 'POST' });
}

export async function restoreAgent(sessionId: string, agentId: string): Promise<void> {
  await request(`/sessions/${sessionId}/agents/${agentId}/restore`, { method: 'POST' });
}

export async function deleteAgent(sessionId: string, agentId: string): Promise<void> {
  await request(`/sessions/${sessionId}/agents/${agentId}`, { method: 'DELETE' });
}

// --- World Books ---

export async function listWorldBooks(): Promise<{ items: WorldBook[] }> {
  return request('/worldbooks');
}

export async function getWorldBook(id: string): Promise<WorldBookDetail> {
  return request(`/worldbooks/${id}`);
}

export async function importWorldBook(data: any): Promise<WorldBookDetail> {
  return request('/worldbooks', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

export async function importCharacterCardFile(file: File): Promise<{
  import_id: string;
  package_draft: unknown;
  import_report: unknown;
}> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${BASE_URL}/charactercards/import`, {
    method: 'POST',
    headers: { ...authHeaders() },
    body: form,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function confirmCharacterCardImport(importId: string, options?: {
  worldBookId?: string;
  degradeToSchema?: boolean;
}): Promise<{
  character_card_id: string;
  world_pack_id: string;
  status: string;
}> {
  return request(`/charactercards/import/${importId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      world_book_id: options?.worldBookId || null,
      degrade_to_schema: options?.degradeToSchema ?? false,
    }),
  });
}

export async function updateWorldBook(id: string, data: { name?: string; description?: string }): Promise<any> {
  return request(`/worldbooks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteWorldBook(id: string): Promise<void> {
  await request(`/worldbooks/${id}`, { method: 'DELETE' });
}

export async function exportWorldBook(id: string): Promise<any> {
  return request(`/worldbooks/${id}/export`);
}

export async function updateWorldBookEntry(
  bookId: string,
  entryId: string,
  data: {
    keys?: string[];
    content?: string;
    comment?: string;
    constant?: boolean;
    priority?: number;
    enabled?: boolean;
    position?: string;
    selective?: boolean;
    secondary_keys?: string[];
    selective_logic?: number;
  }
): Promise<any> {
  return request(`/worldbooks/${bookId}/entries/${entryId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteWorldBookEntry(bookId: string, entryId: string): Promise<void> {
  await request(`/worldbooks/${bookId}/entries/${entryId}`, { method: 'DELETE' });
}

// --- Character Cards ---

export async function getCharacterCard(id: string): Promise<CharacterCard> {
  return request(`/charactercards/${id}`);
}

export async function getWorldBookCharacterCard(worldBookId: string): Promise<CharacterCard> {
  return request(`/worldbooks/${worldBookId}/character-card`);
}

export async function updateCharacterCard(id: string, data: Partial<CharacterCard>): Promise<any> {
  return request(`/charactercards/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// --- World Book Parsing ---

export async function parseWorldBook(id: string): Promise<{ status: string; mode: string; entries?: ParsedWorldBookEntry[] }> {
  return request(`/worldbooks/${id}/parse`, { method: 'POST' });
}

export async function parseWorldBookSingleAgent(id: string): Promise<{ status: string; mode: string; entries?: ParsedWorldBookEntry[] }> {
  return request(`/worldbooks/${id}/parse-single-agent`, { method: 'POST' });
}

// --- Presets ---

export async function importPreset(data: any, sessionId?: string, fileName?: string): Promise<PresetDetail> {
  return request('/presets', {
    method: 'POST',
    body: JSON.stringify({ data, session_id: sessionId || null, file_name: fileName || null }),
  });
}

export async function listPresets(sessionId?: string): Promise<{ items: Preset[] }> {
  const qs = sessionId ? `?session_id=${sessionId}` : '';
  return request(`/presets${qs}`);
}

export async function getPreset(id: string): Promise<PresetDetail> {
  return request(`/presets/${id}`);
}

export async function updatePreset(id: string, data: { name?: string }): Promise<any> {
  return request(`/presets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deletePreset(id: string): Promise<void> {
  await request(`/presets/${id}`, { method: 'DELETE' });
}

export async function parsePreset(id: string): Promise<{ status: string; modules: number }> {
  return request(`/presets/${id}/parse`, { method: 'POST' });
}

export async function updatePresetModule(
  presetId: string,
  moduleId: string,
  data: { target_agents?: string[]; enabled?: boolean }
): Promise<any> {
  return request(`/presets/${presetId}/modules/${moduleId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
