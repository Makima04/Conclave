export const SANDBOX_VARIABLE_RUNTIME_SOURCE = String.raw`
  const normalizeVariableScope = (scope = 'projection') => {
    const value = String(scope || 'projection');
    if (value === 'chat') return 'projection';
    return value;
  };
  const normalizePath = (path) => {
    const trimmed = String(path || '').trim();
    if (trimmed.startsWith('stat_data.')) return trimmed.slice('stat_data.'.length);
    if (trimmed.startsWith('variables.')) return trimmed.slice('variables.'.length);
    return trimmed;
  };
  const parseVariablePathPart = (part) => {
    const source = String(part || '');
    const open = source.lastIndexOf('[');
    if (open >= 0 && source.endsWith(']')) {
      const key = source.slice(0, open);
      const rawIndex = source.slice(open + 1, -1);
      const index = /^\\d+$/.test(rawIndex) ? Number(rawIndex) : null;
      return { key, index };
    }
    return { key: source, index: null };
  };
  const getValueAtPath = (root, path) => {
    if (!path) return root;
    let current = root;
    for (const part of String(path).split('.').filter(Boolean)) {
      if (!current || typeof current !== 'object') return undefined;
      const { key, index } = parseVariablePathPart(part);
      current = current?.[key];
      if (index != null) {
        if (!Array.isArray(current)) return undefined;
        current = current[index];
      }
    }
    return current;
  };
  const ensureBridgeObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const ensureBridgeArray = (value) => Array.isArray(value) ? value : [];
  const setValueAtPath = (root, path, value) => {
    const base = ensureBridgeObject(cloneJson(root ?? {}));
    const parts = String(path || '').split('.').filter(Boolean);
    if (parts.length === 0) return base;
    let current = base;
    for (let i = 0; i < parts.length; i += 1) {
      const { key, index } = parseVariablePathPart(parts[i]);
      if (!key) continue;
      const isLast = i === parts.length - 1;
      if (isLast) {
        if (index != null) {
          current[key] = ensureBridgeArray(current[key]);
          while (current[key].length <= index) current[key].push(null);
          current[key][index] = value;
        } else {
          current[key] = value;
        }
        break;
      }
      if (index != null) {
        current[key] = ensureBridgeArray(current[key]);
        while (current[key].length <= index) current[key].push({});
        current[key][index] = ensureBridgeObject(current[key][index]);
        current = current[key][index];
      } else {
        current[key] = ensureBridgeObject(current[key]);
        current = current[key];
      }
    }
    return base;
  };
  const collectBridgeLeafChanges = (value, prefix = '') => {
    if (Array.isArray(value) || value == null || typeof value !== 'object') {
      return prefix ? [{ path: prefix, value }] : [];
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return prefix ? [{ path: prefix, value }] : [];
    return entries.flatMap(([key, child]) => {
      const next = prefix ? prefix + '.' + key : key;
      return collectBridgeLeafChanges(child, next);
    });
  };
  const isProjectionPathAllowed = (path, contract) => {
    const allowed = contract?.writableProjectionPaths || [];
    if (allowed.length === 0) return true;
    return allowed.some(item =>
      path === item
        || path.startsWith(item + '.')
        || path.startsWith(item + '[')
    );
  };
  const applyBridgeChanges = (current, changes, scope, contract = null) => {
    const normalizedScope = normalizeVariableScope(scope);
    const leafChanges = Array.isArray(changes)
      ? changes.flatMap((change) => {
          const path = String(change?.path ?? change?.target ?? '').trim();
          if (!path) return [];
          return [{ path, value: change?.value ?? change?.to ?? null }];
        })
      : collectBridgeLeafChanges(changes);
    let next = cloneJson(current ?? {});
    const applied = [];
    const rejected = [];
    for (const change of leafChanges) {
      if (!change.path) continue;
      const normalizedPath = normalizePath(change.path);
      if (!normalizedPath) continue;
      if (normalizedScope === 'projection' && !isProjectionPathAllowed(normalizedPath, contract)) {
        console.warn('[sandbox-variable-runtime] write_rule mismatch: projection path not writable, write rejected:', normalizedPath);
        rejected.push(normalizedPath);
        continue;
      }
      next = setValueAtPath(next, normalizedPath, cloneJson(change.value));
      applied.push(normalizedPath);
    }
    return { next, applied, rejected };
  };
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
        ? paths.map((path) => normalizePath(path)).filter(Boolean).slice(0, 100)
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
      const path = normalizePath(rawPath);
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
