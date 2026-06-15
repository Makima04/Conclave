// Utility: clean card display text by stripping ST-specific tags and macros
// Extracted from card-content.tsx during dead code cleanup (2026-06-11)

export function cleanCardDisplayText(
  content: string,
  userName: string = '你',
  charName: string = '{{char}}',
): string {
  return content
    .replace(/<StatusPlaceHolderImpl\/>/g, '')
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, '')
    .replace(/<options\b[^>]*>[\s\S]*?<\/options>/gi, '')
    .replace(/<\/?正文>/g, '')
    .replace(/{{user}}/g, userName)
    .replace(/{{char}}/g, charName)
    .replace(/<user>/g, userName)
    .replace(/<\/user>/g, '')
    .replace(/<char>/g, charName)
    .replace(/<\/char>/g, '')
    .replace(/<\/?initvar>/gi, '')
    .replace(/<inner>([\s\S]*?)<\/inner>/gi, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
