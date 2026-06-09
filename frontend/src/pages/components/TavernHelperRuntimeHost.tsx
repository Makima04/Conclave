import React, { useMemo } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildTavernHelperDocument } from '../sandbox-document';
import type { SandboxRuntimeContext } from '../sandbox-runtime-types';
import { DirectHtmlRuntimeHost } from './DirectHtmlRuntimeHost';

export function TavernHelperRuntimeHost({
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
    [scripts, variables, runtime],
  );

  if (!scripts.length) return null;

  return (
    <DirectHtmlRuntimeHost
      className="tavern-helper-runtime-host"
      documentHtml={documentHtml}
      variables={variables || {}}
      runtime={runtime}
      onAction={onAction}
    />
  );
}
