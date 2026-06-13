// Pure utility functions for card data extraction and parsing
// Extracted from Chat.tsx GROUP 3 + GROUP 11 + GROUP 13

// --- GROUP 3: Data extraction & parsing ---

export function getPathValue(source: any, path: string): any {
  if (!source || !path) return undefined;
  return path.split('.').reduce((current, part) => {
    if (current == null || typeof current !== 'object') return undefined;
    return current[part];
  }, source);
}

export function parsePrimaryValue(value: any): string {
  if (Array.isArray(value)) return parsePrimaryValue(value[0]);
  if (value == null) return 'N/A';
  return String(value).split(' | ')[0].trim() || 'N/A';
}

export function parsePercent(value: any, min = 0, max = 100): number {
  const raw = parseFloat(parsePrimaryValue(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(raw)) return 0;
  if (max <= min) return 0;
  return Math.max(0, Math.min(100, ((raw - min) / (max - min)) * 100));
}

// --- GROUP 11: CSS/Style extraction ---

export function extractCssVar(source: string, name: string, fallback: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() || fallback;
}

export function extractFirst(source: string, pattern: RegExp, fallback: string): string {
  return source.match(pattern)?.[1]?.trim() || fallback;
}
