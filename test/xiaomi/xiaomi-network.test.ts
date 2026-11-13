import { afterEach, describe, expect, it, vi } from "vitest";
import { crypto, makeHost, TIMEOUT, valuesByCode } from "../harness";
import { load, HELLO, IP, Miio, network, devicesFile, device, properties, LAMP_VALUES, TOKEN } from "./xiaomi-fake";

// Addresses and ids in the devices file, the search for a device that moved, the turn budget, and what the wire protocol
// does with a reply that isn't one of ours.

afterEach(() => {
  vi.useRealTimers();
});

const u32 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

describe("xiaomi: the addresses and ids in the devices file", () => {
  it("says a device with no model is not a known older one, and a device with no address is behind a gateway", async () => {
    const def = await load();
    const host = network([], { settings: { devices: devicesFile(device({ model: undefined, name: "Plain" }), device({ did: "3300", name: "Gateway child", model: "acme.plug.one", localip: undefined })) } });
    const [plain, child] = def.devices.poll(host.ctx);
    expect(plain).toMatchObject({ name: "Plain", kind: "other", online: false, product: "" });
    expect(valuesByCode(plain).unavailable.value).toMatch(/no spec_type/);
    expect(valuesByCode(child).unavailable.value).toMatch(/usual for a device behind a gateway/);
  });

  it("treats only private IPv4 addresses as the local network, and polls the private ones it can", async () => {
    const def = await load();
    const host = network([], {
      settings: {
        devices: devicesFile(
          device({ did: "3100", name: "Six", model: "chuangmi.plug.v1", localip: "fd00::5" }),
          device({ did: "3101", name: "Public 172", model: "chuangmi.plug.v1", localip: "172.40.0.5" }),
          device({ did: "3102", name: "Private 172", model: "chuangmi.plug.v1", localip: "172.20.0.5" }),
          device({ did: "3103", name: "Private 10", model: "chuangmi.plug.v1", localip: "10.0.0.5" }),
        ),
      },
    });
    const cards = def.devices.poll(host.ctx);
    const note = (name: string) => valuesByCode(cards.find((c: ExtensionDevice) => c.name === name)).unavailable?.value;
    expect(note("Six")).toBe("The devices file gives it an address outside your local network.");
    expect(note("Public 172")).toBe("The devices file gives it an address outside your local network.");
    expect(note("Private 172")).toBeUndefined();
    expect(note("Private 10")).toBeUndefined();
    expect(host.udpRequests.map((r) => r.host).sort()).toEqual(["10.0.0.5", "172.20.0.5"]);
  });

  it("never searches for a device whose id isn't a plain number, and searches for one whose id is", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const def = await load();
    const host = network([], {
      settings: {
        devices: devicesFile(
          device({ did: "1.5", name: "Decimal id", model: "chuangmi.plug.v1", localip: "192.168.1.70" }),
          device({ did: "7654321", name: "Plain id", model: "chuangmi.plug.v1", localip: "192.168.1.61" }),
        ),
      },
    });
    def.devices.poll(host.ctx); // the failures start their counts
    vi.setSystemTime(1_000_000 + 61_000);
    def.devices.poll(host.ctx);
    // Only the plain id is searched for: the decimal one can't be told apart by the id in a reply.
    expect(host.udpScans).toHaveLength(1);
    expect(host.udpScans[0]).toMatchObject({ port: 54321, data: HELLO });
  });

  it("adopts a device that moved only when its id matches, and passes over another device on the same network", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const def = await load();
    const lamp = new Miio(IP, 1234567, properties(LAMP_VALUES));
    const stranger = new Miio("192.168.1.78", 7654321, properties({}));
    const host = network([stranger, lamp], { settings: { devices: devicesFile(device()) } });
    def.devices.poll(host.ctx);

    lamp.ip = "192.168.1.77";
    def.devices.poll(host.ctx); // the first failure starts the count
    vi.setSystemTime(1_000_000 + 61_000);
    const [card] = def.devices.poll(host.ctx);

    expect(card.online).toBe(true);
    expect(host.logs).toContain("Desk lamp found at a new address: 192.168.1.60 is now 192.168.1.77");
    expect(host.storage.get("moved")).toEqual({ "1234567": { from: IP, to: "192.168.1.77" } });
  });

  it("goes straight to a saved new address after a restart, unless the devices file has a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const lamp = new Miio("192.168.1.77", 1234567, properties(LAMP_VALUES));
    const host = network([lamp], { settings: { devices: devicesFile(device()) } });
    host.storage.set("moved", { "1234567": { from: IP, to: "192.168.1.77" } });
    const def = await load();
    expect(def.devices.poll(host.ctx)[0].online).toBe(true);
    expect(host.udpScans).toHaveLength(0);

    const edited = new Miio("192.168.1.90", 1234567, properties(LAMP_VALUES));
    const fresh = network([edited], { settings: { devices: devicesFile(device({ localip: "192.168.1.90" })) } });
    fresh.storage.set("moved", { "1234567": { from: IP, to: "192.168.1.77" } }); // saved before the file changed
    const again = await load();
    expect(again.devices.poll(fresh.ctx)[0].online).toBe(true);
    expect(fresh.udpScans).toHaveLength(0);
  });

  it("gives a turn to each device in turn, and leaves the rest when a turn has used its thirty seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const def = await load();
    // The first device takes thirty-one seconds to answer, so the second waits for the next poll.
    const slow = new Miio(IP, 1234567, (method, params) => {
      vi.setSystemTime(Date.now() + 31_000);
      return properties(LAMP_VALUES)(method, params);
    });
    const second = new Miio("192.168.1.61", 7654321, properties(LAMP_VALUES));
    const host = network([slow, second], { settings: { devices: devicesFile(device(), device({ did: "7654321", name: "Second lamp", localip: "192.168.1.61" })) } });

    def.devices.poll(host.ctx);
    expect(slow.methods("get_properties")).toHaveLength(1);
    expect(second.calls).toHaveLength(0);

    // The next poll starts with the device that was left, and then gets the first one's turn too.
    def.devices.poll(host.ctx);
    expect(second.methods("get_properties")).toHaveLength(1);
    expect(slow.methods("get_properties")).toHaveLength(2);
  });
});

