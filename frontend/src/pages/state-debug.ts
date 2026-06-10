import type { CharacterCard, ConclaveCardPackage, StateFieldDeclaration } from '../api/types';
import type { UiSchema, UiWidget } from './card-schema-types';
import { getPathValue, parsePrimaryValue } from './card-utils';

export type StateDiagnosticRow = {
  path: string;
  resolvedPath: string;
  source: 'ui_schema' | 'state_schema';
  role: string;
  writable?: boolean;
  canonicalPath?: string | null;
  resolution: 'direct' | 'projection_alias';
  exists: boolean;
  value: unknown;
  preview: string;
};

export type StateDiagnosticSummary = {
  totalChecks: number;
  matchedChecks: number;
  missingChecks: number;
  rows: StateDiagnosticRow[];
};

export type StateContractQuality = {
  packageStateFields: number;
  writableMappings: number;
  readMappings: number;
  warnings: string[];
  rootOnlySchema: boolean;
  aliasRootFields: string[];
  declaredLeafLikeFields: number;
  runtimeLeafPaths: number;
  diagnosableLeafFields: number;
  canVerifyFineGrainedBindings: boolean;
  issues: string[];
};

export type StateExplainabilityIssue = {
  kind:
    | 'missing_runtime_value'
    | 'alias_root_only'
    | 'missing_canonical_mapping'
    | 'read_only_field'
    | 'card_private_runtime'
    | 'schema_too_coarse'
    | 'closest_match_only';
  title: string;
  detail: string;
  path?: string;
  canonicalPath?: string | null;
  closestPaths?: string[];
};

type PathCandidate = {
  path: string;
  source: 'ui_schema' | 'state_schema';
  role: string;
  writable?: boolean;
  canonicalPath?: string | null;
};

const PROJECTION_ALIAS_PREFIXES = ['stat_data', 'display_data', 'variables', 'chat_variables', 'projection', 'chat'];

function uniqueByPath(rows: PathCandidate[]): PathCandidate[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.source}:${row.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectUiSchemaPaths(schema: UiSchema | null): PathCandidate[] {
  if (!schema) return [];
  const rows: PathCandidate[] = [];

  for (const path of schema.datePaths || []) {
    rows.push({ path, source: 'ui_schema', role: 'date_path' });
  }

  for (const section of schema.sections || []) {
    for (const widget of section.widgets || []) {
      rows.push(...collectWidgetPaths(widget));
    }
  }

  return uniqueByPath(rows);
}

function collectWidgetPaths(widget: UiWidget): PathCandidate[] {
  if (widget.type === 'thoughts') {
    return [
      { path: widget.leftPath, source: 'ui_schema', role: `thought:${widget.leftLabel}` },
      { path: widget.rightPath, source: 'ui_schema', role: `thought:${widget.rightLabel}` },
    ];
  }

  if (widget.type === 'progress') {
    return [{ path: widget.path, source: 'ui_schema', role: `progress:${widget.label}` }];
  }

  if (widget.type === 'facts') {
    return widget.items.map((item) => ({
      path: item.path,
      source: 'ui_schema' as const,
      role: `fact:${item.label}`,
    }));
  }

  return [];
}

function collectStateSchemaPaths(card: CharacterCard | null): PathCandidate[] {
  const fields = card?.conclave_package?.state_schema?.fields || [];
  return uniqueByPath(
    fields
      .filter((field) => Boolean(field.path))
      .map((field) => stateFieldToCandidate(field)),
  );
}

function stateFieldToCandidate(field: StateFieldDeclaration): PathCandidate {
  return {
    path: field.path,
    source: 'state_schema',
    role: field.role,
    writable: field.writable,
    canonicalPath: field.canonical_path ?? null,
  };
}

function hasOwnPath(source: unknown, path: string): boolean {
  if (path === '') {
    return source != null && typeof source === 'object';
  }
  if (!source || !path) return false;
  const parts = path.split('.').filter(Boolean);
  let current: any = source;
  for (const part of parts) {
    if (current == null || typeof current !== 'object' || !(part in current)) {
      return false;
    }
    current = current[part];
  }
  return true;
}

function resolveDiagnosticPath(path: string): { resolvedPath: string; resolution: 'direct' | 'projection_alias' } {
  const trimmed = String(path || '').trim();
  for (const prefix of PROJECTION_ALIAS_PREFIXES) {
    if (trimmed === prefix) {
      return { resolvedPath: '', resolution: 'projection_alias' };
    }
    if (trimmed.startsWith(`${prefix}.`)) {
      return {
        resolvedPath: trimmed.slice(prefix.length + 1),
        resolution: 'projection_alias',
      };
    }
  }
  return { resolvedPath: trimmed, resolution: 'direct' };
}

function formatDiagnosticPreview(value: unknown, exists: boolean): string {
  if (!exists) return 'missing';
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    const keys = Object.keys(value);
    return keys.length === 0 ? '{ }' : `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''}}`;
  }
  return parsePrimaryValue(value);
}

