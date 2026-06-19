import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

/**
 * 薄壳：/chat/:sessionId/agents 已被 Agent 工作台（inspector）取代。
 * 进入此路由直接重定向到工作台（配置能力已融合到其「配置」tab）。
 */
export default function AgentManager() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  useEffect(() => {
    navigate(`/chat/${sessionId}/inspector`, { replace: true });
  }, [navigate, sessionId]);
  return <div className="page-loading">重定向到 Agent 工作台…</div>;
}
