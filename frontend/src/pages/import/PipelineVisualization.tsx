import React from 'react';
import type { StageResult } from '../../api/types';

const statusIcons: Record<string, string> = {
  success: '✅',
  warning: '⚠️',
  error: '❌',
  skipped: '⏭️',
};

export function PipelineVisualization({ stages }: { stages: StageResult[] }) {
  return (
    <div className="pipeline-viz" id="section-pipeline">
      <h3>导入流水线</h3>
      <div className="pipeline-stages">
        {stages.map(stage => (
          <div key={stage.id} className={`pipeline-stage stage-${stage.status}`}>
            <span className="stage-icon">{statusIcons[stage.status] || '⏳'}</span>
            <span className="stage-name">{stage.name}</span>
            <span className="stage-status">{stage.status}</span>
            {stage.message && <span className="stage-message">{stage.message}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
