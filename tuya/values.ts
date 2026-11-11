// How a Tuya data point reads and writes: its type and range from the devices file, shown as the page and scripts see it.
// Only a device's category and mapping come in here; its local key stays in extension.ts.
import { colourMax, colourWords, isColourCode, parseColour } from "./colour";
import { codeWritable, scaleOf, type Mapping } from "./rules";

/** The part of a device these need. */
export interface Mapped {
  category: string;
  mapping: Record<string, Mapping>;
}

export function valuesOf(m: Mapping): Record<string, any> {
  return m.values !== null && typeof m.values === "object" && !Array.isArray(m.values) ? m.values as Record<string, any> : {};
}

/** The cloud mapping has no read/write flag, and is sometimes for another firmware: never write a type the device isn't using. */
export function writable(d: Mapped, m: Mapping, value: unknown): boolean {
  if (!codeWritable(d.category, m.code)) return false;
  const unknown = value === undefined || value === null;
  if (m.type === "Boolean") return unknown || typeof value === "boolean";
  if (m.type === "Enum") return Array.isArray(valuesOf(m).range) && (unknown || typeof value === "string");
  if (m.type === "Integer") return unknown || typeof value === "number";
  return false;
}

/** Bitmap as the names of its set bits, colour as words, and anything else as sent. A bit with no name keeps the number. */
export function readable(m: Mapping, values: Record<string, any>, value: unknown): string {
  if (m.type === "Bitmap" && typeof value === "number" && value > 0 && Array.isArray(values.label) && value < 2 ** values.label.length) {
    return values.label.filter((_: unknown, bit: number) => value & (1 << bit)).join(", ");
  }
  const colour = isColourCode(m.code) ? parseColour(value) : null;
  if (colour !== null) return colourWords(colour, colourMax(colour, m.code, values));
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Thermostats like this home's report the target range set on the device itself, data points 113 (lowest) and 114
 * (highest) in whole degrees, though the cloud mapping leaves both out. temp_set takes that range, so a slider spans
 * what the thermostat accepts and follows a change made on it. Without both, or with a range past the declared one,
 * temp_set stays as declared.
 * shortcut: 113/114 are this thermostat family's numbers (TS0601); check another wk model's points before trusting them.
 */
export function deviceRange(category: string, values: DeviceValue[], reported: Record<string, unknown> | undefined): DeviceValue[] {
  const lo = reported?.["113"], hi = reported?.["114"];
  if (category !== "wk" || !Number.isInteger(lo) || !Number.isInteger(hi) || (lo as number) >= (hi as number)) return values;
  return values.map((v) => {
    if (v.code !== "temp_set" || v.type !== "Integer") return v;
    const factor = 10 ** (v.scale ?? 0);
    const min = (lo as number) * factor, max = (hi as number) * factor;
    if ((v.min !== undefined && min < v.min) || (v.max !== undefined && max > v.max)) return v;
    return { ...v, min, max };
  });
}

export function declare(d: Mapped, m: Mapping, value: unknown): DeviceValue {
  const known = value === undefined ? null : value;
  const values = valuesOf(m);
  const unit = values.unit === "度" ? "kWh" : values.unit; // the cloud reports kilowatt-hours under their Chinese name
  const base = typeof unit === "string" && unit !== "" ? { unit } : {};
  if (m.type !== "Boolean" && m.type !== "Enum" && m.type !== "Integer") {
    const text = known === null ? null : readable(m, values, known);
    return { code: m.code, type: "String", value: text, ...base };
  }
  // Thermostats declare c_f as an Enum but send a boolean; every one reads °C while it's false.
  const shown = m.type === "Enum" && typeof known === "boolean" && Array.isArray(values.range) && values.range.length === 2 ? values.range[known ? 1 : 0] : known;
  const out: DeviceValue = { code: m.code, type: m.type, writable: writable(d, m, known), value: shown as DeviceValue["value"], ...base };
  if (Array.isArray(values.range)) out.range = values.range.filter((r: unknown) => typeof r === "string");
  if (typeof values.min === "number") out.min = values.min;
  if (typeof values.max === "number") out.max = values.max;
  if (typeof values.step === "number") out.step = values.step;
  const scale = scaleOf(d.category, m.code, values);
  if (scale !== undefined) out.scale = scale;
  return out;
}

/** A light's colour_data, if this device has one to change. */
export function colourPoint(d: Mapped): { dp: string; m: Mapping } | undefined {
  const dp = Object.keys(d.mapping).find((k) => isColourCode(d.mapping[k].code) && codeWritable(d.category, d.mapping[k].code));
  return dp === undefined ? undefined : { dp, m: d.mapping[dp] };
}
