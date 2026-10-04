export default function i18nPlugin(): { name: string; visitor: Record<string, never> };
export function readDictionary(): Record<string, string>;
export function readIgnore(): Record<string, { category: string; reason: string }>;
