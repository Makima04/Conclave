import React, { useState, useMemo, useCallback } from 'react';
import type { RuleTrace } from '../../api/types';
import PaginationControls, { paginateSlice, totalPagesOf } from './PaginationControls';

export function RuleTracePanel({ traces }: { traces: RuleTrace[] }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const total = traces.length;
  const tp = totalPagesOf(total, pageSize);
  const pageItems = useMemo(() => paginateSlice(traces, page, pageSize), [traces, page, pageSize]);

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

  if (total === 0) return null;

  return (
    <div className="rule-trace-panel" id="section-rule-traces">
      <h3>规则命中</h3>
      {pageItems.map(trace => (
        <div key={trace.rule_id} className={`rule-trace rule-${trace.status}`}>
          <div className="rule-header" onClick={() => toggle(trace.rule_id)}>
            <span className={`rule-badge badge-${trace.status}`}>{trace.status}</span>
            <span className="rule-id" title={trace.rule_id}>{trace.rule_id}</span>
            <span className="rule-stage">{trace.stage}</span>
            <span className="rule-confidence">{Math.round(trace.confidence * 100)}%</span>
          </div>
          {expanded.has(trace.rule_id) && (
            <div className="rule-details">
              {trace.input_ref && (
                <div className="rule-ref">
                  <strong>Input:</strong> <code title={trace.input_ref}>{trace.input_ref}</code>
                </div>
              )}
              {trace.output_ref && (
                <div className="rule-ref">
                  <strong>Output:</strong> <code title={trace.output_ref}>{trace.output_ref}</code>
                </div>
              )}
              {trace.diagnostics.length > 0 && (
                <ul className="rule-diagnostics">
                  {trace.diagnostics.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
      <PaginationControls
        currentPage={page}
        totalPages={tp}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={handlePageSizeChange}
        totalItems={total}
        itemLabel="规则命中"
      />
    </div>
  );
}
