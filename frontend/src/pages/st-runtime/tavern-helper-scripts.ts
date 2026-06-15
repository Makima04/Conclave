export interface TavernHelperScript {
  name: string;
  id?: string;
  content: string;
}

export function normalizeTavernHelperScripts(
  scripts: Array<Record<string, unknown>> | null | undefined,
): TavernHelperScript[] {
  return (scripts ?? [])
    .filter(script => script && typeof script === 'object')
    .filter(script => script.enabled !== false)
    .map((script, index) => {
      const id = String(script.id ?? script.uuid ?? script.script_id ?? index);
      const name = String(script.name ?? script.scriptName ?? script.script_name ?? id);
      const content = String(script.content ?? script.code ?? script.script ?? '');
      return { id, name, content };
    })
    .filter(script => script.content.trim().length > 0);
}
