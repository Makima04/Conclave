import type { Session, SessionConfig, Message, ProviderConfig } from './types';

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
export async function createSession(title?: string, mode?: string): Promise<Session> {
  return request('/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, mode }),
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
