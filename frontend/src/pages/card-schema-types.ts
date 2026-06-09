// Card UI schema types and default constants
// Extracted from Chat.tsx GROUP 4 + GROUP 5

import type { CharacterCard } from '../api/types';

export type SandboxCardAction = { action: string; payload: any };

export type UiTheme = {
  cardBg: string;
  textPrimary: string;
  textSecondary: string;
  accentMain: string;
  accentRed: string;
  accentBlue: string;
  accentGreen: string;
  gold: string;
  borderGlow: string;
  shadow: string;
};

export type UiWidget =
  | { type: 'thoughts'; leftLabel: string; leftPath: string; rightLabel: string; rightPath: string }
  | { type: 'progress'; label: string; path: string; color?: string; min?: number; max?: number }
  | { type: 'facts'; items: Array<{ label: string; path: string }> }
  | { type: 'table'; title: string; rows: string[][] };

export type UiSection = {
  title: string;
  widgets: UiWidget[];
};

export type UiSchema = {
  title: string;
  datePaths: string[];
  theme: UiTheme;
  sections: UiSection[];
};

export const DEFAULT_STATUS_THEME: UiTheme = {
  cardBg: '#15101C',
  textPrimary: '#F1E9F4',
  textSecondary: '#A89BAD',
  accentMain: '#B51635',
  accentRed: '#C92546',
  accentBlue: '#6B5E78',
  accentGreen: '#5B8A5E',
  gold: '#B89A5B',
  borderGlow: 'rgba(61, 46, 79, 0.5)',
  shadow: '0 15px 40px rgba(0, 0, 0, 0.45)',
};
