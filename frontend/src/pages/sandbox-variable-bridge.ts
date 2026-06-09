export interface SandboxVariableContract {
  writableProjectionPaths: string[];
  manualReviewPaths?: string[];
  writableCanonicalPaths?: string[];
}

export function normalizeVariableScope(scope?: string): string {
  const value = String(scope || 'projection');
  if (value === 'chat') return 'projection';
  return value;
}

function parsePathPart(part: string): { key: string; index: number | null } {
  const open = part.lastIndexOf('[');
  if (open >= 0 && part.endsWith(']')) {
    const key = part.slice(0, open);
    const rawIndex = part.slice(open + 1, -1);
    const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : null;
    return { key, index };
  }
  return { key: part, index: null };
}

export function getValueAtPath(root: any, path: string): any {
  if (!path) return root;
  let current = root;
  for (const part of String(path).split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    const { key, index } = parsePathPart(part);
    current = current?.[key];
    if (index != null) {
      if (!Array.isArray(current)) return undefined;
      current = current[index];
    }
  }
  return current;
}

function ensureObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensureArray(value: any) {
  return Array.isArray(value) ? value : [];
}

export function setValueAtPath(root: any, path: string, value: any): any {
  const base = ensureObject(structuredClone(root ?? {}));
  const parts = String(path).split('.').filter(Boolean);
  if (parts.length === 0) return base;
  let current = base;
  for (let i = 0; i < parts.length; i += 1) {
    const { key, index } = parsePathPart(parts[i]);
    const isLast = i === parts.length - 1;
    if (isLast) {
      if (index != null) {
        current[key] = ensureArray(current[key]);
        while (current[key].length <= index) current[key].push(null);
        current[key][index] = value;
      } else {
        current[key] = value;
      }
      break;
    }
    if (index != null) {
      current[key] = ensureArray(current[key]);
      while (current[key].length <= index) current[key].push({});
      current[key][index] = ensureObject(current[key][index]);
      current = current[key][index];
    } else {
      current[key] = ensureObject(current[key]);
      current = current[key];
    }
  }
  return base;
}

function collectLeafChanges(value: any, prefix = ''): Array<{ path: string; value: any }> {
  if (Array.isArray(value) || value == null || typeof value !== 'object') {
    return prefix ? [{ path: prefix, value }] : [];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [{ path: prefix, value }] : [];
  return entries.flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return collectLeafChanges(child, next);
  });
}

function isProjectionPathAllowed(path: string, contract?: SandboxVariableContract | null): boolean {
  const allowed = contract?.writableProjectionPaths || [];
  if (allowed.length === 0) return true;
  return allowed.some(item =>
    path === item
      || path.startsWith(`${item}.`)
      || path.startsWith(`${item}[`)
  );
}

export function applyBridgeChanges(
  current: any,
  changes: any,
  scope: string,
  contract?: SandboxVariableContract | null,
): { next: any; applied: string[]; rejected: string[] } {
  const normalizedScope = normalizeVariableScope(scope);
  const leafChanges = Array.isArray(changes)
    ? changes.flatMap((change) => {
        const path = String(change?.path ?? change?.target ?? '').trim();
        if (!path) return [];
        return [{ path, value: change?.value ?? change?.to ?? null }];
      })
    : collectLeafChanges(changes);

  let next = structuredClone(current ?? {});
  const applied: string[] = [];
  const rejected: string[] = [];

  for (const change of leafChanges) {
    if (!change.path) continue;
    if (normalizedScope === 'projection' && !isProjectionPathAllowed(change.path, contract)) {
      rejected.push(change.path);
      continue;
    }
    next = setValueAtPath(next, change.path, structuredClone(change.value));
    applied.push(change.path);
  }

  return { next, applied, rejected };
}
