import React, { useState, useRef, useEffect } from 'react';
import type { ImportStatus } from '../../api/types';

interface ActionBarProps {
  status: ImportStatus;
  onConfirm: () => void;
  onDegrade: () => void;
  onLlmAssist: (type: string) => void;
  onRawPreview: () => void;
  onSaveFailure: () => void;
  onReparse: () => void;
}

export function ActionBar({
  status,
  onConfirm,
  onDegrade,
  onLlmAssist,
  onRawPreview,
  onSaveFailure,
  onReparse,
}: ActionBarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  return (
    <div className="action-bar">
      <div className="action-group">
        <button onClick={onReparse} className="btn btn-secondary">
          {'🔄'} 重新解析
        </button>
      </div>

      <div className="action-group">
        <div className="dropdown" ref={dropdownRef}>
          <button
            className="btn btn-secondary"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            {'🤖'} LLM 辅助 {'▾'}
          </button>
          {dropdownOpen && (
            <div className="dropdown-menu">
              <button
                onClick={() => {
                  onLlmAssist('explain_actions');
                  setDropdownOpen(false);
                }}
              >
                解释动作
              </button>
              <button
                onClick={() => {
                  onLlmAssist('label_variables');
                  setDropdownOpen(false);
                }}
              >
                标注变量
              </button>
              <button
                onClick={() => {
                  onLlmAssist('summarize_unsupported');
                  setDropdownOpen(false);
                }}
              >
                总结不支持的 API
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="action-group">
        <button onClick={onRawPreview} className="btn btn-secondary">
          {'👁️'} 原始 ST 预览
        </button>
        <button onClick={onSaveFailure} className="btn btn-secondary">
          {'💾'} 保存失败样本
        </button>
      </div>

      <div className="action-group action-primary">
        {status !== 'blocked' && (
          <button onClick={onDegrade} className="btn btn-outline">
            降级为 Schema
          </button>
        )}
        <button
          onClick={onConfirm}
          className="btn btn-primary"
          disabled={status === 'blocked'}
        >
          {'✅'} 保存为平台卡包
        </button>
      </div>
    </div>
  );
}
