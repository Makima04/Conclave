import React, { useState, useMemo, useCallback } from 'react';
import type { ConclaveCardPackage } from '../../api/types';
import PaginationControls, { paginateSlice, totalPagesOf } from './PaginationControls';

export function PackagePreview({ packageDraft }: { packageDraft: ConclaveCardPackage }) {
  const [showJson, setShowJson] = useState(false);
  const [actionPage, setActionPage] = useState(1);
  const [actionPageSize, setActionPageSize] = useState(10);

  const unsupportedCount = packageDraft.compatibility.unsupported_apis.length;
  const warningCount = packageDraft.compatibility.warnings.length;

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

  return (
    <div className="package-preview" id="section-package-draft">
      <div className="package-header">
        <h3>卡包草案</h3>
        <button onClick={() => setShowJson(!showJson)} className="btn-toggle-json">
          {showJson ? '收起 JSON' : '展开 JSON'}
        </button>
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
          <span className="summary-label">动作</span>
          <span className="summary-value">{packageDraft.actions.length} 个</span>
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
