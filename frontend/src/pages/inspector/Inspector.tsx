import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RuntimeInspector } from './RuntimeInspector';
import { AgentConfigPanel } from '../../components/AgentConfigPanel';
import '../../styles/inspector.css';

type Tab = 'runtime' | 'config';

/**
 * Agent 工作台 —— 全屏页。两个 tab：
 *   - 运行时：每轮 agent 的注入上下文 + 产出 + master→子agent 的 DAG 流
 *   - 配置：agent 的增删改/模型/参数/固定上下文（融合自原 AgentManager）
 * 取代原 /chat/:id/agents 独立页与 /chat 左栏 👥 浮层。
 */
export default function Inspector() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('runtime');

  if (!sessionId) {
    return <div className="inspector-page"><p className="insp-empty">无效的会话 ID</p></div>;
  }

  return (
    <div className="inspector-page">
      <header className="inspector-header">
        <button type="button" className="insp-back" onClick={() => navigate(`/chat/${sessionId}`)}>← 返回对话</button>
        <h1>Agent 工作台</h1>
        <div className="insp-tabs">
          <button type="button" className={`insp-tab${tab === 'runtime' ? ' active' : ''}`} onClick={() => setTab('runtime')}>运行时</button>
          <button type="button" className={`insp-tab${tab === 'config' ? ' active' : ''}`} onClick={() => setTab('config')}>配置</button>
        </div>
      </header>
      {tab === 'runtime' ? (
        <RuntimeInspector sessionId={sessionId} />
      ) : (
        <div className="inspector-config">
          <AgentConfigPanel sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}
