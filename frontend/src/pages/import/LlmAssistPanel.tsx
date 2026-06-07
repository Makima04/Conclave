import React from 'react';
import type { LlmAssistResponse } from '../../api/types';

export function LlmAssistPanel({
  result,
  loading,
}: {
  result: LlmAssistResponse | null;
  loading: boolean;
}) {
  if (!result && !loading) return null;

  return (
    <div className="llm-assist-panel">
      <h3>{'🤖'} LLM 辅助分析</h3>
      {loading && <div className="llm-loading">分析中...</div>}
      {result && (
        <div className="llm-result">
          <div className="llm-type">{result.type}</div>
          <pre className="llm-content">
            {JSON.stringify(result.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
