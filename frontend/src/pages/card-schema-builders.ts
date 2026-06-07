// Card schema builders for platform layout, cover menu, and status panels
// Extracted from Chat.tsx GROUP 12 + GROUP 14 + GROUP 15 + GROUP 16 + GROUP 17
// Note: Hardcoded Chinese paths removed from buildStatusSchema per user request

import type { CharacterCard } from '../api/types';
import type { CoverMenuSchema, PlatformCardSchema, PlatformLayout, PlatformLocation, PlatformOpeningCharacter, UiSchema, UiTheme } from './card-schema-types';
import { DEFAULT_PLATFORM_LAYOUT, DEFAULT_STATUS_THEME } from './card-schema-types';
import {
  clampNumber,
  extractCssVar,
  extractFirst,
  extractInlineStyleValue,
  firstDefined,
  stripTags,
} from './card-utils';
import {
  getRegexScripts,
  getStatusReplaceString,
  getUiReplaceStringForContent,
  sanitizeHtmlFragment,
  stripCodeFence,
} from './card-content';

// --- GROUP 12: Platform layout builder ---

function getPlatformLayoutConfig(card: CharacterCard | null): any {
  const extensions = card?.extensions;
  if (!extensions || typeof extensions !== 'object') return {};
  return extensions.platform_ui?.carousel
    || extensions.platform_ui?.layout
    || extensions.xrp_platform_ui?.carousel
    || extensions.xrp_platform_ui?.layout
    || extensions.ui_layout?.carousel
    || {};
}

export function buildPlatformLayout(card: CharacterCard | null, source: string): PlatformLayout {
  const config = getPlatformLayoutConfig(card);
  const css = (name: string) => extractCssVar(source, name, '');

  return {
    shellMaxWidth: clampNumber(firstDefined(config.shellMaxWidth, config.shell_max_width, css('--xrp-shell-max-width')), 560, 1100, DEFAULT_PLATFORM_LAYOUT.shellMaxWidth),
    stageMinHeight: clampNumber(firstDefined(config.stageMinHeight, config.stage_min_height, css('--xrp-stage-min-height')), 220, 620, DEFAULT_PLATFORM_LAYOUT.stageMinHeight),
    mainCardWidth: clampNumber(firstDefined(config.mainCardWidth, config.main_card_width, css('--xrp-main-card-width')), 180, 420, DEFAULT_PLATFORM_LAYOUT.mainCardWidth),
    mainCardMinWidth: clampNumber(firstDefined(config.mainCardMinWidth, config.main_card_min_width, css('--xrp-main-card-min-width')), 128, 260, DEFAULT_PLATFORM_LAYOUT.mainCardMinWidth),
    mainCardTop: clampNumber(firstDefined(config.mainCardTop, config.main_card_top, css('--xrp-main-card-top')), 0, 12, DEFAULT_PLATFORM_LAYOUT.mainCardTop),
    mainCardHeight: clampNumber(firstDefined(config.mainCardHeight, config.main_card_height, css('--xrp-main-card-height')), 68, 100, DEFAULT_PLATFORM_LAYOUT.mainCardHeight),
    sideCardScale: clampNumber(firstDefined(config.sideCardScale, config.side_card_scale, css('--xrp-side-card-scale')), 0.48, 0.9, DEFAULT_PLATFORM_LAYOUT.sideCardScale),
    sideCardOffset: clampNumber(firstDefined(config.sideCardOffset, config.side_card_offset, css('--xrp-side-card-offset')), 28, 72, DEFAULT_PLATFORM_LAYOUT.sideCardOffset),
    sideCardOpacity: clampNumber(firstDefined(config.sideCardOpacity, config.side_card_opacity, css('--xrp-side-card-opacity')), 0.12, 0.7, DEFAULT_PLATFORM_LAYOUT.sideCardOpacity),
    backgroundDim: clampNumber(firstDefined(config.backgroundDim, config.background_dim, css('--xrp-background-dim')), 0.45, 0.92, DEFAULT_PLATFORM_LAYOUT.backgroundDim),
  };
}

// --- GROUP 14: Cover menu schema builder ---

