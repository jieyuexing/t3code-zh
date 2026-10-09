#!/usr/bin/env node
import * as NodeUtil from "node:util";
import { readJson, assertCandidate } from "./release-source-zh.mjs";
import { auditDmg, smokeCli } from "./candidate-target-checks-zh.mjs";
import { prepareWindows, verifyReceipt } from "./release-validation-zh.mjs";
const { values } = NodeUtil.parseArgs({
  options: {
    "prepare-windows": { type: "boolean" },
    "audit-dmg": { type: "boolean" },
    "smoke-cli": { type: "boolean" },
    ...Object.fromEntries(
      ["artifact", "candidate", "output", "seven-zip", "receipt", "materials"].map((n) => [
        n,
        { type: "string" },
      ]),
    ),
  },
});
if (!values.artifact || !values.candidate) throw new Error("Required: --artifact --candidate");
if (
  [values["prepare-windows"], values["audit-dmg"], values["smoke-cli"]].filter(Boolean).length > 1
)
  throw new Error("Choose one target operation");
if (values["audit-dmg"] || values["smoke-cli"]) {
  if (!values.output) throw new Error("--output (new directory) required");
  await (values["audit-dmg"] ? auditDmg : smokeCli)({
    artifact: values.artifact,
    candidateFile: values.candidate,
    output: values.output,
  });
  console.log("Target receipt created; replay with --receipt before suite preflight");
} else if (values["prepare-windows"]) {
  if (!values.output || !values["seven-zip"])
    throw new Error("Required: --output (new directory) --seven-zip (existing 7za)");
  console.log(
    JSON.stringify(
      await prepareWindows({
        artifact: values.artifact,
        candidateFile: values.candidate,
        output: values.output,
        sevenZip: values["seven-zip"],
      }),
    ),
  );
} else {
  const candidate = readJson(values.candidate);
  assertCandidate(candidate, values.artifact);
  if (!values.receipt) throw new Error("Target validation pending: --receipt required");
  console.log(JSON.stringify(verifyReceipt(candidate, values.receipt, values.materials)));
}
