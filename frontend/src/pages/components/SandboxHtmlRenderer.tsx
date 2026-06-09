// Direct HTML renderer for SillyTavern regex UI.
// Extracted from Chat.tsx GROUP 23

import React, { useMemo } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildSandboxDocument, type SandboxRuntimeContext } from '../sandbox-document';
import { DirectHtmlRuntimeHost } from './DirectHtmlRuntimeHost';

const ALLOWED_ACTIONS = new Set([
  'applyGreeting',
  'applyOpeningSwipe',
  'readVariables',
  'writeVariables',
  'openStatusPanel',
  'submitFreeStart',
  'submitText',
  'diagnostic',
  'uiClick',
  'formSubmit',
  'setChatMessage',
  'setChatMessages',
  'triggerSlash',
  'setVariables',
  'missingApi',
  'runtimeError',
  'resourceRequest',
  'sandboxResize',
  'loadSaveSession',
  'deleteSaveSession',
]);

export function SandboxHtmlRenderer({ html, variables, runtime, onAction }: { html: string; variables: any; runtime?: SandboxRuntimeContext; onAction?: (action: SandboxCardAction) => void }) {
  const documentHtml = useMemo(() => buildSandboxDocument(html, variables || {}, runtime), [html, variables, runtime]);

  return (
    <DirectHtmlRuntimeHost
      className="sandbox-renderer-shell"
      documentHtml={documentHtml}
      variables={variables || {}}
      runtime={runtime}
      allowedActions={ALLOWED_ACTIONS}
      onAction={onAction}
    />
  );
}
