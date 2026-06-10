import React, { useMemo, useState } from 'react';
import type {
  ConclaveCardPackage,
  ExtractedSignal,
  StateFieldDeclaration,
} from '../../api/types';
import PaginationControls, { paginateSlice, totalPagesOf } from './PaginationControls';

type ContractQuality = {
  extractedStateSignals: number;
  schemaFields: number;
  mappedFields: number;
  writableFields: number;
  readRules: number;
  writeRules: number;
  manualReviewFields: number;
  adoptionRate: number;
  issues: string[];
};

type UnadoptedGroup = {
  id: string;
  title: string;
  reason: string;
  signals: ExtractedSignal[];
};

function buildContractQuality(packageDraft: ConclaveCardPackage): ContractQuality {
  const stateSignals = packageDraft.extraction_layers.state_signals;
  const fields = packageDraft.state_schema.fields;
  const mappedFields = fields.filter((field) => Boolean(field.canonical_path)).length;
  const writableFields = fields.filter((field) => field.writable).length;
  const manualReviewFields = fields.filter((field) => !field.canonical_path).length;
  const readRules = packageDraft.state_adapter.read_rules.length;
  const writeRules = packageDraft.state_adapter.write_rules.length;
  const adoptionRate = stateSignals.length > 0 ? mappedFields / stateSignals.length : 0;
  const issues = [
    ...packageDraft.state_adapter.warnings,
    ...(stateSignals.length === 0 ? ['没有状态信号，解析器无法形成 state_schema 草案。'] : []),
    ...(fields.length === 0 ? ['没有 state_schema 字段，说明信号尚未进入契约层。'] : []),
    ...(fields.length > 0 && mappedFields === 0 ? ['state_schema 存在，但尚未匹配到平台字段。'] : []),
    ...(writableFields > 0 && writeRules === 0 ? ['存在可写字段，但没有 write_rules。'] : []),
  ];

  return {
    extractedStateSignals: stateSignals.length,
    schemaFields: fields.length,
    mappedFields,
    writableFields,
    readRules,
    writeRules,
    manualReviewFields,
    adoptionRate,
    issues,
  };
}

function findSupportingSignals(field: StateFieldDeclaration, signals: ExtractedSignal[]) {
  return signals.filter((signal) => signal.path === field.path);
}

function categorizeUnadoptedSignals(packageDraft: ConclaveCardPackage): UnadoptedGroup[] {
  const mappedPaths = new Set(
    packageDraft.state_schema.fields
      .filter((field) => Boolean(field.canonical_path))
      .map((field) => field.path),
  );
  const remaining = packageDraft.extraction_layers.state_signals.filter((signal) => {
    if (!signal.path) return true;
    return !mappedPaths.has(signal.path);
  });

  const groups: UnadoptedGroup[] = [
    {
      id: 'runtime-root',
      title: '运行时私有根',
      reason: '这类信号说明卡片内部维护了自己的运行时状态根，但还没有稳定映射到平台 canonical schema。',
      signals: remaining.filter((signal) => {
        const details = signal.details && !Array.isArray(signal.details)
          ? signal.details as Record<string, unknown>
          : null;
        return signal.kind === 'runtime_root'
          || details?.source_kind === 'bundled_state'
          || details?.source_kind === 'tavern_helper_script';
      }),
    },
    {
      id: 'custom-state',
      title: '卡私有状态',
      reason: '导入器知道这些是状态字段，但还没有足够平台语义来判断它们属于 world/character/relationship 等哪一类。',
      signals: remaining.filter((signal) => {
        const details = signal.details && !Array.isArray(signal.details)
          ? signal.details as Record<string, unknown>
          : null;
        return signal.kind === 'state_schema_path'
          && details?.root !== 'stat_data'
          && details?.source_kind !== 'bundled_state'
          && details?.source_kind !== 'tavern_helper_script';
      }),
    },
    {
      id: 'schema-root-only',
      title: '仅根级/结构级信号',
      reason: '这类信号表明脚本声明了状态容器或对象层，但还没有提供足够细的叶子字段绑定。',
      signals: remaining.filter((signal) => {
        const details = signal.details && !Array.isArray(signal.details)
          ? signal.details as Record<string, unknown>
          : null;
        return Boolean(details?.is_schema_root)
          || (typeof details?.path_depth === 'number' && details.path_depth <= 2);
      }),
    },
  ];

  const groupedIds = new Set(groups.flatMap((group) => group.signals.map((signal) => signal.id)));
  const otherSignals = remaining.filter((signal) => !groupedIds.has(signal.id));
  if (otherSignals.length > 0) {
    groups.push({
      id: 'other',
      title: '其他未采纳信号',
      reason: '这些信号已经被保留，但当前分类器还没给出更细的落地原因。',
      signals: otherSignals,
    });
  }

  return groups.filter((group) => group.signals.length > 0);
}

