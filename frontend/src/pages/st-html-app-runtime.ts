import type { CharacterCard } from '../api/types';

export interface StHtmlAppManifest {
  kind: 'st-html-app';
  bootTrigger: string;
  bootHtml: string;
  scriptName: string;
}

export function detectStHtmlApp(card: CharacterCard | null): StHtmlAppManifest | null {
  if (!card) return null;
  const packageDraft = card.conclave_package;
  const html = typeof packageDraft?.ui?.html === 'string' ? packageDraft.ui.html.trim() : '';
  if (packageDraft?.ui?.type !== 'html_app' || !html) return null;
  const greeting = packageDraft.greetings?.[0]?.content || card.first_mes || '【GameStart】';
  return {
    kind: 'st-html-app',
    bootTrigger: greeting,
    bootHtml: html,
    scriptName: packageDraft.manifest?.id || `${card.id}:conclave-package`,
  };
}

export function getParsedOpeningContent(card: CharacterCard | null): string {
  if (!card) return '【GameStart】';
  return getParsedGreetings(card)[0] || '【GameStart】';
}

export function getParsedGreetings(card: CharacterCard | null): string[] {
  if (!card) return [];
  const packageGreetings = card.conclave_package?.greetings
    ?.map(greeting => greeting.content)
    .filter((content): content is string => typeof content === 'string' && content.trim().length > 0);
  if (packageGreetings?.length) return packageGreetings;
  return [card.first_mes, ...card.alternate_greetings].filter(Boolean);
}
