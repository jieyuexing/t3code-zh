export function webI18nPlugin(mode: string): {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): Promise<{ code: string } | null>;
};
