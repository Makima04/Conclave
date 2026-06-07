import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Preset, SessionConfig, WorldBook } from '../api/types';

export type NewSessionMode = 'single_agent' | 'multi_agent';

export interface NewSessionDraft {
  mode: NewSessionMode;
  presetId: string;
}

interface NewSessionDialogProps {
  open: boolean;
  worldBook: WorldBook | null;
  presets: Preset[];
  loadingPresets: boolean;
  submitting: boolean;
  defaultConfig: SessionConfig;
  onClose: () => void;
  onSubmit: (draft: NewSessionDraft) => void;
}

export function NewSessionDialog({
  open,
  worldBook,
  presets,
  loadingPresets,
  submitting,
  defaultConfig,
  onClose,
  onSubmit,
}: NewSessionDialogProps) {
  const [mode, setMode] = useState<NewSessionMode>('single_agent');
  const [presetId, setPresetId] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('single_agent');
    setPresetId(defaultConfig.active_preset_id || '');
  }, [open, defaultConfig.active_preset_id]);

  if (!open) return null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ mode, presetId });
  }

  return (
    <div className="new-session-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div className="new-session-head">
            <div>
              <h2 id="new-session-title">新建会话</h2>
              <p>{worldBook ? worldBook.name : '无世界书'}</p>
            </div>
            <button type="button" className="new-session-close" onClick={onClose} aria-label="关闭" disabled={submitting}>
              ×
            </button>
          </div>

          <div className="new-session-field">
            <span className="new-session-label">Agent 模式</span>
            <div className="new-session-segment" role="radiogroup" aria-label="Agent 模式">
              <label className={mode === 'single_agent' ? 'selected' : ''}>
                <input
                  type="radio"
                  name="session-mode"
                  value="single_agent"
                  checked={mode === 'single_agent'}
                  onChange={() => setMode('single_agent')}
                  disabled={submitting}
                />
                <span>Single Agent</span>
              </label>
              <label className={mode === 'multi_agent' ? 'selected' : ''}>
                <input
                  type="radio"
                  name="session-mode"
                  value="multi_agent"
                  checked={mode === 'multi_agent'}
                  onChange={() => setMode('multi_agent')}
                  disabled={submitting}
                />
                <span>Multi Agent</span>
              </label>
            </div>
          </div>

          <label className="new-session-field">
            <span className="new-session-label">预设</span>
            <select value={presetId} onChange={event => setPresetId(event.target.value)} disabled={submitting || loadingPresets}>
              <option value="">不绑定预设</option>
              {presets.map(preset => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.module_count}模块)
                </option>
              ))}
            </select>
          </label>

          <div className="new-session-actions">
            <button type="button" className="new-session-secondary" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="submit" className="new-session-primary" disabled={submitting}>
              {submitting ? '创建中...' : '创建会话'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
