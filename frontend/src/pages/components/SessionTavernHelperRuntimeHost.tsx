import React, { useEffect, useMemo } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildTavernHelperDocument, type SandboxRuntimeContext } from '../sandbox-document';
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
  const documentHtml = useMemo(
    () => scripts.length ? buildTavernHelperDocument(scripts, variables || {}, runtime) : '',
    [scripts],
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