export function ContractWorkbench({ packageDraft }: { packageDraft: ConclaveCardPackage }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const quality = useMemo(() => buildContractQuality(packageDraft), [packageDraft]);
  const unadoptedGroups = useMemo(() => categorizeUnadoptedSignals(packageDraft), [packageDraft]);
  const stateSignals = packageDraft.extraction_layers.state_signals;
  const schemaFields = packageDraft.state_schema.fields;
  const totalPages = totalPagesOf(schemaFields.length, pageSize);
  const pageItems = useMemo(
    () => paginateSlice(schemaFields, page, pageSize),
    [schemaFields, page, pageSize],
  );

  return (
    <section className="contract-workbench">
      <div className="package-section-heading">
        <h4>角色卡解析器</h4>
        <span className="signal-count">signal → schema → adapter</span>
      </div>

      <p className="signal-overview">
        这一层展示原始状态信号是如何被采纳为平台契约草案的。导入器先保留信号，解析器再决定哪些字段能稳定进入统一运行时。
      </p>

      <div className="contract-quality-grid">
        <div className="summary-item">
          <span className="summary-label">状态信号</span>
          <span className="summary-value">{quality.extractedStateSignals}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">契约字段</span>
          <span className="summary-value">{quality.schemaFields}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">已映射字段</span>
          <span className="summary-value">{quality.mappedFields}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">写入规则</span>
          <span className="summary-value">{quality.writeRules}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">人工审查</span>
          <span className="summary-value">{quality.manualReviewFields}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">采纳率</span>
          <span className="summary-value">{(quality.adoptionRate * 100).toFixed(0)}%</span>
        </div>
      </div>

      {quality.issues.length > 0 && (
        <div className="contract-issues">
          <div className="package-section-heading">
            <h5>契约质量</h5>
            <span className="signal-count">{quality.issues.length} 项</span>
          </div>
          <div className="impact-list">
            {quality.issues.map((issue) => (
              <div key={issue} className="impact-item impact-warn">
                <strong>注意</strong>
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {unadoptedGroups.length > 0 && (
        <div className="contract-issues">
          <div className="package-section-heading">
            <h5>未采纳原因</h5>
            <span className="signal-count">
              {unadoptedGroups.reduce((sum, group) => sum + group.signals.length, 0)} 条
            </span>
          </div>
          <div className="contract-unadopted-groups">
            {unadoptedGroups.map((group) => (
              <div key={group.id} className="contract-unadopted-card">
                <div className="package-section-heading">
                  <h5>{group.title}</h5>
                  <span className="signal-count">{group.signals.length} 条</span>
                </div>
                <p className="signal-overview">{group.reason}</p>
                <div className="contract-supporting-signals">
                  {group.signals.slice(0, 10).map((signal) => (
                    <div key={signal.id} className="contract-support-chip" title={signal.path || signal.label || signal.id}>
                      {signal.path || signal.label || signal.id}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="contract-table">
        <div className="package-section-heading">
          <h5>字段采纳表</h5>
          <span className="signal-count">{schemaFields.length} 字段</span>
        </div>
        {pageItems.length > 0 ? (
          <div className="contract-field-list">
            {pageItems.map((field) => {
              const supportingSignals = findSupportingSignals(field, stateSignals);
              return (
                <div key={field.path} className="contract-field-card">
                  <div className="contract-field-head">
                    <code className="signal-path" title={field.path}>{field.path}</code>
                    <span className="signal-kind">{field.role}</span>
                    <span className="signal-confidence">{(field.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <div className="contract-field-meta">
                    <span className="contract-field-type">{field.type}</span>
                    <span className="contract-field-source">{field.source}</span>
                    <span className={`contract-field-write ${field.writable ? 'is-write' : 'is-readonly'}`}>
                      {field.writable ? 'writable' : 'read_only'}
                    </span>
                  </div>
                  <div className="contract-field-mapping">
                    <span className="summary-label">canonical</span>
                    <code className="signal-default">
                      {field.canonical_path || 'manual_review'}
                    </code>
                  </div>
                  {supportingSignals.length > 0 && (
                    <div className="contract-supporting-signals">
                      {supportingSignals.map((signal) => (
                        <div key={signal.id} className="contract-support-chip">
                          {signal.label || signal.source}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="api-mapping-empty">当前没有可展示的契约字段。</div>
        )}
        <PaginationControls
          currentPage={page}
          totalPages={totalPages}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          totalItems={schemaFields.length}
          itemLabel="字段"
        />
      </div>
    </section>
  );
}
