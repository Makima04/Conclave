// CodeBlock component with copy-to-clipboard
// Extracted from Chat.tsx GROUP 2

import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

export function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const codeStr = String(children).replace(/\n$/, '');

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(codeStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (match) {
    return (
      <div className="code-block-container">
        <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div" customStyle={{ margin: '8px 0', borderRadius: '6px', fontSize: '13px', overflow: 'auto' }}>
          {codeStr}
        </SyntaxHighlighter>
        <button className="code-copy-float" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    );
  }
  return <code className={className}>{children}</code>;
}
