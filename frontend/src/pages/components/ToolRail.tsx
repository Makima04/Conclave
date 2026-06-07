import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { InspectorTab } from './InspectorSidebar';

interface ToolRailProps {
  activeTab: InspectorTab | null;
  onTabClick: (tab: InspectorTab) => void;
  sessionMode: string;
  sessionId: string | undefined;
}

const RAIL_ITEMS: Array<{ key: InspectorTab; label: string; icon: string }> = [
  { key: 'user',     label: 'User',  icon: '人' },
  { key: 'worldbook',label: '世界书', icon: '书' },
  { key: 'preset',   label: '预设',  icon: '预' },
  { key: 'agents',   label: 'Agents', icon: 'Ag' },
  { key: 'render',   label: '渲染',  icon: '渲' },
  { key: 'params',   label: '参数',  icon: '参' },
  { key: 'debug',    label: '调试',  icon: '试' },
];

export const ToolRail = React.memo(function ToolRail({ activeTab, onTabClick, sessionMode, sessionId }: ToolRailProps) {
  const navigate = useNavigate();

  return (
    <nav className="tool-rail" aria-label="工具栏">
      <button
        className="tool-rail-btn back"
        title="返回"
        onClick={() => navigate('/')}
      >
        <span>←</span>
      </button>

      <div className="tool-rail-divider" />

      {RAIL_ITEMS.map(item => {
        // Only show Agents tab in multi_agent mode
        if (item.key === 'agents' && sessionMode !== 'multi_agent') return null;

        return (
          <button
            key={item.key}
            className={`tool-rail-btn${activeTab === item.key ? ' active' : ''}`}
            title={item.label}
            onClick={() => onTabClick(item.key)}
          >
            <span>{item.icon}</span>
          </button>
        );
      })}

      <div className="tool-rail-spacer" />

      <button
        className="tool-rail-btn"
        title="设置"
        onClick={() => navigate('/settings')}
      >
        <span>⚙</span>
      </button>
    </nav>
  );
});
