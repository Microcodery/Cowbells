// Display units and the labels built from them; the event itself is always metric and in epoch seconds.

/** Display units; the event itself is always metric. */
export const UNITS = {
  km: { label: "km", perMetre: 0.001, speed: "km/h", speedPerMps: 3.6 },
  mi: { label: "mi", perMetre: 1 / 1609.344, speed: "mph", speedPerMps: 2.236936 },
};

export function distanceLabel(metres, unit, digits = 2) {
  return `${(metres * unit.perMetre).toFixed(digits)} ${unit.label}`;
}

export function speedLabel(mps, unit) {
  return (mps * unit.speedPerMps).toFixed(1);
}

const kmPerUnit = (unit) => 1 / (unit.perMetre * 1000);

/** "m:ss" per display unit from seconds per kilometre. */
export function paceLabel(secondsPerKm, unit = UNITS.km) {
  const perUnit = secondsPerKm * kmPerUnit(unit);
  const m = Math.floor(perUnit / 60);
  const s = Math.round(perUnit % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "m:ss" or whole minutes per display unit, as seconds per kilometre; `null` when unparseable. */
export function parsePace(text, unit = UNITS.km) {
  const match = text.trim().match(/^(\d+)(?::(\d{1,2}))?$/);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2] ?? 0);
  return seconds > 0 ? seconds / kmPerUnit(unit) : null;
}

export function todayAt(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function clock(epoch) {
  return new Date(epoch * 1000).toTimeString().slice(0, 5);
}

/** `epoch` moved to the clock time `hhmm` on its day; unchanged when the input is blank or malformed. */
export function withClock(epoch, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return epoch;
  const d = new Date(epoch * 1000);
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** The first moment after `epoch` whose clock reads `hhmm`, rolling past midnight if needed. */
export function laterThan(epoch, hhmm) {
  const t = withClock(epoch, hhmm);
  return t > epoch ? t : t + 24 * 3600;
}
