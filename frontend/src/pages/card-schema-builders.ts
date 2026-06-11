// Status schema builder for the explicit Schema/debug render mode.

import type { CharacterCard } from '../api/types';
import type { UiSchema, UiTheme } from './card-schema-types';
import { DEFAULT_STATUS_THEME } from './card-schema-types';
import { extractCssVar, extractFirst } from './card-utils';

function getStatusReplaceString(card: CharacterCard | null): string | null {
  const source = (card?.extensions as Record<string, any> | undefined)?.status_replace_string;
  return typeof source === 'string' && source.trim() ? source.trim() : null;
}

export function buildStatusSchema(card: CharacterCard | null): UiSchema | null {
  const source = getStatusReplaceString(card);
  if (!source) return null;

  const theme: UiTheme = {
    cardBg: extractCssVar(source, '--card-bg', DEFAULT_STATUS_THEME.cardBg),
    textPrimary: extractCssVar(source, '--text-primary', DEFAULT_STATUS_THEME.textPrimary),
    textSecondary: extractCssVar(source, '--text-secondary', DEFAULT_STATUS_THEME.textSecondary),
    accentMain: extractCssVar(source, '--accent-main', DEFAULT_STATUS_THEME.accentMain),
    accentRed: extractCssVar(source, '--accent-red', DEFAULT_STATUS_THEME.accentRed),
    accentBlue: extractCssVar(source, '--accent-blue', DEFAULT_STATUS_THEME.accentBlue),
    accentGreen: extractCssVar(source, '--accent-green', DEFAULT_STATUS_THEME.accentGreen),
    gold: extractCssVar(source, '--gold-highlight', DEFAULT_STATUS_THEME.gold),
    borderGlow: extractCssVar(source, '--border-glow', DEFAULT_STATUS_THEME.borderGlow),
    shadow: extractCssVar(source, '--card-shadow', DEFAULT_STATUS_THEME.shadow),
  };

  const title = extractFirst(source, /<h2>([^<]+)<\/h2>/, '状态');

  return {
    title,
    datePaths: ['世界.当前日期', '世界.当前星期', '世界.当前时间'],
    theme,
    sections: [],
  };
}