export function buildCoverMenuSchema(card: CharacterCard | null, content: string): CoverMenuSchema | null {
  const source = stripCodeFence(getUiReplaceStringForContent(card, content));
  if (!source) return null;

  const title = stripTags(
    extractFirst(source, /<(?:h1|h2|div|span)[^>]*(?:title|cx-title|main-title)[^>]*>([\s\S]*?)<\/(?:h1|h2|div|span)>/i, '')
  ) || card?.name || '角色卡';
  const subtitle = stripTags(
    extractFirst(source, /<(?:p|div|span)[^>]*(?:subtitle|sub-title|tagline)[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i, '')
  );
  const background = extractFirst(source, /<img[^>]+(?:class="[^"]*(?:base-bg|bg|cover)[^"]*"[^>]+)?src=["']([^"']+)["']/i, '');
  const buttonMatches = Array.from(source.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi))
    .map(match => stripTags(match[1]))
    .filter(Boolean);
  const fallbackButtons = Array.from(source.matchAll(/<(?:div|a)[^>]+class=["'][^"']*(?:nav|btn|button|menu-item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|a)>/gi))
    .map(match => stripTags(match[1]))
    .filter(Boolean);
  const buttons = Array.from(new Set((buttonMatches.length ? buttonMatches : fallbackButtons).slice(0, 8)));

  if (!background && buttons.length === 0 && !source.includes('cx-launcher')) {
    return null;
  }

  return {
    title,
    subtitle,
    background: background || undefined,
    buttons,
    theme: {
      cardBg: extractCssVar(source, '--cx-bg-base', '#15101C'),
      textPrimary: extractCssVar(source, '--cx-text-title', '#F1E9F4'),
      textSecondary: extractCssVar(source, '--cx-text-body', '#A89BAD'),
      accentMain: extractCssVar(source, '--cx-gold-main', '#B51635'),
      accentRed: extractCssVar(source, '--cx-danger', '#C92546'),
      accentBlue: '#6B5E78',
      accentGreen: '#5B8A5E',
      gold: extractCssVar(source, '--cx-gold-light', '#B89A5B'),
      borderGlow: extractCssVar(source, '--cx-glass-border', 'rgba(61, 46, 79, 0.5)'),
      shadow: extractInlineStyleValue(source, 'box-shadow', '0 18px 45px rgba(0, 0, 0, 0.55)'),
    },
  };
}

// --- GROUP 15: JavaScript array extractor ---

export function extractScriptArray(source: string, variableName: string): any[] {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = source.match(new RegExp(`const\\s+${escaped}\\s*=\\s*\\[`));
  if (!marker || marker.index == null) return [];
  const start = marker.index + marker[0].lastIndexOf('[');
  let depth = 0;
  let inString: string | null = null;
  let escapedChar = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escapedChar) {
        escapedChar = false;
      } else if (char === '\\') {
        escapedChar = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (depth === 0) {
      const literal = source.slice(start, i + 1);
      try {
        return Function(`"use strict"; return (${literal});`)();
      } catch {
        return [];
      }
    }
  }
  return [];
}

// --- GROUP 16: Platform card schema builder ---

export function buildPlatformCardSchema(card: CharacterCard | null, content: string): PlatformCardSchema | null {
  if (!card || !content.includes('【GameStart】')) return null;
  const source = stripCodeFence(getUiReplaceStringForContent(card, content));
  if (!source || !source.includes('cx-launcher') || !source.includes('characters = [')) return null;

  const characters = extractScriptArray(source, 'characters')
    .map((item: any) => ({
      id: Number(item.id),
      name: String(item.name || ''),
      sect: String(item.sect || ''),
      title: String(item.title || ''),
      front: String(item.front || ''),
      avatar: String(item.avatar || ''),
      desc: stripTags(String(item.desc || '')),
    }))
    .filter((item: PlatformOpeningCharacter) => Number.isFinite(item.id) && item.name && item.front);

  if (characters.length === 0) return null;

  const locations = extractScriptArray(source, 'locations')
    .map((item: any) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      tag: String(item.tag || ''),
      desc: String(item.desc || ''),
    }))
    .filter((item: PlatformLocation) => item.id && item.name);

  const background = extractFirst(source, /<img[^>]+class=["'][^"']*cx-base-bg-img[^"']*["'][^>]+src=["']([^"']+)["']/i, '')
    || extractFirst(source, /<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*cx-base-bg-img[^"']*["']/i, '');
  const title = stripTags(extractFirst(source, /<h1[^>]*>([\s\S]*?)<\/h1>/i, '')) || card.name;
  const subtitle = stripTags(extractFirst(source, /<div[^>]+class=["'][^"']*home-subtitle[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, ''))
    || stripTags(extractFirst(source, /<p[^>]+class=["'][^"']*subtitle[^"']*["'][^>]*>([\s\S]*?)<\/p>/i, ''));
  const introHtml = sanitizeHtmlFragment(extractFirst(source, /<div[^>]+id=["']intro-view["'][\s\S]*?<div[^>]+class=["'][^"']*scroll-content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i, ''));

  return {
    type: 'game_start',
    title,
    subtitle,
    background: background || undefined,
    introHtml,
    characters,
    locations,
    theme: {
      cardBg: extractCssVar(source, '--cx-bg-base', DEFAULT_STATUS_THEME.cardBg),
      textPrimary: extractCssVar(source, '--cx-text-title', DEFAULT_STATUS_THEME.textPrimary),
      textSecondary: extractCssVar(source, '--cx-text-body', DEFAULT_STATUS_THEME.textSecondary),
      accentMain: extractCssVar(source, '--cx-gold-main', DEFAULT_STATUS_THEME.accentMain),
      accentRed: extractCssVar(source, '--cx-danger', DEFAULT_STATUS_THEME.accentRed),
      accentBlue: '#0F172A',
      accentGreen: '#3F6F52',
      gold: extractCssVar(source, '--cx-gold-light', DEFAULT_STATUS_THEME.gold),
      borderGlow: extractCssVar(source, '--cx-glass-border', DEFAULT_STATUS_THEME.borderGlow),
      shadow: '0 18px 45px rgba(0, 0, 0, 0.55)',
    },
    layout: buildPlatformLayout(card, source),
  };
}

// --- GROUP 17: Status schema builder ---
// Note: Hardcoded Chinese paths removed per user request.
// This function now only extracts theme from the regex script source.
// The sections array is empty — status panel rendering relies on
// the theme variables extracted here.

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
