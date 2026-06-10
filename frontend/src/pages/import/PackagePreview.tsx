import React, { useState, useMemo, useCallback } from 'react';
import type {
  ApiCompatibilityMapping,
  CompatibilityReport,
  ConclaveCardPackage,
  ExtractedSignal,
} from '../../api/types';
import PaginationControls, { paginateSlice, totalPagesOf } from './PaginationControls';

const API_MAPPING_CATALOG: Record<string, ApiCompatibilityMapping> = {
  Generate: {
    api: 'Generate',
    status: 'bridged',
    replacement: 'submitText -> main chat pipeline',
    notes: '角色卡输入会走主消息链路，并把最终消息同步回角色卡 UI。',
  },
  generate: {
    api: 'generate',
    status: 'bridged',
    replacement: 'submitText -> main chat pipeline',
    notes: '兼容小写调用形式，最终仍进入主消息链路。',
  },
  submitText: {
    api: 'submitText',
    status: 'bridged',
    replacement: 'main chat pipeline',
    notes: '平台原生主消息提交入口。',
  },
  generateRaw: {
    api: 'generateRaw',
    status: 'partial',
    replacement: 'quietGenerate host RPC',
    notes: '后台分析生成会走平台 quiet-generation；可见发送仍应走主消息链路。',
  },
  getVariables: {
    api: 'getVariables',
    status: 'bridged',
    replacement: 'platform runtime variables',
    notes: '读取平台运行时变量桥。',
  },
  getAllVariables: {
    api: 'getAllVariables',
    status: 'bridged',
    replacement: 'platform runtime variables',
    notes: '读取完整平台运行时变量快照。',
  },
  setVariables: {
    api: 'setVariables',
    status: 'bridged',
    replacement: 'platform state bridge',
    notes: '写入会通过平台状态桥接层处理。',
  },
  updateVariablesWith: {
    api: 'updateVariablesWith',
    status: 'bridged',
    replacement: 'platform state bridge',
    notes: '变量更新会接到平台状态桥，不再由卡片私有链路落库。',
  },
  replaceMvuData: {
    api: 'replaceMvuData',
    status: 'bridged',
    replacement: 'platform state bridge',
    notes: 'MVU 数据替换会通过平台状态桥转换。',
  },
  setChatMessage: {
    api: 'setChatMessage',
    status: 'bridged',
    replacement: 'message/opening bridge',
    notes: '聊天消息写入会映射到平台消息或开场白桥。',
  },
  setChatMessages: {
    api: 'setChatMessages',
    status: 'bridged',
    replacement: 'message/opening bridge',
    notes: '批量聊天消息写入会映射到平台消息或开场白桥。',
  },
  eventOn: {
    api: 'eventOn',
    status: 'partial',
    replacement: 'runtime event shim',
    notes: '提供有限事件兼容，不保证 SillyTavern 全事件语义。',
  },
  eventOnce: {
    api: 'eventOnce',
    status: 'partial',
    replacement: 'runtime event shim',
    notes: '提供有限一次性事件兼容。',
  },
  eventRemoveListener: {
    api: 'eventRemoveListener',
    status: 'partial',
    replacement: 'runtime event shim',
    notes: '提供有限事件解绑兼容。',
  },
  innerHTML: {
    api: 'innerHTML',
    status: 'review',
    replacement: 'sandboxed DOM write',
    notes: '危险 DOM 写入会留在沙盒内执行，保存前建议人工审核。',
  },
};

const normalizeApi = (api: string) => api.replace(/\(\)$/u, '').trim();

function deriveApiMappings(compatibility: CompatibilityReport) {
  const backendMappings = compatibility.api_mappings || [];
  const seen = new Set<string>();
  const mappings: ApiCompatibilityMapping[] = [];

  for (const mapping of backendMappings) {
    const api = normalizeApi(mapping.api);
    if (seen.has(api)) continue;
    seen.add(api);
    mappings.push({ ...mapping, api });
  }

  for (const apiName of [...compatibility.required_apis, ...compatibility.unsupported_apis]) {
    const api = normalizeApi(apiName);
    if (!api || seen.has(api)) continue;
    seen.add(api);
    mappings.push(
      API_MAPPING_CATALOG[api] || {
        api,
        status: compatibility.unsupported_apis.includes(apiName) ? 'unsupported' : 'detected',
        replacement: 'manual review',
        notes: '导入器已检测到该 API，但还没有自动替换规则，需要人工确认。',
      },
    );
  }

  return {
    mappings,
    source: backendMappings.length > 0 ? 'backend' : mappings.length > 0 ? 'fallback' : 'empty',
  };
}