export function buildStateDiagnosticSummary({
  variables,
  card,
  schema,
}: {
  variables: any;
  card: CharacterCard | null;
  schema: UiSchema | null;
}): StateDiagnosticSummary {
  const uiCandidates = collectUiSchemaPaths(schema);
  const schemaCandidates = collectStateSchemaPaths(card);
  const rows = uniqueByPath([...uiCandidates, ...schemaCandidates]).map((candidate) => {
    const { resolvedPath, resolution } = resolveDiagnosticPath(candidate.path);
    const value = resolvedPath ? getPathValue(variables, resolvedPath) : variables;
    const exists = hasOwnPath(variables, resolvedPath);
    return {
      ...candidate,
      resolvedPath,
      resolution,
      exists,
      value,
      preview: formatDiagnosticPreview(value, exists),
    };
  });

  const matchedChecks = rows.filter((row) => row.exists).length;
  return {
    totalChecks: rows.length,
    matchedChecks,
    missingChecks: rows.length - matchedChecks,
    rows,
  };
}

function collectObjectPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const rows: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    rows.push(path);
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      rows.push(...collectObjectPaths(child, path));
    }
  }
  return rows;
}

function scorePathSimilarity(target: string, candidate: string): number {
  const targetParts = target.split('.').filter(Boolean);
  const candidateParts = candidate.split('.').filter(Boolean);
  let score = 0;

  for (let i = 0; i < Math.min(targetParts.length, candidateParts.length); i += 1) {
    if (targetParts[i] === candidateParts[i]) {
      score += 3;
    }
  }

  if (candidate.endsWith(targetParts[targetParts.length - 1] || '')) {
    score += 2;
  }

  for (const part of targetParts) {
    if (candidateParts.includes(part)) score += 1;
  }

  return score;
}

export function findClosestStatePaths(variables: any, targetPath: string, limit = 3): string[] {
  const { resolvedPath } = resolveDiagnosticPath(targetPath);
  const candidates = collectObjectPaths(variables);
  return candidates
    .map((candidate) => ({ candidate, score: scorePathSimilarity(resolvedPath || targetPath, candidate) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function summarizeStateContract(card: CharacterCard | null): {
  packageStateFields: number;
  writableMappings: number;
  readMappings: number;
  warnings: string[];
} {
  const pkg: ConclaveCardPackage | null | undefined = card?.conclave_package;
  return {
    packageStateFields: pkg?.state_schema?.fields?.length || 0,
    writableMappings: pkg?.state_adapter?.write_rules?.length || 0,
    readMappings: pkg?.state_adapter?.read_rules?.length || 0,
    warnings: pkg?.state_adapter?.warnings || [],
  };
}

function isAliasRootPath(path: string): boolean {
  return PROJECTION_ALIAS_PREFIXES.includes(String(path || '').trim());
}

function isLeafLikePath(path: string): boolean {
  const trimmed = String(path || '').trim();
  if (!trimmed) return false;
  if (isAliasRootPath(trimmed)) return false;
  return trimmed.includes('.');
}

function collectLeafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value) || value == null || typeof value !== 'object') {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return prefix ? [prefix] : [];
  }
  return entries.flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return collectLeafPaths(child, path);
  });
}

