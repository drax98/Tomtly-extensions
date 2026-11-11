import { describe, expect, it } from "vitest";
import { action, doc, pollSpec, prop, service } from "./xiaomi-spec-docs";

// Which of a model's spec properties become values, and what each is called. The rules are checked through a poll, since
// that is how a device's card comes to show them.

describe("xiaomi: which spec properties a device gets", () => {
  it("keeps a property it can read or write under a sound name, and drops what it can't use", async () => {
    const spec = doc(
      service(2, "light", [
        prop(1, "on", "bool", ["read", "write"]),
        prop(2, "level", "uint8", ["read", "write"], { "value-range": [1, 100, 1], unit: "percentage" }),
        { iid: 3, type: 5, format: "bool", access: ["read"] }, // a type that isn't a string
        { iid: 4, type: "urn:miot-spec-v2:property", format: "bool", access: ["read"] }, // a type with no name
        prop(5, "Bad$Name", "bool", ["read"]), // a name the safe pattern refuses
        { iid: 6, type: `urn:miot-spec-v2:property:no-access:00000001:${"acme-x"}:1`, format: "uint8" }, // no access list
        { ...prop(7, "stray", "uint8", ["read"]), iid: "7" }, // an iid that isn't a number
        prop(8, "debug-level", "uint8", ["read"]), // a debug property
        prop(9, "wide", "uint64", ["read"]), // a format the page can't show
        prop(10, "mood", "uint8", ["read", "write"], { "value-list": [] }), // an empty list is a plain number
        prop(11, "tint", "uint8", ["read"], { "value-list": [{ value: 3, description: 7 }, { value: 4, description: "Warm" }] }),
        prop(12, "sample", "uint8", ["write"]), // write-only, and it has no range
        prop(13, "switch-mode", "bool", ["write"]), // write-only, but it can be set
        prop(14, "status-text", "string", ["read"]),
        prop(15, "gain", "float", ["read", "write"], { "value-range": [0, 100, 0.5], unit: "percentage" }),
        prop(16, "offset", "float", ["read", "write"]),
        prop(17, "tiny", "float", ["read", "write"], { "value-range": [0, 1, 0.0001] }),
        prop(18, "range-ro", "float", ["read"], { "value-range": [0, 100, 1] }),
        prop(19, "written-text", "string", ["write"]), // write-only text: the host can't send text
      ]),
    );
    const { card, values, codes } = await pollSpec(spec, {
      "2.1": true,
      "2.2": 80,
      "2.10": 2,
      "2.11": 4,
      "2.13": false,
      "2.14": "ok",
      "2.15": 20.5,
      "2.16": 21.456,
      "2.17": 0.123456,
      "2.18": 33.333,
    });

    expect(codes).toEqual(["power", "level", "mood", "tint", "switch_mode", "status_text", "gain", "offset", "tiny", "range_ro"]);
    expect(card).toMatchObject({ kind: "light", online: true });
    expect(values.power).toMatchObject({ type: "Boolean", writable: true, value: true });
    expect(values.level).toMatchObject({ type: "Integer", writable: true, value: 80, min: 1, max: 100, step: 1, unit: "%" });
    expect(values.mood).toMatchObject({ type: "Integer", writable: false, value: 2 });
    expect(values.tint).toMatchObject({ type: "Enum", writable: false, value: "warm", range: ["3", "warm"] });
    expect(values.switch_mode).toMatchObject({ type: "Boolean", writable: true, value: null });
    expect(values.status_text).toMatchObject({ type: "String", writable: false, value: "ok" });
    // A float with a 0.5 step is kept as a whole number of halves: 20.5 is 205 at scale 1.
    expect(values.gain).toMatchObject({ type: "Integer", writable: true, value: 205, scale: 1, min: 0, max: 1000, step: 5, unit: "%" });
    // A writable float with no range is only shown, to four decimals.
    expect(values.offset).toMatchObject({ type: "Number", writable: false, value: 21.456 });
    // A step too fine to keep as a whole number is read-only too.
    expect(values.tiny).toMatchObject({ type: "Number", writable: false, value: 0.1235 });
    expect(values.range_ro).toMatchObject({ type: "Number", writable: false, value: 33.333 });
  });

  it("names each choice by what it says, numbers one that says nothing, and numbers a repeat", async () => {
    const spec = doc(
      service(2, "light", [
        prop(1, "mode", "uint8", ["read", "write"], {
          "value-list": [
            { value: 0, description: "Auto" },
            { value: 1, description: "auto" },
            { value: 2, description: "" },
            { value: 3, description: "Factory reset" },
          ],
        }),
      ]),
    );
    const { values } = await pollSpec(spec, { "2.1": 3 });
    // "Factory reset" is shown by name when it's the current choice, but it can't be picked.
    expect(values.mode).toMatchObject({ type: "Enum", writable: true, value: "factory reset", range: ["auto", "auto (1)", "2"] });
  });

  it("gives a cover its card's words: pause is stop, and the position and control codes", async () => {
    const spec = doc(
      service(2, "curtain", [
        prop(1, "motor-control", "uint8", ["read", "write"], {
          "value-list": [
            { value: 0, description: "Pause" },
            { value: 1, description: "Open" },
            { value: 2, description: "Close" },
          ],
        }),
        prop(2, "target-position", "uint8", ["read", "write"], { "value-range": [0, 100, 1] }),
        prop(3, "current-position", "uint8", ["read"], { "value-range": [0, 100, 1] }),
      ]),
    );
    const { card, values, codes } = await pollSpec(spec, { "2.1": 0, "2.2": 40, "2.3": 60 }, { type: "curtain" });
    expect(card.kind).toBe("cover");
    expect(codes).toEqual(["control", "percent_control", "percent_state"]);
    expect(values.control).toMatchObject({ type: "Enum", value: "stop", range: ["stop", "open", "close"] });
    expect(values.percent_control).toMatchObject({ type: "Integer", writable: true, value: 40, min: 0, max: 100 });
    expect(values.percent_state).toMatchObject({ type: "Integer", writable: false, value: 60 });
  });

  it("names a climate's temperatures as the page reads them, and leaves its other properties their own names", async () => {
    const spec = doc(
      service(2, "air-conditioner", [
        prop(1, "temperature", "float", ["read"], { unit: "celsius" }),
        prop(2, "target-temperature", "float", ["read", "write"], { "value-range": [16, 30, 1], unit: "celsius" }),
        prop(3, "fan-level", "uint8", ["read"]),
      ]),
    );
    const { card, values, codes } = await pollSpec(spec, { "2.1": 21.5, "2.2": 24, "2.3": 2 }, { type: "air-conditioner" });
    expect(card.kind).toBe("climate");
    expect(codes).toEqual(["temp_current", "temp_set", "fan_level"]);
    expect(values.temp_current).toMatchObject({ type: "Number", value: 21.5, unit: "°C" });
    expect(values.temp_set).toMatchObject({ type: "Integer", writable: true, value: 24, min: 16, max: 30, unit: "°C" });
  });

  it("names a vacuum's main service the way its card does, and says its actions by what they do", async () => {
    const spec = doc(
      service(
        2,
        "vacuum",
        [
          prop(1, "status", "uint8", ["read"], { "value-list": [{ value: 5, description: "Cleaning" }] }),
          prop(2, "mode", "uint8", ["read", "write"], { "value-list": [{ value: 0, description: "Silent" }, { value: 1, description: "Standard" }] }),
          prop(3, "fault", "uint8", ["read"]),
          prop(4, "battery", "uint8", ["read"], { unit: "percentage" }),
          prop(5, "charging", "uint8", ["read"]),
        ],
        [action(3, "start-sweep"), action(4, "identify"), action(5, "some-thing")],
      ),
    );
    const { values, codes } = await pollSpec(spec, { "2.1": 5, "2.2": 1, "2.3": 0, "2.4": 88, "2.5": 1 }, { type: "vacuum" });
    expect(codes).toEqual(["state", "fan_speed", "error_code", "battery", "charging", "command"]);
    expect(values.state).toMatchObject({ type: "Enum", value: "cleaning", writable: false });
    expect(values.fan_speed).toMatchObject({ type: "Enum", writable: true, value: "standard", range: ["silent", "standard"] });
    expect(values.battery).toMatchObject({ type: "Integer", value: 88, unit: "%" });
    expect(values.command).toMatchObject({ type: "Action", range: ["start", "find", "some_thing"] });
  });

  it("gives a battery level on a vacuum's or a cover's main service the shared name", async () => {
    for (const [type, name] of [["vacuum", "vacuum"], ["curtain", "curtain"]]) {
      const spec = doc(service(2, name, [prop(1, "battery-level", "uint8", ["read"], { unit: "percentage" })]));
      const { codes, values } = await pollSpec(spec, { "2.1": 64 }, { type });
      expect(codes).toContain("battery");
      expect(values.battery).toMatchObject({ type: "Integer", value: 64 });
    }
  });

  it("names a switch's channels when it has several, and an on switch under another service by its own name", async () => {
    const spec = doc(
      service(2, "switch", [prop(1, "on", "bool", ["read", "write"])]),
      service(3, "switch", [prop(1, "on", "bool", ["read", "write"])]),
      service(4, "switch", [prop(1, "status", "bool", ["read"])]), // a switch with no on, so it isn't a channel
      service(5, "sensor", [prop(1, "on", "bool", ["read", "write"])]),
    );
    const { codes, values } = await pollSpec(spec, { "2.1": true, "3.1": false, "4.1": true, "5.1": true }, { type: "switch" });
    expect(codes).toEqual(["switch_1", "switch_2", "switch_status", "sensor_on"]);
    expect(values.switch_2).toMatchObject({ value: false });
    expect(values.sensor_on).toMatchObject({ type: "Boolean", writable: true, value: true });
  });

  it("takes the device's own service as main, else a switch that isn't an indicator, else the first service", async () => {
    const withSwitch = doc(
      service(2, "indicator", [prop(1, "on", "bool", ["read", "write"])]),
      service(3, "switch", [prop(1, "on", "bool", ["read", "write"])]),
      service(4, "fan", [prop(1, "status", "bool", ["read"])]),
    );
    const a = await pollSpec(withSwitch, { "2.1": true, "3.1": true, "4.1": false }, { type: "acme-thing" });
    expect(a.card.kind).toBe("other");
    expect(a.codes).toEqual(["power", "indicator_on", "fan_status"]);

    const onlyIndicator = doc(service(2, "indicator", [prop(1, "on", "bool", ["read", "write"])]));
    const b = await pollSpec(onlyIndicator, { "2.1": true }, { type: "acme-thing" });
    expect(b.codes).toEqual(["power"]);
  });

  it("gives a smoke sensor no actions, and nothing it reports can be written", async () => {
    const spec = doc(service(2, "smoke-sensor", [prop(1, "smoke-alarm", "bool", ["read", "write"])], [action(1, "test")]));
    const { card, values, codes } = await pollSpec(spec, { "2.1": false }, { type: "smoke-sensor" });
    expect(card.kind).toBe("safety");
    expect(codes).toEqual(["smoke_alarm"]);
    expect(values.smoke_alarm).toMatchObject({ type: "Boolean", writable: false, value: false });
  });

  it("drops a service that has neither properties nor actions, and reads an action-only service", async () => {
    const spec = doc(
      service(2, "light", [prop(1, "on", "bool", ["read", "write"])]),
      { iid: 3, type: "urn:miot-spec-v2:service:bare:00007802:acme-x:1", actions: [] }, // no properties key at all
      { iid: 4, type: "urn:miot-spec-v2:service:remote:00007802:acme-x:1", actions: [action(1, "press")] },
    );
    const { codes, values } = await pollSpec(spec, { "2.1": true });
    expect(codes).toEqual(["power", "command"]);
    expect(values.command).toMatchObject({ range: ["press"] });
  });

  it("keeps only the value and action names a device could be asked for, and never an unsafe one", async () => {
    const spec = doc(
      service(
        2,
        "light",
        [prop(1, "on", "bool", ["read", "write"])],
        [
          action(1, "toggle"),
          action(2, "unlock-door"), // opens something
          action(3, "replace-filter"), // a consumable
          action(4, "with-arguments", { in: [{ piid: 1 }] }), // needs arguments the host can't send
          action(5, "factory-reset"), // unsafe
          { iid: "6", type: "urn:miot-spec-v2:action:bogus:00002801:acme-x:1", in: [] }, // an iid that isn't a number
        ],
      ),
      service(3, "lock", [], [action(1, "lock-now")]), // the lock service's actions are never offered
      service(4, "remote", [], [action(1, "press")]),
      service(5, "lamp", [], [action(1, "toggle")]), // the same name again, so it's named by its service
    );
    const { values } = await pollSpec(spec, { "2.1": true });
    expect(values.command).toMatchObject({ type: "Action", range: ["toggle", "press", "lamp_5_1_toggle"] });
  });

  it("offers at most twenty-four actions", async () => {
    const spec = doc(service(2, "light", [prop(1, "on", "bool", ["read", "write"])], Array.from({ length: 25 }, (_, i) => action(i + 1, `act-${i + 1}`))));
    const { values } = await pollSpec(spec, { "2.1": true });
    expect(values.command.range).toHaveLength(24);
    expect(values.command.range[23]).toBe("act_24");
  });

  it("reads a value a device sends in several forms as the type says, and never guesses", async () => {
    const spec = doc(
      service(2, "light", [
        prop(1, "on", "bool", ["read"]),
        prop(2, "night-mode", "bool", ["read"]),
        prop(3, "flag", "bool", ["read"]),
        prop(4, "level", "uint8", ["read"]),
        prop(5, "gain", "uint8", ["read"]),
        prop(6, "empty", "uint8", ["read"]),
        prop(7, "shaped", "uint8", ["read"]),
        prop(8, "tint", "uint8", ["read"], { "value-list": [{ value: 0, description: "Off" }] }),
        prop(9, "text", "string", ["read"]),
      ]),
    );
    const { values } = await pollSpec(spec, {
      "2.1": "on",
      "2.2": "maybe",
      "2.3": 0,
      "2.4": "42",
      "2.5": "abc",
      "2.6": "",
      "2.7": {},
      "2.8": 9,
      "2.9": { a: 1 },
    });
    expect(values.power.value).toBe(true);
    expect(values.night_mode.value).toBeNull();
    expect(values.flag.value).toBe(false);
    expect(values.level.value).toBe(42);
    expect(values.gain.value).toBeNull();
    expect(values.empty.value).toBeNull();
    expect(values.shaped.value).toBeNull();
    expect(values.tint.value).toBe("9"); // a number no choice names is shown as itself
    expect(values.text.value).toBe('{"a":1}');
  });

  it("shows a colour as #rrggbb with its hue and saturation, and says a colour it can't read is unknown", async () => {
    const spec = doc(
      service(2, "light", [
        prop(1, "color", "uint32", ["read", "write"]),
        prop(2, "led", "uint32", ["read"], { unit: "rgb" }),
        prop(3, "big", "uint32", ["read", "write"], { "value-range": [0, 16777216, 1] }),
        prop(4, "paint", "uint32", ["read"], { unit: "rgb" }),
        prop(5, "shade", "uint32", ["read", "write"], { unit: "rgb" }),
      ]),
    );
    const { codes, values } = await pollSpec(spec, { "2.1": 0x00ff00, "2.2": 0x0000ff, "2.3": 5, "2.4": "red", "2.5": 0x808080 });
    expect(codes).toEqual(["color", "color_hue", "color_saturation", "led", "big", "paint", "shade", "shade_hue", "shade_saturation"]);
    expect(values.color).toMatchObject({ type: "String", writable: false, value: "#00ff00" });
    expect(values.color_hue).toMatchObject({ type: "Integer", writable: true, value: 120, min: 0, max: 360 });
    expect(values.color_saturation).toMatchObject({ type: "Integer", writable: true, value: 100, min: 0, max: 100 });
    expect(values.led).toMatchObject({ value: "#0000ff" });
    expect(values.big).toMatchObject({ type: "Integer", writable: true, value: 5, max: 16777216 });
    expect(values.paint).toMatchObject({ type: "String", value: null });
    expect(values.shade).toMatchObject({ value: "#808080" });
    expect(values.shade_hue).toMatchObject({ value: 0 });
    expect(values.shade_saturation).toMatchObject({ value: 0 });
  });
});