describe("xiaomi: a reply that isn't one of ours, on the wire", () => {
  it("counts a reply too short to be a miIO packet as lost, and says so", async () => {
    const def = await load();
    const lamp = new Miio(IP, 1234567, properties(LAMP_VALUES));
    let short = false;
    const host = makeHost({
      settings: { devices: devicesFile(device()) },
      udpRequest(_ip, _port, data) {
        if (data === HELLO) return lamp.reply(HELLO)!;
        if (short) return "21310020"; // a header with nothing after it
        const real = lamp.reply(data);
        if (real === null) throw new Error(TIMEOUT);
        return real;
      },
    });
    expect(def.devices.poll(host.ctx)[0].online).toBe(true);
    short = true;
    const [card] = def.devices.poll(host.ctx);
    expect(card.online).toBe(false);
    expect(host.logs.join("\n")).toContain("get_properties: no authentic answer");
  });

  it("counts a reply whose payload can't be decrypted as lost, not as a value", async () => {
    const def = await load();
    const lamp = new Miio(IP, 1234567, properties(LAMP_VALUES));
    let corrupt = false;
    const host = makeHost({
      settings: { devices: devicesFile(device()) },
      udpRequest(_ip, _port, data) {
        if (data === HELLO) return lamp.reply(HELLO)!;
        if (!corrupt) {
          const real = lamp.reply(data);
          if (real === null) throw new Error(TIMEOUT);
          return real;
        }
        // Two bytes of payload is no whole block, so it can't be decrypted, but its checksum is right.
        const head = "2131" + "0022" + "00000000" + u32(1234567) + u32(1000);
        const payload = "abcd";
        return head + crypto.hash("md5", head + TOKEN + payload) + payload;
      },
    });
    expect(def.devices.poll(host.ctx)[0].online).toBe(true);
    corrupt = true;
    const [card] = def.devices.poll(host.ctx);
    expect(card.online).toBe(false);
    expect(host.logs.join("\n")).toContain("get_properties: no authentic answer");
  });

  it("reports a send failure after a good hello as the reason a device is offline", async () => {
    const def = await load();
    const lamp = new Miio(IP, 1234567, properties(LAMP_VALUES));
    let sending = true;
    const host = makeHost({
      settings: { devices: devicesFile(device()) },
      udpRequest(_ip, _port, data) {
        if (data === HELLO) return lamp.reply(HELLO)!;
        if (!sending) throw new Error("write udp: no route to host");
        const real = lamp.reply(data);
        if (real === null) throw new Error(TIMEOUT);
        return real;
      },
    });
    def.devices.poll(host.ctx);
    sending = false;
    const [card] = def.devices.poll(host.ctx);
    expect(card.online).toBe(false);
    expect(host.logs.join(" ")).toMatch(/no route to host/);
  });
});

describe("xiaomi: a Roborock whose token isn't hex", () => {
  it("refuses the file as it does a table device with a bad token", async () => {
    const def = await load();
    const host = network([], { settings: { devices: devicesFile(device({ name: "Vac", model: "roborock.vacuum.s5", token: "zz" })) } });
    expect(() => def.devices.poll(host.ctx)).toThrow("the token for Vac isn't hex");
  });
});

describe("xiaomi: a spec device whose token isn't hex", () => {
  it("doesn't refuse the file for it: its card says why it can't be read", async () => {
    const def = await load();
    const host = network([], { settings: { devices: devicesFile(device({ name: "Bulb", model: "acme.thing.x", token: "zz", spec_type: "urn:miot-spec-v2:device:light:0000A001:acme-x:1" })) } });
    const [card] = def.devices.poll(host.ctx);
    expect(card).toMatchObject({ name: "Bulb", online: false });
    expect(valuesByCode(card).unavailable.value).toBe("Its token in the devices file isn't hex.");
  });
});

describe("xiaomi: a table device with no name and a bad token", () => {
  it("names it by its model in the refusal", async () => {
    const def = await load();
    const host = network([], { settings: { devices: devicesFile(device({ name: "", token: "zz" })) } });
    expect(() => def.devices.poll(host.ctx)).toThrow("the token for yeelink.light.ceiling5 isn't hex");
  });
});
