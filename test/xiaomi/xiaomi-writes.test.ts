import { describe, expect, it, vi, afterEach } from "vitest";
import { load, IP, Miio, network, devicesFile, device, properties, LAMP_VALUES, SPEC_BASE, type Answer } from "./xiaomi-fake";
import { doc, prop, service, urnOf } from "./xiaomi-spec-docs";

// Commands sent to a device: an older family's own names, a colour's hue and saturation, a scaled value and an enum name.

afterEach(() => {
  vi.useRealTimers();
});

const OK = (method: string): Answer => (method.startsWith("set_") || method === "action" ? { result: ["ok"] } : undefined);

describe("xiaomi: older devices' own commands", () => {
  it("turns a plug on and off with its own on and off commands, with no arguments", async () => {
    const def = await load();
    const plug = new Miio(IP, 1234567, (method) => (["set_on", "set_off", "set_usb_on", "set_usb_off"].includes(method) ? { result: ["ok"] } : undefined));
    const host = network([plug], { settings: { devices: devicesFile(device({ model: "chuangmi.plug.v1" })) } });
    def.devices.write(host.ctx, "1234567", "power", true);
    def.devices.write(host.ctx, "1234567", "power", false);
    def.devices.write(host.ctx, "1234567", "usb", true);
    expect(plug.methods("set_on")[0].params).toEqual([]);
    expect(plug.methods("set_off")[0].params).toEqual([]);
    expect(plug.methods("set_usb_on")[0].params).toEqual([]);
    expect(plug.methods("set_power")).toHaveLength(0);
  });

  it("refuses a plug switched to a value that is neither on nor off, and sends nothing", async () => {
    const def = await load();
    const plug = new Miio(IP, 1234567, OK);
    const host = network([plug], { settings: { devices: devicesFile(device({ model: "chuangmi.plug.v1" })) } });
    expect(() => def.devices.write(host.ctx, "1234567", "power", 5 as any)).toThrow("power has no command");
    expect(plug.calls).toHaveLength(0);
  });

  it("sends a purifier's mode by name, with no extra argument", async () => {
    const def = await load();
    const purifier = new Miio(IP, 1234567, OK);
    const host = network([purifier], { settings: { devices: devicesFile(device({ model: "zhimi.airpurifier.v2" })) } });
    def.devices.write(host.ctx, "1234567", "mode", "silent");
    expect(purifier.methods("set_mode")[0].params).toEqual(["silent"]);
  });

  it("accepts an older device's change answered with a plain ok rather than a list", async () => {
    const def = await load();
    const light = new Miio(IP, 1234567, (method) => (method === "set_power" ? { result: "ok" } : undefined));
    const host = network([light], { settings: { devices: devicesFile(device({ model: "yeelink.light.lamp2" })) } });
    expect(() => def.devices.write(host.ctx, "1234567", "power", true)).not.toThrow();
    expect(light.methods("set_power")[0].params).toEqual(["on", "smooth", 500]);
  });
});

describe("xiaomi: colours and scaled values", () => {
  const colourSpec = doc(service(2, "light", [prop(1, "color", "uint32", ["read", "write"]), prop(2, "gain", "float", ["read", "write"], { "value-range": [0, 100, 0.5] })]));

  it("sends a new hue at the colour's current saturation, and a new saturation at its hue", async () => {
    // Red at full saturation, so hue 120 is pure green at full saturation: 0x00ff00 is 65280.
    const { def, host, lamp } = await specWrites(colourSpec, { "2.1": 0xff0000, "2.2": 0 });
    def.devices.write(host.ctx, "1234567", "color_hue", 120);
    // Then saturation 50 at hue 120: channels 128, 255, 128, which is 0x80ff80.
    def.devices.write(host.ctx, "1234567", "color_saturation", 50);
    expect(lamp.methods("set_properties").map((c) => c.params[0])).toEqual([
      { did: "2.1", siid: 2, piid: 1, value: 65280 },
      { did: "2.1", siid: 2, piid: 1, value: 8454016 },
    ]);
  });

  it("uses full saturation for a hue written before any colour was read", async () => {
    const { def, host, lamp } = await specWrites(colourSpec, {}, true);
    def.devices.write(host.ctx, "1234567", "color_hue", 240);
    // Blue at full saturation is 0x0000ff, which is 255.
    expect(lamp.methods("set_properties")[0].params[0]).toMatchObject({ did: "2.1", value: 255 });
  });

  it("uses hue zero for a saturation written before any colour was read", async () => {
    const { def, host, lamp } = await specWrites(colourSpec, {}, true);
    def.devices.write(host.ctx, "1234567", "color_saturation", 100);
    // Hue zero at full saturation is pure red, 0xff0000, which is 16711680.
    expect(lamp.methods("set_properties")[0].params[0]).toMatchObject({ did: "2.1", value: 16711680 });
  });

  it("sends a scaled value at the device's own decimals: 205 at one decimal is 20.5", async () => {
    const { def, host, lamp } = await specWrites(colourSpec, {}, true);
    def.devices.write(host.ctx, "1234567", "gain", 205);
    def.devices.write(host.ctx, "1234567", "gain", 3);
    expect(lamp.methods("set_properties").map((c) => c.params[0].value)).toEqual([20.5, 0.3]);
  });

  it("sends an enum name the table doesn't know to the device as written, and leaves the device to refuse it", async () => {
    const def = await load();
    const lamp = new Miio(IP, 1234567, (method, params) => (method === "set_properties" ? { result: params.map(() => ({ code: -4003 })) } : properties(LAMP_VALUES)(method, params)));
    const host = network([lamp], { settings: { devices: devicesFile(device()) } });
    expect(() => def.devices.write(host.ctx, "1234567", "mode", "sunset")).toThrow("mode: device refused");
    expect(lamp.methods("set_properties")[0].params[0]).toMatchObject({ did: "2.3", value: "sunset" });
  });

  it("reports a write the device answers with an error, with the error", async () => {
    const def = await load();
    const lamp = new Miio(IP, 1234567, (method) => (method === "set_properties" ? { error: { code: -1, message: "busy" } } : undefined));
    const host = network([lamp], { settings: { devices: devicesFile(device()) } });
    expect(() => def.devices.write(host.ctx, "1234567", "power", true)).toThrow('set_properties: {"code":-1,"message":"busy"}');
  });
});

/**
 * A spec device whose property writes answer ok, polled once. `silent` makes that poll get no reply, so nothing is read and
 * the writes start from no known colour.
 */
async function specWrites(spec: unknown, values: Record<string, unknown>, silent = false) {
  const def = await load();
  const urn = urnOf("light");
  const lamp = new Miio(IP, 1234567, (method, params) => {
    if (method === "set_properties") return { result: params.map(() => ({ code: 0 })) };
    return properties(values)(method, params);
  });
  lamp.silent = silent;
  const host = network([lamp], {
    settings: { devices: devicesFile(device({ model: "acme.thing.x", spec_type: urn })) },
    fetch: (url) => (url === SPEC_BASE + urn ? { body: spec } : { status: 404 }),
  });
  def.devices.poll(host.ctx);
  lamp.silent = false;
  return { def, host, lamp };
}
