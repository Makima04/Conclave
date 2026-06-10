import type { CharacterCard, RenderMode } from '../api/types';
import {
  cleanCardDisplayText,
  getSandboxHtmlForContent,
  getTavernHelperScripts,
  removeUiTriggers,
} from './card-content';
import type { SandboxRuntimeContext } from './sandbox-runtime-types';

export type CardRenderPlan =
  | {
      kind: 'text';
      displayContent: string;
    }
  | {
      kind: 'html_app';
      displayContent: string;
      runtimeHtml: string;
    }
  | {
      kind: 'sandbox_html';
      displayContent: string;
      runtimeHtml: string;
    };

const HTML_APP_TRIGGER_RE = /(?:^|\n)\s*(?:\[attachment\]|\[开局\]|【GameStart】|【游戏开始】)\s*(?:\n|$)/i;

function isOpeningPreviewRuntime(runtime?: SandboxRuntimeContext): boolean {
  const current = runtime?.currentMessage;
  const id = String(runtime?.currentMessageId ?? current?.message_id ?? current?.id ?? '');
  return id === 'opening-preview';
}

function isHtmlAppInternalRuntime(runtime?: SandboxRuntimeContext): boolean {
  const current = runtime?.currentMessage;
  const data = current?.data;
  return Boolean(
    data
      && typeof data === 'object'
      && !Array.isArray(data)
      && (data as Record<string, unknown>).html_app_internal === true,
  );
}

function hasPackageHtmlApp(card: CharacterCard | null): boolean {
  return Boolean(
    card?.conclave_package?.ui?.type === 'html_app'
      && String(card.conclave_package?.ui?.html || '').trim(),
  );
}

function shouldBootHtmlApp(card: CharacterCard | null, content: string, runtime?: SandboxRuntimeContext): boolean {
  const hints = card?.conclave_package?.runtime_hints;
  const triggerMatch = HTML_APP_TRIGGER_RE.test(content);
  if (!hasPackageHtmlApp(card)) return false;
  if (isOpeningPreviewRuntime(runtime)) return true;
  if (isHtmlAppInternalRuntime(runtime)) return true;
  if (triggerMatch) return true;
  return Boolean(hints?.regex_opening_full_document || hints?.raw_opening_full_document);
}

function stripHtmlAppTriggers(content: string): string {
  return content
    .replace(HTML_APP_TRIGGER_RE, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function resolveCardRenderPlan({
  card,
  content,
  runtime,
  renderMode,
}: {
  card: CharacterCard | null;
  content: string;
  runtime?: SandboxRuntimeContext;
  renderMode: RenderMode;
}): CardRenderPlan {
  const triggerMatch = HTML_APP_TRIGGER_RE.test(content);
  const strippedHtmlAppContent = triggerMatch ? stripHtmlAppTriggers(content) : content;

  if (renderMode === 'text') {
    return {
      kind: 'text',
      displayContent: strippedHtmlAppContent,
    };
  }

  if (shouldBootHtmlApp(card, content, runtime)) {
    return {
      kind: 'html_app',
      runtimeHtml: String(card?.conclave_package?.ui?.html || ''),
      displayContent: stripHtmlAppTriggers(content),
    };
  }

  const statusContent = content.includes('<StatusPlaceHolderImpl/>')
    ? content
    : `${content.trim()}\n\n<StatusPlaceHolderImpl/>`;
  const sandboxHtml = getSandboxHtmlForContent(card, statusContent);

  if ((renderMode === 'auto' || renderMode === 'sandbox') && sandboxHtml) {
    return {
      kind: 'sandbox_html',
      runtimeHtml: sandboxHtml,
      displayContent: removeUiTriggers(card, statusContent),
    };
  }

  return {
    kind: 'text',
    displayContent: strippedHtmlAppContent,
  };
}

export function resolveTavernHelperStatusMode(card: CharacterCard | null, content: string, renderMode: RenderMode): boolean {
  return renderMode === 'sandbox'
    && content.includes('<StatusPlaceHolderImpl/>')
    && getTavernHelperScripts(card).length > 0;
}

export function shouldRenderCleanText(value: string): boolean {
  return cleanCardDisplayText(value).trim() !== '' && value.trim() !== 'false';
}
