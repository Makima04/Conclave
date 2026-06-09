import React, { useState, useMemo, useCallback } from 'react';
import type { ImportDiagnostic } from '../../api/types';
import PaginationControls, { paginateSlice, totalPagesOf } from './PaginationControls';

const levelIcons: Record<string, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '🔴',
};

const levelLabels: Record<string, string> = {
  info: '信息',
  warn: '警告',
  error: '错误',
};

const LEVEL_ORDER: ImportDiagnostic['level'][] = ['error', 'warn', 'info'];

function buildClipboardText(diagnostics: ImportDiagnostic[], counts: Record<string, number>) {
  const lines = [
    `诊断汇总: 错误 ${counts.error} / 警告 ${counts.warn} / 信息 ${counts.info}`,
    `总计: ${diagnostics.length}`,
    '',
  ];

  diagnostics.forEach((diag, index) => {
    lines.push(`[${index + 1}] ${levelLabels[diag.level]} | ${diag.code} | ${diag.stage}`);
    lines.push(diag.message);
    if (diag.source?.script_name || diag.source?.kind) {
      lines.push(`来源: ${diag.source.script_name || diag.source.kind}`);
    }
    if (diag.source?.offset != null) {
      lines.push(`Offset: ${diag.source.offset}`);
    }
    if (diag.source?.excerpt) {
      lines.push(`Excerpt: ${diag.source.excerpt}`);
    }
    if (diag.impact) {
      lines.push(`影响: ${diag.impact}`);
    }
    if (diag.suggestion) {
      lines.push(`建议: ${diag.suggestion}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

export function DiagnosticsPanel({ diagnostics }: { diagnostics: ImportDiagnostic[] }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  // Sort: errors first, then warns, then infos
  const sorted = useMemo(() => {
    return [...diagnostics].sort((a, b) => {
      const ai = LEVEL_ORDER.indexOf(a.level);
      const bi = LEVEL_ORDER.indexOf(b.level);
      return ai - bi;
    });
  }, [diagnostics]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { error: 0, warn: 0, info: 0 };
    for (const d of diagnostics) c[d.level]++;
    return c;
  }, [diagnostics]);

  const exportJson = useMemo(
    () =>
      JSON.stringify(
        {
          summary: counts,
          total: diagnostics.length,
          diagnostics,
        },
        null,
        2,
      ),
    [counts, diagnostics],
  );

  const total = sorted.length;
  const tp = totalPagesOf(total, pageSize);
  const pageItems = useMemo(() => paginateSlice(sorted, page, pageSize), [sorted, page, pageSize]);

  const handlePageSizeChange = useCallback((size: number) => {
    setPageSize(size);
    setPage(1);
    setExpanded(new Set());
  }, []);

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildClipboardText(sorted, counts));
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1800);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 2200);
    }
  }, [counts, sorted]);

  const handleDownloadJson = useCallback(() => {
    const blob = new Blob([exportJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `import-diagnostics-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [exportJson]);

  return (
    <div className="diagnostics-panel" id="section-diagnostics">
      <div className="diagnostics-toolbar">
        <h3>
          诊断信息
          <span className="iw-diag-counts">
            {counts.error > 0 && <span className="iw-diag-badge error">错误 {counts.error}</span>}
            {counts.warn > 0 && <span className="iw-diag-badge warn">警告 {counts.warn}</span>}
            {counts.info > 0 && <span className="iw-diag-badge info">信息 {counts.info}</span>}
          </span>
        </h3>
        <div className="diagnostics-actions">
          <button type="button" className="btn btn-secondary diagnostics-action-btn" onClick={handleCopy}>
            {copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制给 Codex'}
          </button>
          <button type="button" className="btn btn-secondary diagnostics-action-btn" onClick={handleDownloadJson}>
            导出 JSON
          </button>
        </div>
      </div>
      {pageItems.map(diag => (
        <div
          key={diag.id}
          className={`diagnostic-card card-${diag.level}`}
          onClick={() => toggle(diag.id)}
        >
          <div className="diagnostic-header">
            <span className="diagnostic-code" title={diag.code}>{diag.code}</span>
            <span className="diagnostic-stage">{diag.stage}</span>
          </div>
          <div className="diagnostic-message">{diag.message}</div>
          {expanded.has(diag.id) && (
            <div className="diagnostic-details">
              {diag.source && (
                <div className="source-locator">
                  <div className="source-meta">
                    <span>
                      {'📁'} {diag.source.script_name || diag.source.kind}
                    </span>
                    {diag.source.field && (
                      <span>{'📝'} {diag.source.field}</span>
                    )}
                    {diag.source.offset != null && (
                      <span>{'📍'} offset: {diag.source.offset}</span>
                    )}
                  </div>
                  {diag.source.excerpt && (
                    <pre className="source-excerpt">
                      <code>{diag.source.excerpt}</code>
                    </pre>
                  )}
                </div>
              )}
              {diag.impact && (
                <div className="diagnostic-impact">
                  <strong>影响:</strong> {diag.impact}
                </div>
              )}
              {diag.suggestion && (
                <div className="diagnostic-suggestion">
                  <strong>建议:</strong> {diag.suggestion}
                </div>
              )}
              {diag.rule_id && (
                <div className="diagnostic-rule">关联规则: {diag.rule_id}</div>
              )}
            </div>
          )}
        </div>
      ))}
      {total === 0 && <p className="no-diagnostics">无诊断信息</p>}
      <PaginationControls
        currentPage={page}
        totalPages={tp}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={handlePageSizeChange}
        totalItems={total}
        itemLabel="诊断"
      />
    </div>
  );
}