describe("xiaomi: the spec rules at their edges", () => {
  it("drops a write-only property that is a consumable, and a write-only float with no range", async () => {
    const spec = doc(
      service(2, "light", [
        prop(1, "on", "bool", ["read", "write"]),
        prop(2, "filter-set", "uint8", ["write"]), // a filter's life is never set from here
        prop(3, "dim-set", "float", ["write"]), // written but never read, and no range to keep it in
        prop(4, "pct", "uint8", ["read", "write"], { "value-range": [0, 10] }), // no step given: one
        prop(5, "co2", "uint16", ["read"], { unit: "ppm" }), // a unit the table doesn't rename is kept as it is
        prop(6, "range-colour", "uint32", ["read", "write"], { unit: "rgb", "value-range": [0, 16777216, 1] }), // too wide for a colour
      ]),
    );
    const { codes, values } = await pollSpec(spec, { "2.1": true, "2.4": 3, "2.5": 800, "2.6": 9 });
    expect(codes).toEqual(["power", "pct", "co2", "range_colour"]);
    expect(values.pct).toMatchObject({ type: "Integer", writable: true, min: 0, max: 10, step: 1, value: 3 });
    expect(values.co2).toMatchObject({ type: "Integer", writable: false, value: 800, unit: "ppm" });
    expect(values.range_colour).toMatchObject({ type: "Integer", writable: true, value: 9, max: 16777216 });
  });

  it("gives a second property a name with its service and id when the first has taken the name", async () => {
    const spec = doc(
      service(2, "light", [prop(1, "on", "bool", ["read", "write"])]),
      service(3, "sensor", [prop(1, "level", "uint8", ["read"])]),
      service(4, "sensor", [prop(1, "level", "uint8", ["read"])]),
    );
    const { codes, values } = await pollSpec(spec, { "2.1": true, "3.1": 1, "4.1": 2 });
    expect(codes).toEqual(["power", "sensor_level", "sensor_4_1_level"]);
    expect(values.sensor_4_1_level).toMatchObject({ value: 2 });
  });

  it("reads a service that has properties and no actions key", async () => {
    const spec = doc({ iid: 2, type: "urn:miot-spec-v2:service:light:00007802:acme-x:1", properties: [prop(1, "on", "bool", ["read", "write"])] });
    const { codes } = await pollSpec(spec, { "2.1": false });
    expect(codes).toEqual(["power"]);
  });
});
