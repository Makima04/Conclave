export const SANDBOX_QUIET_RUNTIME_SOURCE = String.raw`
  const quietGenerationIdFromRequest = (request) => {
    if (request && typeof request === 'object') {
      const explicit = request.generation_id ?? request.generationId ?? request.id;
      if (explicit != null && String(explicit).trim()) return String(explicit).trim();
    }
    return makeGenerationId();
  };
  const quietRequestPayload = (request, generationId) => {
    if (typeof request === 'string') return { prompt: request, generation_id: generationId };
    if (Array.isArray(request)) return { ordered_prompts: request, generation_id: generationId };
    if (request && typeof request === 'object') {
      return {
        ...request,
        generation_id: request.generation_id ?? request.generationId ?? generationId,
      };
    }
    return { prompt: '', generation_id: generationId };
  };
  const quietAuthHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const token = window.localStorage?.getItem('api_auth_token') || '';
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch {}
    return headers;
  };
  const textFromGenerateRequest = (request) => {
    if (typeof request === 'string') return request;
    if (!request || typeof request !== 'object') return '';
    for (const key of ['message', 'text', 'input', 'content', 'value']) {
      const value = request[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    for (const key of ['user_input', 'userInput', 'prompt']) {
      const value = request[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const currentInputMatch = value.match(/玩家当前输入[：:]\\s*([^\\n]+)/);
      if (currentInputMatch?.[1]?.trim()) return currentInputMatch[1].trim();
      const userHistoryMatches = Array.from(value.matchAll(/\\[user:[^\\]]+\\]\\s*\\n([^\\n]+)/g));
      const latestUserHistory = userHistoryMatches[userHistoryMatches.length - 1]?.[1]?.trim();
      if (latestUserHistory) return latestUserHistory;
      return value;
    }
    if (Array.isArray(request.ordered_prompts)) {
      return request.ordered_prompts
        .map(item => item && typeof item === 'object' ? item.content : item)
        .filter(item => typeof item === 'string' && item.trim())
        .join('\\n\\n');
    }
    return '';
  };
`;

