// Hysen HY08WE wall thermostats (Tuya "wk" behind a Zigbee gateway). Their cloud mapping lists only on/off, target and
// temperature. These are the rest, by Zigbee2MQTT's hy_thermostat data points (zigbee-herdsman-converters v14.0.0), read
// on a real HY08WE in November 2026. What isn't confirmed to accept writes stays read-only.
import type { Mapping } from "./rules";

export const isHysen = (model: unknown): boolean => typeof model === "string" && /^HY08/i.test(model);

/** Data points the cloud mapping leaves out, added to a Hysen's own. */
export const HYSEN_POINTS: Record<string, Mapping> = {
  // Also TempProg, a temporary override after the target changes in Program, and Holiday: the device enters both itself.
  "128": { code: "mode", type: "Enum", values: { range: ["Manual", "Program"] } },
  "129": { code: "child_lock", type: "Boolean" },
  "109": { code: "temp_correction", type: "Integer", values: { min: -90, max: 90, step: 1, scale: 1, unit: "°C" }, advanced: true },
  "110": { code: "hysteresis", type: "Integer", values: { min: 5, max: 30, step: 5, scale: 1, unit: "°C" }, advanced: true },
  "115": { code: "lower_temp", type: "Integer", values: { min: 5, max: 30, step: 1, unit: "°C" }, advanced: true },
  "114": { code: "upper_temp", type: "Integer", values: { min: 10, max: 35, step: 1, unit: "°C" }, advanced: true },
  // How many days a week run the weekend program: 0 (every day the workday one), 1 (6 + 1) or 2 (5 + 2). Checked on a
  // real HY08WE: it takes these three and refuses anything else.
  "118": { code: "weekend_days", type: "Enum", values: { range: ["0days", "1days", "2days"] }, advanced: true },
  // shortcut: read-only until its other values are seen on the device; only "keep" so far.
  "117": { code: "power_on", type: "String", advanced: true },
  // Read-only on purpose: a sensor that isn't wired, or a wrong floor limit, stops the heating or risks the floor.
  "116": { code: "sensor", type: "String", advanced: true },
  "112": { code: "floor_limit", type: "Integer", values: { unit: "°C" }, readOnly: true, advanced: true },
};

/** A Hysen's mapping with HYSEN_POINTS added, skipping a data point or a code its own mapping already has. */
export function withHysenPoints(mapping: Record<string, Mapping>): Record<string, Mapping> {
  const codes = Object.values(mapping).map((m) => m.code);
  const out = { ...mapping };
  for (const [dp, m] of Object.entries(HYSEN_POINTS)) if (out[dp] === undefined && !codes.includes(m.code)) out[dp] = m;
  return out;
}

/** The program's data points: two per day type, each three periods of [hour, minute, whole °C]. */
export const PROGRAM_POINTS = { workday: ["119", "120"], weekend: ["121", "122"] } as const;
export type DayType = keyof typeof PROGRAM_POINTS;

export interface Period {
  time: string; // "HH:MM"
  temp: number; // whole °C
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

export function fromBase64(text: string): number[] | null {
  const clean = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null;
  const out: number[] = [];
  let bits = 0, acc = 0;
  for (const c of clean) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** One data point's three periods, or null when it isn't a 9-byte program a person could have set. */
function periodsOf(raw: unknown): Period[] | null {
  const bytes = typeof raw === "string" ? fromBase64(raw) : null;
  if (bytes === null || bytes.length < 9) return null;
  const out: Period[] = [];
  for (let i = 0; i < 9; i += 3) {
    // The device sets flags in an hour's top bits (it sent 150 back for a written 22), so only the low six are the hour.
    const [flagged, minute, temp] = bytes.slice(i, i + 3);
    const hour = flagged & 0x3f;
    if (hour > 23 || minute > 59) return null;
    out.push({ time: `${pad(hour)}:${pad(minute)}`, temp });
  }
  return out;
}

/** A day type's six periods from what the device reported, or null until both halves are known. */
export function programOf(reported: Record<string, unknown> | undefined, day: DayType): Period[] | null {
  const [am, pm] = PROGRAM_POINTS[day].map((dp) => periodsOf(reported?.[dp]));
  return am === null || pm === null ? null : [...am, ...pm];
}

/** How a program reads on the device screen: "06:00 21°, 08:00 18°, …". */
export const programText = (periods: Period[] | null): string | null =>
  periods === null ? null : periods.map((p) => `${p.time} ${p.temp}°`).join(", ");

/** The data points that set a day type to these six periods. Throws on anything the device couldn't hold. */
export function programWrite(day: DayType, periods: unknown): Record<string, string> {
  if (!Array.isArray(periods) || periods.length !== 6) throw new Error(`the ${day} program needs 6 periods`);
  const bytes: number[] = [];
  periods.forEach((p: any, i: number) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(p?.time ?? ""));
    const temp = p?.temp;
    if (m === null) throw new Error(`${day} period ${i + 1}: the time must be HH:MM`);
    if (!Number.isInteger(temp) || temp < 5 || temp > 35) throw new Error(`${day} period ${i + 1}: the temperature must be a whole 5 to 35 °C`);
    bytes.push(Number(m[1]), Number(m[2]), temp);
  });
  for (let i = 1; i < 6; i++) {
    if (periods[i].time <= periods[i - 1].time) throw new Error(`${day} period ${i + 1} must start after period ${i}`);
  }
  const [am, pm] = PROGRAM_POINTS[day];
  return { [am]: toBase64(bytes.slice(0, 9)), [pm]: toBase64(bytes.slice(9)) };
}
