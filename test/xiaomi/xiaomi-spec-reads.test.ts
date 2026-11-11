import { afterEach, describe, expect, it, vi } from "vitest";
import { load, LAMP_VALUES, IP, Miio, network, devicesFile, device, properties, SPEC_BASE } from "./xiaomi-fake";
import { doc, prop, service, urnOf } from "./xiaomi-spec-docs";
import { valuesByCode } from "../harness";

// Reading a device whose spec is known: its turns, the lists it refuses, the properties it says it lacks, and the older
// commands it falls back to. Each is asserted through the batches the device was asked for and the card it gets.

afterEach(() => {
  vi.useRealTimers();
});

const flags = (n: number, access = ["read"]) => Array.from({ length: n }, (_, i) => prop(i + 1, `flag-${i + 1}`, "bool", access));
const allTrue = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2.${i + 1}`, true]));
const sizes = (lamp: Miio) => lamp.methods("get_properties").map((c) => c.params.length);

/** A spec device, served from `spec` at its own URN, on the address the fake network answers. */
async function specNetwork(lamp: Miio, spec: unknown, type = "light", model = "acme.thing.x") {
  const def = await load();
  const host = network([lamp], {
    settings: { devices: devicesFile(device({ model, spec_type: urnOf(type) })) },
    fetch: (url) => (url === SPEC_BASE + urnOf(type) ? { body: spec } : { status: 404 }),
  });
  return { def, host };
}

describe("xiaomi: reading a device with a spec", () => {
  it("reads a long list in turns, and a turn that runs out of time hands the rest to the next poll", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const values = allTrue(40);
    // Each call takes three seconds, so the eight-second turn ends after the third call.
    const lamp = new Miio(IP, 1234567, (method, params) => {
      vi.setSystemTime(Date.now() + 3_000);
      return properties(values)(method, params);
    });
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(40))));

    const [first] = def.devices.poll(host.ctx);
    expect(sizes(lamp)).toEqual([1, 15, 15]); // one property to test the device, then fifteen at a time
    expect(first.values.filter((v: DeviceValue) => v.value !== null)).toHaveLength(31);

    const [second] = def.devices.poll(host.ctx);
    expect(sizes(lamp).slice(3)).toEqual([9]);
    expect(lamp.methods("get_properties")[3].params[0]).toEqual({ did: "2.32", siid: 2, piid: 32 });
    expect(second).toMatchObject({ online: true });
    expect(second.values.filter((v: DeviceValue) => v.value !== null)).toHaveLength(40);
  });

  it("halves a list the device goes silent on, and goes on with the smaller one", async () => {
    // Past eight properties in one call it says nothing at all, the way a device with a long list does.
    const values = allTrue(20);
    const lamp = new Miio(IP, 1234567, (method, params) => (method === "get_properties" && params.length > 8 ? undefined : properties(values)(method, params)));
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(20))));
    const [card] = def.devices.poll(host.ctx);
    expect(sizes(lamp)).toEqual([1, 15, 15, 7, 7, 5]);
    expect(card).toMatchObject({ online: true });
    expect(card.values.every((v: DeviceValue) => v.value === true)).toBe(true);
  });

  it("cuts a list a device refuses until it takes each property alone", async () => {
    const values = allTrue(6);
    const lamp = new Miio(IP, 1234567, properties(values));
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(6))));
    def.devices.poll(host.ctx); // the device takes the list as it comes

    lamp.answer = (method, params) => (method === "get_properties" && params.length > 2 ? { error: { code: -5001, message: "busy" } } : properties(values)(method, params));
    const [card] = def.devices.poll(host.ctx);
    // Its batch of fifteen becomes seven, then three, then one; each refused call is said to be busy, not to be missing.
    expect(sizes(lamp).slice(2)).toEqual([6, 6, 3, 1, 1, 1, 1, 1, 1]);
    expect(card).toMatchObject({ online: true });
    expect(card.values.every((v: DeviceValue) => v.value === true)).toBe(true);
    expect(host.logs).toEqual([]);
  });

  it("skips one property the device refuses alone, and reads the others; after three refusals it is hidden", async () => {
    const values = allTrue(6);
    const lamp = new Miio(IP, 1234567, (method, params) => {
      if (method === "get_properties" && params.some((p: any) => p.did === "2.3")) return { error: { code: -5001, message: "busy" } };
      return properties(values)(method, params);
    });
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(6))));

    const [one] = def.devices.poll(host.ctx);
    expect(one.values.map((v: DeviceValue) => [v.code, v.value])).toEqual([
      ["flag_1", true],
      ["flag_2", true],
      ["flag_3", null],
      ["flag_4", true],
      ["flag_5", true],
      ["flag_6", true],
    ]);

    const [two] = def.devices.poll(host.ctx);
    expect(two.values.map((v: DeviceValue) => v.code)).toContain("flag_3");
    const [three] = def.devices.poll(host.ctx);
    expect(three.values.map((v: DeviceValue) => v.code)).not.toContain("flag_3");
    expect(three.values).toHaveLength(5);
    expect(three).toMatchObject({ online: true });
  });

  it("hides a property the device says it doesn't have, once three reads have said so", async () => {
    const values = allTrue(6);
    const lamp = new Miio(IP, 1234567, (method, params) => {
      if (method !== "get_properties") return undefined;
      return { result: params.map((p: any) => (p.did === "2.4" ? { did: p.did, code: -4001 } : { did: p.did, code: 0, value: values[p.did] })) };
    });
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(6))));

    const [one] = def.devices.poll(host.ctx);
    expect(valuesByCode(one).flag_4).toMatchObject({ value: null });
    def.devices.poll(host.ctx);
    const [three] = def.devices.poll(host.ctx);
    expect(three.values.map((v: DeviceValue) => v.code)).not.toContain("flag_4");
    expect(valuesByCode(three).flag_5).toMatchObject({ value: true });
    expect(three).toMatchObject({ online: true });
  });

  it("says a device that has none of its properties has none, and shows nothing else", async () => {
    const lamp = new Miio(IP, 1234567, (method) => (method === "get_properties" ? { result: [{ did: "2.1", code: -4001 }, { did: "2.2", code: -4001 }] } : undefined));
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(2))));
    def.devices.poll(host.ctx);
    def.devices.poll(host.ctx);
    const [card] = def.devices.poll(host.ctx);
    expect(card.values).toEqual([{ code: "unavailable", type: "String", value: "It answers, but says it has none of the properties its description lists." }]);
    expect(card).toMatchObject({ online: false });
  });

  it("matches a reply item by its siid and piid when it has no did, and ignores items it can't place", async () => {
    const lamp = new Miio(IP, 1234567, (method) =>
      method === "get_properties"
        ? {
            result: [
              null,
              { siid: 2, piid: 1, value: true }, // no code, but a value: it counts
              { did: "2.2", code: 0, value: 60 },
              { did: "2.3", code: -1, value: 5 }, // a code that means nothing here
              { did: "9.9", code: 0, value: 1 }, // a property the spec doesn't have
            ],
          }
        : undefined,
    );
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", [prop(1, "on", "bool", ["read"]), prop(2, "level", "uint8", ["read"]), prop(3, "gain", "uint8", ["read"])])));
    const [card] = def.devices.poll(host.ctx);
    expect(valuesByCode(card)).toMatchObject({ power: { value: true }, level: { value: 60 }, gain: { value: null } });
    expect(card.values.map((v: DeviceValue) => v.code)).toEqual(["power", "level", "gain"]);
  });

  it("takes a device that answers a read with a plain result for one that doesn't speak MIoT, and says so", async () => {
    const lamp = new Miio(IP, 1234567, (method) => (method === "get_properties" ? { result: "ok" } : undefined));
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(2))));
    const [card] = def.devices.poll(host.ctx);
    expect(host.logs).toContain("Desk lamp doesn't take MIoT reads");
    expect(card).toMatchObject({ online: false });
    expect(valuesByCode(card).unavailable.value).toBe("It answers on your network, but not to MIoT reads, and it isn't a known older model.");
  });

  it("reports a plain result from a device that has answered before as a refused read, and keeps its last values", async () => {
    const values = allTrue(2);
    const lamp = new Miio(IP, 1234567, properties(values));
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(2))));
    def.devices.poll(host.ctx);
    lamp.answer = (method) => (method === "get_properties" ? { result: "ok" } : undefined);
    const [card] = def.devices.poll(host.ctx);
    expect(card).toMatchObject({ online: false });
    expect(valuesByCode(card).flag_1.value).toBe(true);
    expect(host.logs.join("\n")).toContain("get_properties: unexpected reply");
  });

  it("falls back to an older model's own commands when its MIoT reads are refused, and reads them on the next poll", async () => {
    const lamp = new Miio(IP, 1234567, (method) => {
      if (method === "get_properties") return { error: { code: -32601, message: "method not found" } };
      if (method === "get_prop") return { result: ["on", "50", "4000", "16711680", "1", "off"] };
      return undefined;
    });
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(2))), "light", "yeelink.light.lamp2");
    const [first] = def.devices.poll(host.ctx);
    expect(host.logs).toContain("Desk lamp doesn't take MIoT reads, using its older commands");
    expect(first).toMatchObject({ online: false });

    const [second] = def.devices.poll(host.ctx);
    expect(second).toMatchObject({ online: true });
    expect(valuesByCode(second).brightness.value).toBe(50);
    expect(lamp.methods("get_prop")).toHaveLength(1);
  });

  it("takes an older model's commands at once when its description lists nothing it can show", async () => {
    const lamp = new Miio(IP, 1234567, (method) => (method === "get_prop" ? { result: ["on", "50", "4000", "16711680", "1", "off"] } : undefined));
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", [])), "light", "yeelink.light.lamp2");
    const [card] = def.devices.poll(host.ctx);
    expect(card).toMatchObject({ online: true });
    expect(valuesByCode(card).brightness.value).toBe(50);
  });
});

describe("xiaomi: older devices read with their own commands", () => {
  it("refuses an older light whose get_prop reply isn't a list, and goes offline with that reason", async () => {
    const def = await load();
    const light = new Miio(IP, 1234567, (method) => (method === "get_prop" ? { result: ["on", "50", "4000", "16711680", "1", "off"] } : undefined));
    const host = network([light], { settings: { devices: devicesFile(device({ model: "yeelink.light.lamp2" })) } });
    def.devices.poll(host.ctx);
    light.answer = (method) => (method === "get_prop" ? { result: "ok" } : undefined);
    const [card] = def.devices.poll(host.ctx);
    expect(card).toMatchObject({ online: false });
    expect(host.logs.join("\n")).toContain("get_prop: unexpected reply");
  });

  it("takes a gateway's own calls when they answer with a plain value, not a list", async () => {
    const def = await load();
    const gateway = new Miio(IP, 1234567, (method) => {
      if (method === "get_arming") return { result: 1 };
      if (method === "get_rgb") return { result: 255 };
      return undefined;
    });
    const host = network([gateway], { settings: { devices: devicesFile(device({ model: "lumi.gateway.v3" })) } });
    const values = valuesByCode(def.devices.poll(host.ctx)[0]);
    expect(values.arming.value).toBe(true);
    expect(values.light_color.value).toBe("#0000ff");
  });

  it("shows a table device's refused property as unknown, and ignores a reply about a property it doesn't have", async () => {
    const def = await load();
    const lamp = new Miio(IP, 1234567, (method, params) =>
      method === "get_properties"
        ? { result: params.map((p: any) => (p.did === "2.4" ? { did: "2.4", code: -4001 } : { did: p.did, code: 0, value: (LAMP_VALUES as any)[p.did] })).concat([{ did: "7.7", code: 0, value: 1 }]) }
        : undefined,
    );
    const host = network([lamp], { settings: { devices: devicesFile(device()) } });
    const [card] = def.devices.poll(host.ctx);
    expect(card).toMatchObject({ online: true });
    expect(valuesByCode(card).color_temperature.value).toBeNull();
    expect(valuesByCode(card).brightness.value).toBe(60);
    expect(card.values.map((v: DeviceValue) => v.code)).not.toContain("7.7");
  });

  it("reads a Roborock's status with an empty field as unknown, and a counter that isn't a number as unknown", async () => {
    const def = await load();
    const status = [{ fan_power: 102, state: 5, error_code: 0, clean_time: 600, clean_area: 2400000, dnd_enabled: 0, map_present: 1 }]; // no battery
    const vacuum = new Miio(IP, 1234567, (method) => {
      if (method === "get_status") return { result: status };
      if (method === "get_consumable") return { result: ["a", "b", "c", "d"] }; // a list of text, not counters
      return undefined;
    });
    const host = network([vacuum], { settings: { devices: devicesFile(device({ model: "roborock.vacuum.s5" })) } });
    const [card] = def.devices.poll(host.ctx);
    expect(card).toMatchObject({ online: true });
    expect(valuesByCode(card).battery.value).toBeNull();
    expect(valuesByCode(card).main_brush_hours.value).toBeNull();
    expect(valuesByCode(card).state.value).toBe("cleaning");
  });
});

describe("xiaomi: a device refusing from its first read", () => {
  it("goes offline with no values when its first single read is refused, since nothing has answered yet", async () => {
    const lamp = new Miio(IP, 1234567, (method) => (method === "get_properties" ? { error: { code: -5001, message: "busy" } } : undefined));
    const { def, host } = await specNetwork(lamp, doc(service(2, "light", flags(3))));
    const [card] = def.devices.poll(host.ctx);
    expect(card).toMatchObject({ online: false });
    expect(card.values.every((v: DeviceValue) => v.value === null)).toBe(true);
    expect(lamp.methods("get_properties")).toHaveLength(1);
  });
});
