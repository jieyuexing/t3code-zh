export type Locale = "en" | "zh-CN";
export function getLocale(): Locale;
export function __t(key: string): string;
export function __tf(key: string, args: readonly unknown[]): string;
export function changeLocale(
  locale: Locale,
  bridge?: { setLocale?: (locale: Locale) => Promise<void> },
  reload?: () => void,
): Promise<void>;
