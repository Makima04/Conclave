import React from 'react';

export interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
  totalItems?: number;
  itemLabel?: string;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 30];

export default function PaginationControls({
  currentPage,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  totalItems,
  itemLabel,
}: PaginationControlsProps) {
  if (totalPages <= 1 && (!totalItems || totalItems <= pageSize)) {
    return null;
  }

  return (
    <div className="iw-pagination">
      <div className="iw-pagination-info">
        {totalItems != null && itemLabel && (
          <span className="iw-pagination-total">
            {itemLabel} {totalItems} 条
          </span>
        )}
        <label className="iw-page-size-label">
          每页
          <select
            className="iw-page-size-select"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          条
        </label>
      </div>
      <div className="iw-pagination-nav">
        <button
          className="iw-page-btn"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          上一页
        </button>
        <span className="iw-page-indicator">
          {currentPage} / {totalPages}
        </span>
        <button
          className="iw-page-btn"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

/** Given an array, return the slice for the current page (1-indexed). */
export function paginateSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** Compute total pages from item count and page size. */
export function totalPagesOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
