import React, { useEffect, useMemo } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildTavernHelperDocument } from '../sandbox-document';
import type { SandboxRuntimeContext } from '../sandbox-runtime-types';
import { DirectHtmlRuntimeHost } from './DirectHtmlRuntimeHost';

export function SessionTavernHelperRuntimeHost({
  scripts,
  variables,
  runtime,
  onAction,
}: {
  scripts: Array<{ name: string; content: string }>;
  variables: any;
  runtime?: SandboxRuntimeContext;
  onAction?: (action: SandboxCardAction) => void;
}) {
  const variableSignature = useMemo(() => {
    if (!variables || typeof variables !== 'object') return '';
    return Object.keys(variables).sort().join('|');
  }, [variables]);
  const documentHtml = useMemo(
    () => scripts.length ? buildTavernHelperDocument(scripts, variables || {}, runtime) : '',
    [scripts, runtime?.sessionId, variableSignature],
  );

  useEffect(() => {
    if (scripts.length) return;
    [
      '#cx-floating-status-root',
      '#cx-floating-status-style',
    ].forEach((selector) => {
      document.querySelectorAll(selector).forEach(node => node.remove());
    });
  }, [scripts.length]);

  if (!scripts.length) return null;

  return (
    <DirectHtmlRuntimeHost
      className="session-tavern-helper-runtime-host"
      documentHtml={documentHtml}
      variables={variables || {}}
      runtime={runtime}
      onAction={onAction}
    />
  );
}
