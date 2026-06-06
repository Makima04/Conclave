import type { Session, SessionConfig, Message, ProviderConfig, WorldBook, WorldBookDetail, WorldBookEntry, CharacterCard, ParsedWorldBookEntry, Preset, PresetDetail } from './types';

const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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

export async function listSessions(): Promise<{ items: Session[] }> {
  return request('/sessions');
}

export async function getSession(id: string): Promise<Session> {
  return request(`/sessions/${id}`);
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/sessions/${id}`, { method: 'DELETE' });
}

export async function updateSession(id: string, data: { title?: string; config?: SessionConfig }): Promise<Session> {
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

// SSE streaming for sending messages
export function sendMessageStream(
  sessionId: string,
  content: string,
  onEvent: (event: string, data: any) => void,
  onError: (error: Error) => void,
  onDone: () => void,
  stream: boolean = true,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE_URL}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ content, stream }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              onEvent(currentEvent, JSON.parse(data));
            } catch {
              onEvent(currentEvent, data);
            }
          }
        }
      }

      // Flush remaining buffer (final event may lack trailing newline)
      if (buffer.trim()) {
        const lines = buffer.split('\n');
        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              onEvent(currentEvent, JSON.parse(data));
            } catch {
              onEvent(currentEvent, data);
            }
          }
        }
      }

      onDone();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        onError(err);
      }
    }
  })();

  return controller;
}

// State
export async function getSessionState(sessionId: string): Promise<any> {
  return request(`/sessions/${sessionId}/state`);
}

// Memory
export async function getMemoryEvents(sessionId: string): Promise<{ items: any[] }> {
  return request(`/sessions/${sessionId}/memory/events`);
}

export async function getForeshadowing(sessionId: string): Promise<{ items: any[] }> {
  return request(`/sessions/${sessionId}/memory/foreshadowing`);
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

export async function fetchModels(base_url: string, api_key?: string): Promise<{ models: string[] }> {
  return request('/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ base_url, api_key }),
  });
}

// Trace
export async function getTrace(sessionId: string, turn: number): Promise<{ items: any[] }> {
  return request(`/sessions/${sessionId}/trace/${turn}`);
}

// SSE reconnect for recovery: returns the fetch Response (200 = active stream, 404 = no active turn)
export async function reconnectStream(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${BASE_URL}/sessions/${sessionId}/reconnect`, {
    headers: { 'Accept': 'text/event-stream' },
    signal,
  });
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
  config: Record<string, any>;
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

export async function updateAgent(sessionId: string, agentId: string, data: { label?: string; system_prompt?: string; context?: string; config?: Record<string, any> }): Promise<void> {
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

export async function listCharacterCards(): Promise<{ items: { id: string; name: string; creator: string; created_at: string }[] }> {
  return request('/charactercards');
}

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

export async function parseWorldBook(id: string): Promise<{ status: string; entries: ParsedWorldBookEntry[] }> {
  return request(`/worldbooks/${id}/parse`, { method: 'POST' });
}

// --- Presets ---

export async function importPreset(data: any, sessionId?: string): Promise<PresetDetail> {
  return request('/presets', {
    method: 'POST',
    body: JSON.stringify({ data, session_id: sessionId || null }),
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

export async function deletePresetModule(presetId: string, moduleId: string): Promise<void> {
  await request(`/presets/${presetId}/modules/${moduleId}`, { method: 'DELETE' });
}
