import React, { useMemo } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildSandboxDocument, type SandboxRuntimeContext } from '../sandbox-document';
import type { StHtmlAppManifest } from '../st-html-app-runtime';
import { DirectHtmlRuntimeHost } from './DirectHtmlRuntimeHost';

interface PersistentCardRuntimeHostProps {
  manifest: StHtmlAppManifest;
  sessionId: string;
  cardId: string;
  variables: Record<string, unknown>;
  runtime: SandboxRuntimeContext;
  onAction?: (action: SandboxCardAction) => void;
}

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

export function PersistentCardRuntimeHost({
  manifest,
  sessionId,
  cardId,
  variables,
  runtime,
  onAction,
}: PersistentCardRuntimeHostProps) {
  const mountKey = `${cardId}:${sessionId}:${manifest.scriptName}`;
  const documentHtml = useMemo(
    () => buildSandboxDocument(manifest.bootHtml, variables || {}, runtime),
    [mountKey],
  );

  return (
    <section className="persistent-card-runtime" aria-label="角色卡局内界面">
      <DirectHtmlRuntimeHost
        key={mountKey}
        className="persistent-card-runtime-direct"
        documentHtml={documentHtml}
        variables={variables || {}}
        runtime={runtime}
        allowedActions={ALLOWED_ACTIONS}
        onAction={onAction}
      />
    </section>
  );
}
