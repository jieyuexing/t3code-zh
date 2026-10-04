import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { babel } from "./babel.mjs";
import { classifyAll, inScope, repoRoot, sourceRoots } from "./rules.mjs";
import { readDictionary, readIgnore } from "./plugin.mjs";

type Occurrence = {
  location: string;
  category: string;
  context: string;
  placeholders: { token: string; expression: string }[];
  reason?: string;
};
type Candidate = {
  key: string;
  placeholders: { token: string; expression: string }[];
  categories: string[];
  locations: string[];
  occurrences: Occurrence[];
  occurrenceCount: number;
  reasons?: Record<string, number>;
};

function filesAt(path: string): string[] {
  const stat = NodeFS.statSync(path);
  if (stat.isFile()) return inScope(path) ? [path] : [];
  return NodeFS.readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => (entry.isSymbolicLink() ? [] : filesAt(NodePath.join(path, entry.name))));
}

export function extract(paths = sourceRoots.map((root) => NodePath.join(repoRoot, root))) {
  const candidates = new Map<string, Candidate>();
  const review = new Map<string, Candidate>();
  for (const file of [
    ...new Set(paths.flatMap((path) => filesAt(NodePath.resolve(path)))),
  ].sort()) {
    const relative = NodePath.relative(repoRoot, file).replaceAll("\\", "/");
    const ast = babel.parseSync(NodeFS.readFileSync(file, "utf8"), {
      filename: file,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
    });
    const collect = (path) => {
      for (const candidate of classifyAll(path, { filename: file })) {
        if (!candidate.eligible && !candidate.review) continue;
        const ledger = candidate.eligible ? candidates : review;
        const category = relative.startsWith("apps/desktop/") ? "desktop" : candidate.category;
        const item: Candidate = ledger.get(candidate.key) ?? {
          key: candidate.key,
          placeholders: candidate.placeholders,
          categories: [],
          locations: [],
          occurrences: [],
          occurrenceCount: 0,
        };
        const location = `${relative}:${candidate.line ?? path.node.loc?.start.line ?? 1}`;
        item.occurrenceCount++;
        if (!candidate.eligible) {
          item.reasons ??= {};
          item.reasons[candidate.reason] = (item.reasons[candidate.reason] ?? 0) + 1;
        }
        if (!item.categories.includes(category)) item.categories.push(category);
        if (item.occurrences.length < 8)
          item.occurrences.push({
            location,
            category,
            context: candidate.context,
            placeholders: candidate.placeholders,
            ...(!candidate.eligible ? { reason: candidate.reason } : {}),
          });
        if (!item.locations.includes(location) && item.locations.length < 8)
          item.locations.push(location);
        ledger.set(candidate.key, item);
      }
    };
    babel.traverse(ast, { JSXText: collect, StringLiteral: collect, TemplateLiteral: collect });
  }
  const sorted = (ledger: Map<string, Candidate>) =>
    [...ledger.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { candidates: sorted(candidates), review: sorted(review) };
}

export function coverage(
  candidates: Candidate[],
  dictionary = readDictionary(),
  ignored = readIgnore(),
) {
  const translated = candidates.filter(
    ({ key }) => Object.hasOwn(dictionary, key) && !Object.hasOwn(ignored, key),
  );
  const skipped = candidates.filter(({ key }) => Object.hasOwn(ignored, key));
  const missing = candidates.filter(
    ({ key }) => !Object.hasOwn(dictionary, key) && !Object.hasOwn(ignored, key),
  );
  const categories: Record<string, number> = {};
  for (const item of candidates)
    for (const category of item.categories) categories[category] = (categories[category] ?? 0) + 1;
  return {
    total: candidates.length,
    translated: translated.length,
    ignored: skipped.length,
    missing: missing.length,
    categories,
    missingCandidates: missing,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = new Map<string, string>();
  const scopes: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      !flag ||
      !["--candidates", "--review", "--missing", "--scope", "--dictionary", "--ignore"].includes(
        flag,
      ) ||
      !value
    )
      throw new Error(`Unknown or incomplete option: ${flag}`);
    if (flag === "--scope") scopes.push(value);
    else options.set(flag, value);
  }
  const { candidates, review } = extract(scopes.length ? scopes : undefined);
  const read = (flag: string, fallback: () => Record<string, unknown>) =>
    options.has(flag) ? JSON.parse(NodeFS.readFileSync(options.get(flag)!, "utf8")) : fallback();
  const result = coverage(
    candidates,
    read("--dictionary", readDictionary),
    read("--ignore", readIgnore),
  );
  const emit = (flag: string, value: unknown) => {
    const output = options.get(flag);
    if (output) NodeFS.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  };
  emit("--candidates", candidates);
  emit("--review", review);
  emit("--missing", result.missingCandidates);
  const { missingCandidates, ...summary } = result;
  const reviewByReason: Record<string, { keys: number; occurrences: number }> = {};
  for (const item of review) {
    for (const [reason, count] of Object.entries(item.reasons ?? {})) {
      const group = (reviewByReason[reason] ??= { keys: 0, occurrences: 0 });
      group.keys++;
      group.occurrences += count;
    }
  }
  console.error(JSON.stringify({ ...summary, review: review.length, reviewByReason }, null, 2));
  if (!options.has("--missing")) console.log(JSON.stringify(missingCandidates, null, 2));
  if (!options.has("--review")) console.error(JSON.stringify({ review }, null, 2));
  return result.missing > 0 ? 1 : 0;
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  process.exitCode = main();
