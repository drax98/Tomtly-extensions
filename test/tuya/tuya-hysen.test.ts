import { describe, expect, it } from "vitest";
import { valuesByCode } from "../harness";
import { fromBase64, programOf, programText, programWrite, toBase64 } from "../../tuya/hysen";
import { load, IP, TuyaDevice, network, file, settingsFor, run, gatewayFile, byId } from "./tuya-fake";

// Six periods as [hour, minute, °C], the way the thermostat holds a day type.
const WORKDAY = [[6, 0, 21], [8, 0, 18], [11, 30, 18], [12, 30, 18], [17, 0, 21], [22, 0, 18]];
const periods = (rows: number[][]) => rows.map(([h, m, t]) => ({ time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, temp: t }));
const half = (rows: number[][]) => toBase64(rows.flat());

describe("tuya hysen: the program's bytes", () => {
  it("round-trips base64, odd lengths included", () => {
    for (const bytes of [[], [1], [1, 2], [6, 0, 21, 8, 0, 18, 11, 30, 18], [255, 0, 128, 7]]) {
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
    expect(toBase64([6, 0, 21])).toBe(Buffer.from([6, 0, 21]).toString("base64"));
    expect(fromBase64("not base64!")).toBeNull();
  });

  it("reads a day type only once both halves are known, and as text", () => {
    const reported = { "119": half(WORKDAY.slice(0, 3)), "120": half(WORKDAY.slice(3)) };
    expect(programOf(reported, "workday")).toEqual(periods(WORKDAY));
    expect(programText(programOf(reported, "workday"))).toBe("06:00 21°, 08:00 18°, 11:30 18°, 12:30 18°, 17:00 21°, 22:00 18°");
    expect(programOf({ "119": reported["119"] }, "workday")).toBeNull();
    expect(programOf(reported, "weekend")).toBeNull();
    expect(programOf({ "119": half([[24, 0, 21], [8, 0, 18], [9, 0, 18]]), "120": reported["120"] }, "workday")).toBeNull(); // hour 24
    // As a real HY08WE sent Arek's program back after a write: 22 came back as 150, with a flag in the top bit.
    expect(programText(programOf({ "119": "CAAWCAAUCx4U", "120": "DR4UEQAUljsS" }, "workday"))).toBe("08:00 22°, 08:00 20°, 11:30 20°, 13:30 20°, 17:00 20°, 22:59 18°");
  });

  it("writes six valid periods as two data points, and refuses anything else", () => {
    expect(programWrite("workday", periods(WORKDAY))).toEqual({ "119": half(WORKDAY.slice(0, 3)), "120": half(WORKDAY.slice(3)) });
    expect(Object.keys(programWrite("weekend", periods(WORKDAY)))).toEqual(["121", "122"]);
    expect(() => programWrite("workday", periods(WORKDAY.slice(0, 5)))).toThrow("needs 6 periods");
    expect(() => programWrite("workday", [...periods(WORKDAY.slice(0, 5)), { time: "7:00", temp: 18 }])).toThrow("period 6: the time must be HH:MM");
    expect(() => programWrite("workday", [...periods(WORKDAY.slice(0, 5)), { time: "23:00", temp: 18.5 }])).toThrow("period 6: the temperature must be a whole 5 to 35");
    expect(() => programWrite("workday", [...periods(WORKDAY.slice(0, 5)), { time: "23:00", temp: 40 }])).toThrow("whole 5 to 35");
    expect(() => programWrite("workday", [...periods(WORKDAY.slice(0, 5)), { time: "16:00", temp: 18 }])).toThrow("period 6 must start after period 5");
    // Two periods at the same time is a mistake in a program, never written.
    const twice = [[8, 0, 22], [8, 0, 20], [11, 30, 20], [13, 30, 20], [17, 0, 20], [22, 59, 18]];
    expect(() => programWrite("workday", periods(twice))).toThrow("period 2 must start after period 1");
  });
});

describe("tuya hysen: a HY08WE behind a gateway", () => {
  // As a real HY08WE's devices-file entry maps it: everything else is added by the extension.
  const HY_MAPPING = {
    "101": { code: "c_f", type: "Enum", values: { range: ["C", "F"] } },
    "125": { code: "switch", type: "Boolean", values: {} },
    "126": { code: "temp_set", type: "Integer", values: { unit: "°C", min: 5, max: 700, scale: 1, step: 5 } },
    "127": { code: "temp_current", type: "Integer", values: { unit: "°C", min: 0, max: 900, scale: 0, step: 1 } },
  };
  const HY = { "101": false, "102": false, "125": true, "126": 210, "127": 205, "109": 0, "110": 5, "112": 45, "114": 30, "115": 9, "116": "in", "117": "keep", "118": "0days", "128": "Program", "129": false };
  const setup = async (dps: Record<string, unknown> = HY, storage?: Map<string, unknown>) => {
    const def = await load();
    const dev = new TuyaDevice(IP, { version: "3.4", dps: { "cid-th": dps } });
    const files = gatewayFile().map((d) => (d.id === "th1" ? { ...d, model: "HY08WE-Zigbee", mapping: HY_MAPPING } : d));
    const host = network([dev], settingsFor(file(...files), `gw1=${IP}@3.4`));
    if (storage) for (const [k, v] of storage) host.storage.set(k, v);
    run(def, host, 6);
    return { def, dev, host, values: () => valuesByCode(byId(def.devices.poll(host.ctx), "th1")) };
  };

  it("shows its mode, child lock and settings, the rare ones advanced and the risky ones read-only", async () => {
    const { values } = await setup();
    const v = values();
    expect(v.mode).toMatchObject({ type: "Enum", writable: true, value: "Program", range: ["Manual", "Program"] });
    expect(v.mode.advanced).toBeUndefined();
    expect(v.child_lock).toMatchObject({ type: "Boolean", writable: true, value: false });
    expect(v.temp_correction).toMatchObject({ type: "Integer", writable: true, value: 0, scale: 1, min: -90, max: 90, advanced: true });
    expect(v.hysteresis).toMatchObject({ writable: true, value: 5, scale: 1, advanced: true });
    expect(v.lower_temp).toMatchObject({ writable: true, value: 9, advanced: true });
    expect(v.upper_temp).toMatchObject({ writable: true, value: 30, advanced: true });
    expect(v.floor_limit).toMatchObject({ writable: false, value: 45, advanced: true });
    expect(v.sensor).toMatchObject({ type: "String", value: "in", advanced: true });
    expect(v.weekend_days).toMatchObject({ type: "Enum", writable: true, value: "0days", range: ["0days", "1days", "2days"], advanced: true });
    expect(v.temp_set).toMatchObject({ min: 90, max: 300 }); // the slider spans 115 to 114
    expect(v.program_workday).toMatchObject({ type: "String", value: null });
  });

  it("keeps showing a mode it entered by itself, and can still be switched", async () => {
    const { def, dev, host, values } = await setup({ ...HY, "128": "TempProg" });
    expect(values().mode).toMatchObject({ value: "TempProg", writable: true });
    def.devices.write(host.ctx, "th1", "mode", "Program");
    expect(dev.controls.at(-1)?.json.data.dps).toEqual({ "128": "Program" });
  });

  it("shows a program once the thermostat sends it, and remembers it across a restart", async () => {
    const { def, dev, host, values } = await setup();
    dev.push("cid-th", { "119": half(WORKDAY.slice(0, 3)), "120": half(WORKDAY.slice(3)) });
    run(def, host, 2);
    expect(values().program_workday.value).toBe("06:00 21°, 08:00 18°, 11:30 18°, 12:30 18°, 17:00 21°, 22:00 18°");
    const again = await setup(HY, new Map(host.storage)); // the device won't send it again
    expect(again.values().program_workday.value).toBe("06:00 21°, 08:00 18°, 11:30 18°, 12:30 18°, 17:00 21°, 22:00 18°");
    expect(again.values().program_weekend.value).toBeNull();
  });

  it("writes a program through setProgram, and sends nothing for an invalid one or another device", async () => {
    const { def, dev, host } = await setup();
    def.actions.setProgram(host.ctx, { device: "th1", workday: periods(WORKDAY) });
    expect(dev.controls.at(-1)?.json.data.dps).toEqual({ "119": half(WORKDAY.slice(0, 3)), "120": half(WORKDAY.slice(3)) });
    const sent = dev.controls.length;
    expect(() => def.actions.setProgram(host.ctx, { device: "th1", workday: periods(WORKDAY.slice(0, 4)) })).toThrow("needs 6 periods");
    expect(() => def.actions.setProgram(host.ctx, { device: "th1" })).toThrow("give a workday or weekend program");
    expect(() => def.actions.setProgram(host.ctx, { device: "door1", workday: periods(WORKDAY) })).toThrow("isn't a thermostat with a program");
    expect(() => def.actions.setProgram(host.ctx, { device: "nobody", workday: periods(WORKDAY) })).toThrow("unknown device nobody");
    expect(dev.controls).toHaveLength(sent);
  });

  it("never adds a code the device's own mapping already has", async () => {
    const { values } = await setup();
    const codes = Object.keys(values());
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("adds none of this to a thermostat of another model", async () => {
    const def = await load();
    const dev = new TuyaDevice(IP, { version: "3.4", dps: { "cid-th": HY } });
    const host = network([dev], settingsFor(file(...gatewayFile()), `gw1=${IP}@3.4`));
    run(def, host, 6);
    const v = valuesByCode(byId(def.devices.poll(host.ctx), "th1"));
    expect(v.mode.range).toEqual(["auto", "manual"]); // its own, from its mapping
    expect(v.child_lock).toBeUndefined();
    expect(v.program_workday).toBeUndefined();
  });
});
