import React, { useMemo } from 'react';
import type { SandboxCardAction } from '../card-schema-types';
import { buildSandboxDocument } from '../sandbox-document';
import type { SandboxRuntimeContext } from '../sandbox-runtime-types';
import type { StHtmlAppManifest } from '../st-html-app-runtime';
import { IframeHtmlRuntimeHost } from './IframeHtmlRuntimeHost';

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
  'generate',
  'generateRaw',
  'generateQuietPrompt',
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
    [manifest.bootHtml, variables, mountKey, runtime],
  );

  return (
    <section className="persistent-card-runtime" aria-label="角色卡局内界面">
      <IframeHtmlRuntimeHost
        key={mountKey}
        className="persistent-card-runtime-frame"
        documentHtml={documentHtml}
        variables={variables || {}}
        runtime={runtime}
        allowedActions={ALLOWED_ACTIONS}
        fillAvailableHeight
        onAction={onAction}
      />
    </section>
  );
}
