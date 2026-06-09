import React from 'react';
import type { StageResult } from '../../api/types';

const statusIcons: Record<string, string> = {
  success: '✅',
  warning: '⚠️',
  error: '❌',
  skipped: '⏭️',
};

const STAGE_GROUPS: Array<{
  id: string;
  label: string;
  description: string;
  stageIds: string[];
}> = [
  {
    id: 'source-extraction',
    label: '原始数据提取',
    description: '只做素材与 ST 原文拆解，不在这里定义最终运行时语义。',
    stageIds: ['metadata', 'regex', 'html_split'],
  },
  {
    id: 'ui-normalization',
    label: 'UI 规范化',
    description: '处理资源与脚本，为后续沙盒容器提供可加载输入。',
    stageIds: ['asset_rewrite', 'js_parse'],
  },
  {
    id: 'runtime-inference',
    label: '运行时推断',
    description: '抽取动作、变量与状态映射，给平台运行时做桥接参考。',
    stageIds: ['action_extract', 'variable_extract', 'state_adapter'],
  },
  {
    id: 'package-assembly',
    label: '卡包装配',
    description: '将草案组装成单一运行时模型，可保存为平台卡包。',
    stageIds: ['package_build'],
  },
];

export function PipelineVisualization({ stages }: { stages: StageResult[] }) {
  const groupedStages = STAGE_GROUPS.map((group) => ({
    ...group,
    stages: group.stageIds
      .map((stageId) => stages.find((stage) => stage.id === stageId))
      .filter((stage): stage is StageResult => Boolean(stage)),
  })).filter((group) => group.stages.length > 0);

  return (
    <div className="pipeline-viz" id="section-pipeline">
      <div className="pipeline-header">
        <div>
          <h3>导入流水线</h3>
          <p className="pipeline-intro">
            工作台现在展示的是分析草案流水线。真正的前端渲染与变量行为，以保存后的统一运行时模型为准。
          </p>
        </div>
      </div>
      <div className="pipeline-groups">
        {groupedStages.map((group) => (
          <section key={group.id} className="pipeline-group">
            <div className="pipeline-group-meta">
              <span className="pipeline-group-label">{group.label}</span>
              <p>{group.description}</p>
            </div>
            <div className="pipeline-stages">
              {group.stages.map((stage) => (
                <div key={stage.id} className={`pipeline-stage stage-${stage.status}`}>
                  <span className="stage-icon">{statusIcons[stage.status] || '⏳'}</span>
                  <span className="stage-name">{stage.name}</span>
                  <span className="stage-status">{stage.status}</span>
                  {stage.message && <span className="stage-message">{stage.message}</span>}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
