export function desktopI18nPlugin(): {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): Promise<{ code: string } | null>;
};
