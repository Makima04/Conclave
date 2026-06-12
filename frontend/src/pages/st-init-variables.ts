function stripCodeFence(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) return trimmed;
  const withoutOpen = trimmed.slice(firstBreak + 1);
  const close = withoutOpen.lastIndexOf('```');
  return close >= 0 ? withoutOpen.slice(0, close).trim() : withoutOpen.trim();
}

function findTagBody(source: string, tag: string): string | null {
  const lower = source.toLowerCase();
  const open = `<${tag.toLowerCase()}`;
  const close = `</${tag.toLowerCase()}>`;
  const start = lower.indexOf(open);
  if (start < 0) return null;
  const bodyStart = source.indexOf('>', start);
  if (bodyStart < 0) return null;
  const end = lower.indexOf(close, bodyStart + 1);
  if (end < 0) return null;
  return source.slice(bodyStart + 1, end).trim();
}

function normalizeInitVarSource(content: string): string {
  const withoutFence = stripCodeFence(content);
  const updateBody = findTagBody(withoutFence, 'UpdateVariable')
    ?? findTagBody(withoutFence, 'UpdateVariablevariable')
    ?? withoutFence;
  return findTagBody(updateBody, 'initvar') ?? updateBody;
}

function parseJsonVariables(source: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const variables = value.variables;
    if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
      return variables as Record<string, unknown>;
    }
    return value;
  } catch {
    return null;
  }
}

function splitAssignment(line: string): [string, string] | null {
  for (const sep of ['：', ':']) {
    const index = line.indexOf(sep);
    if (index >= 0) {
      const key = line.slice(0, index).trim();
      const value = line.slice(index + sep.length).trim();
      return key ? [key, value] : null;
    }
  }
  return null;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim().replace(/,$/, '');
  if (!value) return '';
  try {
    return JSON.parse(value);
  } catch {
    // fall through
  }
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(value)) return numeric;
  return value.replace(/^["']|["']$/g, '');
}

function ensureObjectPath(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let cursor = root;
  for (const key of path) {
    const current = cursor[key];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  return cursor;
}

function setPathValue(root: Record<string, unknown>, path: string[], value: unknown) {
  if (path.length === 0) return;
  const parent = ensureObjectPath(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

function pushArrayValue(root: Record<string, unknown>, path: string[], value: unknown) {
  if (path.length === 0) return;
  const parent = ensureObjectPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!Array.isArray(parent[key])) parent[key] = [];
  (parent[key] as unknown[]).push(value);
}

function parseIndentedVariables(source: string): Record<string, unknown> | null {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; key: string }> = [];
  let wroteValue = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const lineWithoutComment = rawLine.split('#')[0] ?? rawLine;
    const indent = lineWithoutComment.length - lineWithoutComment.trimStart().length;
    const line = lineWithoutComment.trim();
    if (!line) continue;

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (line.startsWith('- ')) {
      const path = stack.map(item => item.key);
      if (path.length > 0) {
        pushArrayValue(root, path, parseScalar(line.slice(2)));
        wroteValue = true;
      }
      continue;
    }

    const assignment = splitAssignment(line);
    if (!assignment) continue;
    const [key, rawValue] = assignment;
    const path = [...stack.map(item => item.key), key];
    if (!rawValue) {
      ensureObjectPath(root, path);
      stack.push({ indent, key });
      continue;
    }
    setPathValue(root, path, parseScalar(rawValue));
    wroteValue = true;
  }

  return wroteValue ? root : null;
}

export function parseInitVariables(content: string): Record<string, unknown> | null {
  const hasExplicitInitBlock = /<\s*(?:UpdateVariable(?:variable)?|initvar)\b/i.test(content);
  const normalized = normalizeInitVarSource(content).trim();
  if (!normalized) return null;
  const jsonVariables = parseJsonVariables(normalized);
  if (jsonVariables) return jsonVariables;
  return hasExplicitInitBlock ? parseIndentedVariables(normalized) : null;
}

export function mergeVariableObjects(
  base: Record<string, unknown>,
  overlay: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!overlay) return base;
  return mergeInto(structuredClone(base), overlay);
}

function mergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (
      current
      && typeof current === 'object'
      && !Array.isArray(current)
      && value
      && typeof value === 'object'
      && !Array.isArray(value)
    ) {
      target[key] = mergeInto(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}
