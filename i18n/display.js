import { __t, getLocale } from "./runtime.js";

// Like the Babel transform, explicit display helpers leave upstream tests in
// English. i18n tests opt into production mode to exercise the real lookup.
const testMode = () => import.meta.env?.MODE === "test";

/** Use only at presentation boundaries; never map the descriptor/selection itself. */
export const displayLabel = (label) => (testMode() ? label : __t(label));

/** The server-owned seed and all user-written titles remain unchanged as data. */
export const displayThreadTitle = (title) => (title === "New thread" ? displayLabel(title) : title);

export const relativeTimeSuffix = (suffix) =>
  suffix ? `${testMode() || getLocale() === "en" ? " " : ""}${suffix}` : "";

export const joinRelativeTime = (parts) => parts.value + relativeTimeSuffix(parts.suffix);