export function assessStateContractQuality({
  card,
  variables,
  stateDiagnostic,
}: {
  card: CharacterCard | null;
  variables: any;
  stateDiagnostic: StateDiagnosticSummary;
}): StateContractQuality {
  const base = summarizeStateContract(card);
  const fields = card?.conclave_package?.state_schema?.fields || [];
  const aliasRootFields = fields
    .map((field) => String(field.path || '').trim())
    .filter((path) => isAliasRootPath(path));
  const declaredLeafLikeFields = fields.filter((field) => isLeafLikePath(field.path)).length;
  const runtimeLeafPaths = collectLeafPaths(variables).length;
  const diagnosableLeafFields = stateDiagnostic.rows.filter((row) => row.resolvedPath.includes('.')).length;
  const rootOnlySchema = fields.length > 0 && declaredLeafLikeFields === 0;
  const canVerifyFineGrainedBindings =
    declaredLeafLikeFields > 0 || base.readMappings > 0 || base.writableMappings > 0;

  const issues: string[] = [];
  if (rootOnlySchema) {
    issues.push('state_schema 只有根级声明，缺少细粒度字段路径。');
  }
  if (aliasRootFields.length > 0) {
    issues.push(`state_schema 使用运行时别名根: ${aliasRootFields.join(', ')}。`);
  }
  if (base.readMappings === 0 && base.writableMappings === 0) {
    issues.push('state_adapter 没有 read/write mappings。');
  }
  if (!canVerifyFineGrainedBindings) {
    issues.push('当前契约无法验证具体 UI 控件到状态叶子路径的绑定。');
  }
  if (runtimeLeafPaths > 0 && declaredLeafLikeFields === 0) {
    issues.push(`运行时已有 ${runtimeLeafPaths} 个叶子路径，但契约未显式声明。`);
  }

  return {
    ...base,
    rootOnlySchema,
    aliasRootFields,
    declaredLeafLikeFields,
    runtimeLeafPaths,
    diagnosableLeafFields,
    canVerifyFineGrainedBindings,
    issues,
  };
}

export function explainStateDiagnostic({
  card,
  variables,
  stateDiagnostic,
  contractQuality,
}: {
  card: CharacterCard | null;
  variables: any;
  stateDiagnostic: StateDiagnosticSummary;
  contractQuality: StateContractQuality;
}): StateExplainabilityIssue[] {
  const fields = card?.conclave_package?.state_schema?.fields || [];
  const extractionSignals = card?.conclave_package?.extraction_layers?.state_signals || [];
  const issues: StateExplainabilityIssue[] = [];

  if (contractQuality.rootOnlySchema) {
    issues.push({
      kind: 'schema_too_coarse',
      title: '契约只有根级声明',
      detail: 'state_schema 目前只有根级或结构级路径，缺少叶子字段，所以调试台只能验证“根对象存在”，不能解释具体数值控件为什么没读到。',
    });
  }

  for (const row of stateDiagnostic.rows) {
    const field = fields.find((item) => item.path === row.path);
    const signal = extractionSignals.find((item) => item.path === row.path);
    const closestPaths = findClosestStatePaths(variables, row.path);

    if (row.exists) {
      if (field && !field.writable) {
        issues.push({
          kind: 'read_only_field',
          title: '字段已命中，但不是可写字段',
          detail: `${row.path} 当前能从运行时读到，但契约把它标成 ${field.role} / read-only，State Agent 不会主动写它。`,
          path: row.path,
          canonicalPath: field.canonical_path,
        });
      }
      continue;
    }

    if (!field && signal?.kind === 'runtime_root') {
      issues.push({
        kind: 'card_private_runtime',
        title: '信号停留在卡私有运行时',
        detail: `${row.path} 只在导入信号层被识别为卡片自己的运行时根，还没有进入正式 state_schema。`,
        path: row.path,
      });
      continue;
    }

    if (field && !field.canonical_path) {
      issues.push({
        kind: 'missing_canonical_mapping',
        title: '字段已声明，但没有 canonical 映射',
        detail: `${row.path} 已进入 state_schema，但仍属于 custom/manual review，调试台无法把它对齐到平台字段语义。`,
        path: row.path,
      });
      continue;
    }

    if (contractQuality.aliasRootFields.includes(row.path)) {
      issues.push({
        kind: 'alias_root_only',
        title: '这里只声明了 alias 根',
        detail: `${row.path} 是运行时别名根，不是具体叶子字段。根对象命中并不能证明具体数值路径已经绑定。`,
        path: row.path,
      });
      continue;
    }

    if (closestPaths.length > 0) {
      issues.push({
        kind: 'closest_match_only',
        title: '运行时存在近似路径，但未精确命中',
        detail: `${row.path} 没有命中，不过运行时里有相近叶子路径，通常说明契约路径声明和实际变量结构还没对齐。`,
        path: row.path,
        closestPaths,
      });
      continue;
    }

    issues.push({
      kind: 'missing_runtime_value',
      title: '契约路径未在当前运行时出现',
      detail: `${row.path} 在当前 sessionState.variables 中不存在，可能是 opening/initvar 没初始化，或对应 UI/脚本分支本轮没跑到。`,
      path: row.path,
      canonicalPath: field?.canonical_path,
    });
  }

  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.kind}:${issue.path || issue.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