function formatSignalPath(signal: ExtractedSignal) {
  return signal.path || signal.label || signal.id;
}

function formatSignalMeta(signal: ExtractedSignal) {
  const details = signal.details && !Array.isArray(signal.details) ? signal.details as Record<string, unknown> : null;
  const parts: string[] = [];
  if (details?.source_kind && typeof details.source_kind === 'string') parts.push(details.source_kind);
  if (details?.type && typeof details.type === 'string') parts.push(details.type);
  if (details?.root && typeof details.root === 'string') parts.push(`root:${details.root}`);
  if (details?.path_depth && typeof details.path_depth === 'number') parts.push(`depth:${details.path_depth}`);
  if (details?.selector && typeof details.selector === 'string') parts.push(details.selector);
  return parts.join(' · ');
}

function SignalSection({
  title,
  signals,
  emptyText,
}: {
  title: string;
  signals: ExtractedSignal[];
  emptyText: string;
}) {
  return (
    <div className="signal-section">
      <div className="package-section-heading">
        <h5>{title}</h5>
        <span className="signal-count">{signals.length} 条</span>
      </div>
      {signals.length > 0 ? (
        <div className="signal-list">
          {signals.map(signal => {
            const meta = formatSignalMeta(signal);
            const details = signal.details && !Array.isArray(signal.details)
              ? signal.details as Record<string, unknown>
              : null;
            return (
              <div key={signal.id} className="signal-item">
                <div className="signal-main">
                  <code className="signal-path" title={formatSignalPath(signal)}>{formatSignalPath(signal)}</code>
                  <span className="signal-kind">{signal.kind}</span>
                  <span className="signal-confidence">{(signal.confidence * 100).toFixed(0)}%</span>
                </div>
                <div className="signal-sub">
                  <span className="signal-source" title={signal.source}>{signal.label || signal.source}</span>
                  {meta && <span className="signal-meta">{meta}</span>}
                </div>
                {(signal.excerpt || details?.default_value !== undefined) && (
                  <div className="signal-detail-line">
                    {details?.default_value !== undefined && (
                      <code className="signal-default" title={JSON.stringify(details.default_value)}>
                        default={JSON.stringify(details.default_value)}
                      </code>
                    )}
                    {signal.excerpt && <span className="signal-excerpt" title={signal.excerpt}>{signal.excerpt}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="api-mapping-empty">{emptyText}</div>
      )}
    </div>
  );
}

export function PackagePreview({ packageDraft }: { packageDraft: ConclaveCardPackage }) {
  const [showJson, setShowJson] = useState(false);
  const [actionPage, setActionPage] = useState(1);
  const [actionPageSize, setActionPageSize] = useState(10);

  const unsupportedCount = packageDraft.compatibility.unsupported_apis.length;
  const warningCount = packageDraft.compatibility.warnings.length;
  const { mappings: apiMappings, source: apiMappingSource } = deriveApiMappings(packageDraft.compatibility);
  const stateFields = packageDraft.state_schema?.fields || [];
  const stateAdapter = packageDraft.state_adapter;
  const extractionLayers = packageDraft.extraction_layers;
  const writableStateFields = stateFields.filter(field => field.writable).length;
  const mappedStateFields = stateFields.filter(field => field.canonical_path).length;
  const stateAdapterWarnings = stateAdapter?.warnings?.length || 0;

  const actions = packageDraft.actions;
  const actionTotal = actions.length;
  const actionTp = totalPagesOf(actionTotal, actionPageSize);
  const actionPageItems = useMemo(
    () => paginateSlice(actions, actionPage, actionPageSize),
    [actions, actionPage, actionPageSize],
  );

  const handleActionPageSizeChange = useCallback((size: number) => {
    setActionPageSize(size);
    setActionPage(1);
  }, []);

  const runtimeReadiness = useMemo(() => {
    if (packageDraft.ui.type === 'raw_preview' || unsupportedCount > 0) {
      return {
        tone: 'limited',
        label: '仅适合原始预览或人工兜底',
        detail: '当前草案还不能稳定映射到平台运行时，保存前建议先审诊断和 API 映射。',
      };
    }

    if (
      warningCount > 0 ||
      stateAdapterWarnings > 0 ||
      packageDraft.variables.length === 0 ||
      stateFields.length === 0
    ) {
      return {
        tone: 'partial',
        label: '可渲染，但运行时能力不完整',
        detail: '基础 UI 多半可展示，但变量桥、状态映射或行为兼容仍需要补齐。',
      };
    }

    return {
      tone: 'ready',
      label: '已接近平台运行时模型',
      detail: 'UI、变量与状态映射都已形成草案，保存后更接近最终渲染行为。',
    };
  }, [
    packageDraft.ui.type,
    packageDraft.variables.length,
    stateFields.length,
    stateAdapterWarnings,
    unsupportedCount,
    warningCount,
  ]);

  return (
    <div className="package-preview" id="section-package-draft">
      <div className="package-header">
        <h3>卡包草案</h3>
        <button onClick={() => setShowJson(!showJson)} className="btn-toggle-json">
          {showJson ? '收起 JSON' : '展开 JSON'}
        </button>
      </div>

      <div className={`runtime-readiness readiness-${runtimeReadiness.tone}`}>
        <div className="runtime-readiness-label">运行时就绪度</div>
        <div className="runtime-readiness-main">{runtimeReadiness.label}</div>
        <p>{runtimeReadiness.detail}</p>
      </div>

      {/* Summary - always visible at top */}
      <div className="package-summary">
        <div className="summary-item">
          <span className="summary-label">名称</span>
          <span className="summary-value">{packageDraft.manifest.name}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">UI 类型</span>
          <span className={`ui-type-badge type-${packageDraft.ui.type}`}>
            {packageDraft.ui.type}
          </span>
        </div>
        <div className="summary-item">
          <span className="summary-label">开场白</span>
          <span className="summary-value">{packageDraft.greetings.length} 个</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">变量</span>
          <span className="summary-value">{packageDraft.variables.length} 个</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">状态转换</span>
          <span className="summary-value">
            {stateFields.length > 0
              ? `${mappedStateFields}/${stateFields.length} 已映射`
              : '未检测'}
          </span>
        </div>
        <div className="summary-item">
          <span className="summary-label">提取信号</span>
          <span className="summary-value">
            {extractionLayers.state_signals.length + extractionLayers.ui_signals.length + extractionLayers.action_signals.length}
            {' '}个
          </span>
        </div>
        <div className="summary-item">
          <span className="summary-label">动作</span>
          <span className="summary-value">{packageDraft.actions.length} 个</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">API 映射</span>
          <span className="summary-value">{apiMappings.length} 条</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">兼容性</span>
          <span className="summary-value">
            {unsupportedCount > 0
              ? `${unsupportedCount} 不支持`
              : warningCount > 0
                ? `${warningCount} 个警告`
                : '无问题'}
          </span>
        </div>
        <div className="summary-item">
          <span className="summary-label">运行时提示</span>
          <span className="summary-value">
            {packageDraft.runtime_hints.st_regex_scripts_present ? '含 ST Regex' : '无 ST Regex'} · {packageDraft.runtime_hints.raw_opening_full_document ? '整页 HTML' : '片段/文本'}
          </span>
        </div>
      </div>

      {/* Greetings preview */}
      {packageDraft.greetings.length > 0 && (
        <div className="package-greetings">
          <h4>开场白</h4>
          {packageDraft.greetings.map(g => (
            <div key={g.id} className="greeting-item">
              <span className="greeting-label">{g.label}</span>
              <span className="greeting-preview" title={g.content}>
                {g.content.slice(0, 200)}
                {g.content.length > 200 ? '...' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="package-api-mappings">
        <div className="package-section-heading">
          <h4>API 映射</h4>
          <span className={`api-map-source source-${apiMappingSource}`}>
            {apiMappingSource === 'backend'
              ? '后端检测'
              : apiMappingSource === 'fallback'
                ? '前端兜底'
                : '未检测'}
          </span>
        </div>
        {apiMappings.length > 0 ? (
          apiMappings.map(mapping => (
            <div key={`${mapping.api}-${mapping.replacement}`} className="api-mapping-item">
              <span className={`api-map-status status-${mapping.status}`}>{mapping.status}</span>
              <code className="api-map-name">{mapping.api}</code>
              <span className="api-map-arrow">→</span>
              <span className="api-map-target" title={mapping.notes}>{mapping.replacement}</span>
            </div>
          ))
        ) : (
          <div className="api-mapping-empty">
            未检测到可桥接 API。若诊断信息里已有 generateRaw/getVariables 等条目，请重新解析或重启后端后再查看。
          </div>
        )}
      </div>

      {(extractionLayers.state_signals.length > 0
        || extractionLayers.ui_signals.length > 0
        || extractionLayers.action_signals.length > 0
        || extractionLayers.unresolved_signals.length > 0) && (
        <div className="package-variables">
          <h4>提取信号层</h4>
          <p className="signal-overview">
            导入器先保留原始可分析信号，再由后续解析器和运行时决定哪些进入正式契约。
          </p>
          <SignalSection
            title="状态信号"
            signals={extractionLayers.state_signals}
            emptyText="没有提取到状态路径。"
          />
          <SignalSection
            title="UI 信号"
            signals={extractionLayers.ui_signals}
            emptyText="没有提取到 UI 依赖。"
          />
          <SignalSection
            title="动作信号"
            signals={extractionLayers.action_signals}
            emptyText="没有提取到动作提示。"
          />
          <SignalSection
            title="未解析信号"
            signals={extractionLayers.unresolved_signals}
            emptyText="当前没有未解析信号。"
          />
          <details className="package-json">
            <summary>查看提取信号详情</summary>
            <pre>{JSON.stringify(extractionLayers, null, 2)}</pre>
          </details>
        </div>
      )}

      {/* Actions - paginated */}
      {actionTotal > 0 && (
        <div className="package-actions">
          <h4>动作</h4>
          {actionPageItems.map(a => (
            <div key={a.id} className="action-item">
              <span className={`action-kind kind-${a.kind}`}>{a.kind}</span>
              <span className="action-label" title={a.label}>{a.label}</span>
              {a.selector && <code className="action-selector" title={a.selector}>{a.selector}</code>}
            </div>
          ))}
          <PaginationControls
            currentPage={actionPage}
            totalPages={actionTp}
            pageSize={actionPageSize}
            onPageChange={setActionPage}
            onPageSizeChange={handleActionPageSizeChange}
            totalItems={actionTotal}
            itemLabel="动作"
          />
        </div>
      )}

      {/* State adapter preview */}
      {stateFields.length > 0 && (
        <div className="package-variables">
          <h4>状态转换层</h4>
          <div className="variable-item">
            <span className="var-type">adapter</span>
            <code className="var-path">{stateAdapter?.adapter_version || 'unknown'}</code>
            <span className="var-label">
              {writableStateFields} 可写 · {stateAdapter?.write_rules?.length || 0} 写入规则
            </span>
          </div>
          {stateFields.slice(0, 12).map(field => (
            <div key={field.path} className="variable-item">
              <code className="var-path" title={field.path}>{field.path}</code>
              <span className="var-type">{field.role}</span>
              <span className="var-label" title={field.canonical_path || '需要人工确认'}>
                {field.canonical_path || 'manual_review'}
              </span>
            </div>
          ))}
          {stateFields.length > 12 && (
            <div className="variable-item">
              <span className="var-label">还有 {stateFields.length - 12} 个字段，请展开 JSON 审核完整 state_schema。</span>
            </div>
          )}
        </div>
      )}

      {/* Variables preview */}
      {packageDraft.variables.length > 0 && (
        <div className="package-variables">
          <h4>变量</h4>
          {packageDraft.variables.map(v => (
            <div key={v.path} className="variable-item">
              <code className="var-path" title={v.path}>{v.path}</code>
              <span className="var-type">{v.type}</span>
              {v.label && <span className="var-label" title={v.label}>{v.label}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Full JSON */}
      {showJson && (
        <pre className="package-json">
          {JSON.stringify(packageDraft, null, 2)}
        </pre>
      )}
    </div>
  );
}
