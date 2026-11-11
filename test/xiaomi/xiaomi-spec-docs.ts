// Builds MIoT spec documents the way miot-spec.org serves them, and polls a device that has one. Used by the spec tests.
import { valuesByCode } from "../harness";
import { type Answer, device, devicesFile, IP, load, Miio, network, properties, SPEC_BASE } from "./xiaomi-fake";

const MODEL = "acme-x";

export const urnOf = (type: string) => `urn:miot-spec-v2:device:${type}:0000A001:${MODEL}:1`;

export function service(iid: number, type: string, props: unknown[] = [], actions: unknown[] = []) {
  return { iid, type: `urn:miot-spec-v2:service:${type}:00007802:${MODEL}:1`, description: type, properties: props, actions };
}

export function prop(iid: number, type: string, format: string, access: string[], extra: Record<string, unknown> = {}) {
  return { iid, type: `urn:miot-spec-v2:property:${type}:00000001:${MODEL}:1`, format, access, description: type, ...extra };
}

export function action(iid: number, type: string, extra: Record<string, unknown> = {}) {
  return { iid, type: `urn:miot-spec-v2:action:${type}:00002801:${MODEL}:1`, description: type, in: [], out: [], ...extra };
}

export const doc = (...services: unknown[]) => ({ services });

/** Polls one device whose spec is `spec`, and says `values` (by did) to every read. `options.answer` replaces that. */
export async function pollSpec(
  spec: unknown,
  values: Record<string, unknown>,
  options: { type?: string; answer?: (method: string, params: any) => Answer; deviceOver?: Record<string, unknown> } = {},
) {
  const def = await load();
  const urn = urnOf(options.type ?? "light");
  const lamp = new Miio(IP, 1234567, options.answer ?? properties(values));
  const host = network([lamp], {
    settings: { devices: devicesFile(device({ model: "acme.thing.x", spec_type: urn, ...options.deviceOver })) },
    fetch: (url) => (url === SPEC_BASE + urn ? { body: spec } : { status: 404 }),
  });
  const [card] = def.devices.poll(host.ctx);
  return { def, host, lamp, card, values: valuesByCode(card), codes: card.values.map((v: DeviceValue) => v.code) as string[] };
}
