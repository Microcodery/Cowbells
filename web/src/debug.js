// Tunables for feel rather than results, adjustable from the Debug section and kept per browser.

export const DEBUG_DEFAULTS = {
  networkMs: { value: 1000, label: "nodes appear", unit: "ms" },
  candidatesMs: { value: 1000, label: "light up / fade", unit: "ms" },
  mergeMs: { value: 1000, label: "merge into viewpoints", unit: "ms" },
  searchMs: { value: 3000, label: "search (at least)", unit: "ms" },
  fitMargin: { value: 10, label: "zoom-to-fit margin", unit: "%" },
  hoverPx: { value: 18, label: "hover snap distance", unit: "px" },
  mapDataDelayMs: { value: 1500, label: "map fetch after last edit", unit: "ms" },
};

export function debugDefaults() {
  return Object.fromEntries(Object.entries(DEBUG_DEFAULTS).map(([k, v]) => [k, v.value]));
}
