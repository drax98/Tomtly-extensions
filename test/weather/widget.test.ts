import { afterEach, describe, expect, it, vi } from "vitest";
import { loadExtension, makeHost } from "../harness";

// The Home widget and the fetch paths that feed it. The widget reads the last good forecast, so a failed fetch must not
// blank it, and it compares hours with the clock, so the clock is pinned.

const load = () => loadExtension(() => import("../../weather/extension.ts"));
const settings = { latitude: 51.5, longitude: -0.12 };
const HOUR_S = 3600; // the API's unixtime is in seconds
const NOW_MS = Date.UTC(2024, 0, 1, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

const current = {
  temperature_2m: 12.46,
  apparent_temperature: 10.14,
  relative_humidity_2m: 80,
  precipitation: 0.2,
  cloud_cover: 60,
  wind_speed_10m: 14.04,
  weather_code: 3,
  is_day: 1,
};

/** A reply shaped like Open-Meteo's, with one row of hourly data per [time in seconds, °C, rain %]. */
function forecast(rows: [number, number | null, number | null][], over: Partial<typeof current> = {}) {
  return {
    current: { ...current, ...over },
    hourly: {
      time: rows.map((r) => r[0]),
      temperature_2m: rows.map((r) => r[1]),
      precipitation_probability: rows.map((r) => r[2]),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("weather: the Home widget", () => {
  it("says it's waiting before any forecast has arrived", async () => {
    const def = await load();
    const host = makeHost({ settings });
    expect(def.widgets.now.title).toBe("Weather now");
    expect(def.widgets.now.render(host.ctx)).toEqual([{ type: "text", text: "Waiting for the first forecast." }]);
  });

  it("shows the temperature, feels-like and wind, then the next three hours after now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const def = await load();
    const host = makeHost({
      settings,
      fetch: () => ({
        body: forecast([
          [NOW_S - HOUR_S, 7, 0], // already past
          [NOW_S, 6, 0], // exactly now is not "next"
          [NOW_S + HOUR_S, 11.26, 10],
          [NOW_S + 2 * HOUR_S, 10.04, 20],
          [NOW_S + 3 * HOUR_S, 9.5, 30],
          [NOW_S + 4 * HOUR_S, 8, 40], // a fourth hour doesn't fit
        ]),
      }),
    });
    def.data.fetch(host.ctx);

    expect(def.widgets.now.render(host.ctx)).toEqual([
      { type: "stat", label: "Outside", value: 12.5, unit: "°C" },
      {
        type: "rows",
        rows: [
          { label: "Feels like", value: "10.1 °C" },
          { label: "Wind", value: "14 km/h" },
          { label: "In 1 h", value: "11.3 °C, rain 10%" },
          { label: "In 2 h", value: "10 °C, rain 20%" },
          { label: "In 3 h", value: "9.5 °C, rain 30%" },
        ],
      },
    ]);
  });

  it("shows an hour less than half an hour away as 1 h, not 0 h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const def = await load();
    const host = makeHost({ settings, fetch: () => ({ body: forecast([[NOW_S + 20 * 60, 5, 0]]) }) });
    def.data.fetch(host.ctx);
    const [, rows] = def.widgets.now.render(host.ctx);
    expect(rows.rows).toEqual([
      { label: "Feels like", value: "10.1 °C" },
      { label: "Wind", value: "14 km/h" },
      { label: "In 1 h", value: "5 °C" },
    ]);
  });

  it("adds the rain chance to an hour, and warns from 60% but not below it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const def = await load();
    const host = makeHost({
      settings,
      fetch: () => ({ body: forecast([[NOW_S + HOUR_S, 8, 59], [NOW_S + 2 * HOUR_S, 7, 60]]) }),
    });
    def.data.fetch(host.ctx);
    const [, rows] = def.widgets.now.render(host.ctx);
    const [, , soon, later] = rows.rows;
    expect(soon.value).toBe("8 °C, rain 59%");
    expect(soon.tone).toBeUndefined();
    expect(later.value).toBe("7 °C, rain 60%");
    expect(later.tone).toBe("warn");
  });

  it("shows no rain for a dry hour, or one the forecast gives no chance for", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const def = await load();
    const host = makeHost({
      settings,
      fetch: () => ({ body: forecast([[NOW_S + HOUR_S, 9, 0], [NOW_S + 2 * HOUR_S, 8, null]]) }),
    });
    def.data.fetch(host.ctx);
    const [, rows] = def.widgets.now.render(host.ctx);
    expect(rows.rows[2]).toEqual({ label: "In 1 h", value: "9 °C", tone: undefined });
    expect(rows.rows[3]).toEqual({ label: "In 2 h", value: "8 °C", tone: undefined });
  });

  it("keeps the last good forecast on the widget when a later fetch fails", async () => {
    const def = await load();
    let reply: () => unknown = () => ({ body: forecast([]) });
    const host = makeHost({ settings, fetch: () => reply() as any });
    def.data.fetch(host.ctx);
    expect(def.widgets.now.render(host.ctx)[0]).toEqual({ type: "stat", label: "Outside", value: 12.5, unit: "°C" });

    reply = () => ({ status: 503 });
    expect(() => def.data.fetch(host.ctx)).toThrow("Open-Meteo answered 503");
    reply = () => {
      throw new Error("network down");
    };
    expect(() => def.data.fetch(host.ctx)).toThrow("network down");
    reply = () => ({ body: { current: { ...current, temperature_2m: null }, hourly: { time: [], temperature_2m: [], precipitation_probability: [] } } });
    expect(() => def.data.fetch(host.ctx)).toThrow("Open-Meteo sent no current temperature");

    expect(def.widgets.now.render(host.ctx)[0]).toEqual({ type: "stat", label: "Outside", value: 12.5, unit: "°C" });
  });

  it("stays on the waiting text when the first fetch fails, and nothing is kept from it", async () => {
    const def = await load();
    const refused = makeHost({ settings, fetch: () => ({ status: 500 }) });
    expect(() => def.data.fetch(refused.ctx)).toThrow("Open-Meteo answered 500");
    expect(def.widgets.now.render(refused.ctx)).toEqual([{ type: "text", text: "Waiting for the first forecast." }]);
  });

  it("passes a host error through from the fetch", async () => {
    const def = await load();
    const down = makeHost({
      settings,
      fetch: () => {
        throw new Error("network down");
      },
    });
    expect(() => def.data.fetch(down.ctx)).toThrow("network down");
    expect(down.fetches).toHaveLength(1);
  });
});
