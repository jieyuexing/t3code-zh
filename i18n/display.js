import { __t, __tf, getLocale } from "./runtime.js";

// Like the Babel transform, explicit display helpers leave upstream tests in
// English. i18n tests opt into production mode to exercise the real lookup.
const testMode = () => import.meta.env?.MODE === "test";

/** Use only at presentation boundaries; never map the descriptor/selection itself. */
export const displayLabel = (label) => (testMode() ? label : __t(label));

/** The server-owned seed and all user-written titles remain unchanged as data. */
export const displayThreadTitle = (title) => (title === "New thread" ? displayLabel(title) : title);

const usageNoticeMessages = [
  "Could not read limits.",
  "No limits reported.",
  "No accounts reported.",
  "This account has no subscription limits.",
  "Codex CLI is not authenticated. Run `codex login` and try again.",
  "Codex could not be started to read usage.",
  "Codex exited before it could report usage.",
  "Codex did not answer the usage request.",
  "Grok could not read usage limits.",
  "Grok could not read saved credentials.",
  "Grok usage-limit check timed out.",
  "Grok could not connect to the billing service.",
  "Grok returned an invalid usage-limits response.",
  "Grok sign-in was rejected. Reconnect Grok in provider settings.",
  "Grok usage limits are unavailable for this account.",
  "Grok usage-limit checks are rate limited. Try again soon.",
  "Grok billing is temporarily unavailable.",
];

/** Translate only a known notice suffix, preserving environment and account names. */
export function displayUsageNotice(notice) {
  if (testMode()) return notice;
  for (const message of usageNoticeMessages) {
    if (notice === message || notice.endsWith(`: ${message}`)) {
      return notice.slice(0, -message.length) + __t(message);
    }
  }
  const rpcFailure = /(?:^|: )(Codex could not read usage \(JSON-RPC (-?\d+)\)\.)$/.exec(notice);
  if (rpcFailure) {
    return (
      notice.slice(0, -rpcFailure[1].length) +
      __tf("Codex could not read usage (JSON-RPC {0}).", [rpcFailure[2]])
    );
  }
  const httpFailure = /(?:^|: )(Grok billing returned HTTP (\d{3})\.)$/.exec(notice);
  if (httpFailure) {
    return (
      notice.slice(0, -httpFailure[1].length) +
      __tf("Grok billing returned HTTP {0}.", [httpFailure[2]])
    );
  }
  return notice;
}

/** Window labels may append a model name; keep that server-owned suffix intact. */
export function displayUsageWindowLabel(label) {
  const window = /^(Session|Weekly|Monthly|Subscription)( · .+)?$/.exec(label);
  return window ? displayLabel(window[1]) + (window[2] ?? "") : label;
}

export const relativeTimeSuffix = (suffix) =>
  suffix ? `${testMode() || getLocale() === "en" ? " " : ""}${suffix}` : "";

export const joinRelativeTime = (parts) => parts.value + relativeTimeSuffix(parts.suffix);
