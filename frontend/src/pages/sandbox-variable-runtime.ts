export const SANDBOX_VARIABLE_RUNTIME_SOURCE = String.raw`
  const messageVariablesOf = (message) => {
    if (!message || typeof message !== 'object') return {};
    if (message.variables && typeof message.variables === 'object') return message.variables;
    const data = message.data && typeof message.data === 'object' ? message.data : {};
    return data.variables && typeof data.variables === 'object' ? data.variables : {};
  };
  const runtimeScopedStores = {
    global: {},
    character: {},
    preset: {},
    script: {},
    extension: {},
    local: {},
  };
  const normalizeVariableOption = (option = { type: 'projection' }) => {
    if (typeof option === 'string') return { type: option };
    if (!option || typeof option !== 'object') return { type: 'projection' };
    return { type: option.type || 'projection', ...option };
  };
  const getVariableStore = (option = { type: 'projection' }) => {
    const normalized = normalizeVariableOption(option);
    const scope = normalized.type === 'chat' ? 'projection' : normalized.type;
    switch (scope) {
      case 'message':
        return messageVariablesOf(resolveRuntimeMessage(normalized));
      case 'projection':
        return runtimeProjectionVariables || {};
      case 'global':
      case 'character':
      case 'preset':
      case 'script':
      case 'extension':
      case 'local':
        return runtimeScopedStores[scope] || {};
      case 'chat':
      default:
        return runtimeProjectionVariables || {};
    }
  };
  const setVariableStore = (variables, option = { type: 'projection' }) => {
    const normalized = normalizeVariableOption(option);
    const scope = normalized.type === 'chat' ? 'projection' : normalized.type;
    const next = variables && typeof variables === 'object' ? variables : {};
    if (scope === 'message') {
      const message = resolveRuntimeMessage(normalized);
      if (message) {
        message.variables = next;
        message.data = { ...(message.data || {}), variables: next, stat_data: next, display_data: next };
      }
      post({
        type: 'card-sandbox-action',
        action: 'setVariables',
        payload: {
          variables: next,
          sourceMessageId: message?.id ?? message?.message_id ?? getRuntimeMessageId(),
          options: {
            ...normalized,
            message_id: normalized.message_id ?? normalized.messageId ?? message?.id ?? message?.message_id ?? getRuntimeMessageId(),
            source: normalized.source || 'message',
          },
        },
      });
      return next;
    }
    if (scope === 'projection' || !scope) {
      runtimeProjectionVariables = next;
      post({ type: 'card-sandbox-action', action: 'setVariables', payload: { variables: next, options: { ...normalized, type: 'projection' } } });
      return next;
    }
    runtimeScopedStores[scope] = next;
    postDiagnostic('setVariables-scoped-memory', { type: scope });
    return next;
  };
  async function readBridgeVariables(paths = [], option = { type: 'projection' }) {
    const normalized = normalizeVariableOption(option);
    const scope = String(normalized.type || 'projection');
    if (
      typeof requestHost === 'function'
      && (scope === 'canonical' || scope === 'platform' || scope === 'platform_state')
    ) {
      const requestPaths = Array.isArray(paths)
        ? paths.map((path) => String(path || '').trim()).filter(Boolean).slice(0, 100)
        : [];
      const values = await requestHost('readVariables', {
        paths: requestPaths,
        options: { ...normalized, type: 'canonical' },
      }).catch((error) => {
        postDiagnostic('readVariables-canonical-error', {
          scope,
          pathCount: requestPaths.length,
          message: String(error?.message || error).slice(0, 1000),
        });
        throw error;
      });
      postDiagnostic('readVariables-canonical-result', {
        scope,
        pathCount: requestPaths.length,
        resultKeys: Object.keys(values || {}).slice(0, 12),
      });
      return cloneJson(values && typeof values === 'object' ? values : {});
    }
    const store = getVariableStore(option);
    if (!Array.isArray(paths) || paths.length === 0) return cloneJson(store);
    const out = {};
    for (const rawPath of paths.slice(0, 50)) {
      const path = String(rawPath || '').trim();
      if (!path) continue;
      const value = getValueAtPath(store, path);
      if (value !== undefined) out[path] = cloneJson(value);
    }
    return out;
  }
  async function writeBridgeVariables(changes = {}, option = { type: 'projection' }) {
    const normalized = normalizeVariableOption(option);
    const scope = normalizeVariableScope(normalized.type);
    const base = cloneJson(getVariableStore({ ...normalized, type: scope }));
    const contract = runtimeContext?.variableContract || null;
    const result = applyBridgeChanges(base, changes, scope, contract);
    if (result.rejected.length > 0) {
      postDiagnostic('writeVariables-rejected-paths', {
        scope,
        rejected: result.rejected.slice(0, 20),
      });
    }
    setVariableStore(result.next, { ...normalized, type: scope });
    return cloneJson(result.next);
  }
  const getAllVariables = async () => {
    const merged = window._.merge(
      {},
      runtimeScopedStores.global,
      runtimeScopedStores.character,
      runtimeScopedStores.preset,
      runtimeScopedStores.script,
      runtimeScopedStores.extension,
      runtimeScopedStores.local,
      runtimeProjectionVariables,
      messageVariablesOf(runtimeMessage),
    );
    return {
      ...merged,
      global: cloneJson(runtimeScopedStores.global),
      character: cloneJson(runtimeScopedStores.character),
      preset: cloneJson(runtimeScopedStores.preset),
      script: cloneJson(runtimeScopedStores.script),
      extension: cloneJson(runtimeScopedStores.extension),
      local: cloneJson(runtimeScopedStores.local),
      projection: cloneJson(runtimeProjectionVariables),
      chat: cloneJson(runtimeProjectionVariables),
      message: cloneJson(messageVariablesOf(runtimeMessage)),
      variables: cloneJson(runtimeProjectionVariables),
    };
  };
  const replaceVariables = (variables, options = { type: 'projection' }) => setVariableStore(cloneJson(variables), options);
  const updateVariablesWith = (updater, options = { type: 'projection' }) => {
    const next = cloneJson(getVariableStore(options));
    try {
      if (typeof updater === 'function') {
        const result = updater(next);
        if (result && typeof result.then === 'function') {
          return result.then((resolved) => {
            const finalVariables = resolved && typeof resolved === 'object' ? resolved : next;
            setVariableStore(finalVariables, options);
            return finalVariables;
          });
        }
        if (result && typeof result === 'object') {
          setVariableStore(result, options);
          return result;
        }
      } else if (updater && typeof updater === 'object') {
        Object.assign(next, updater);
      }
    } catch (error) {
      post({ type: 'card-sandbox-action', action: 'runtimeError', payload: { message: String(error?.message || error).slice(0, 1000), stack: String(error?.stack || '').slice(0, 2000) } });
      return;
    }
    setVariableStore(next, options);
    return next;
  };
`;
