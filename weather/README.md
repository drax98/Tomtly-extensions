# Weather

A Tomtly plugin with no credentials: current conditions and a two-day hourly forecast from
[Open-Meteo](https://open-meteo.com) (data CC BY 4.0), refreshed every 5 minutes, and a widget for the Home page. Scripts
read it as `home.plugin("weather").data()`, typed by `types.d.ts`.

## Install

On Tomtly's **Integrations** or **Plugins** page choose **Add**, then **From a GitHub repo**, and give the repository `drax98/tomtly-extensions`, the folder `weather` and
the version `weather-v1.1.0`. Or list it in `config.json`, as under **Settings** below. Pin a tag: the code you install can't change unless
you change it.


## Access

- `network: ["api.open-meteo.com"]`, nothing else.

## Settings

| | |
|---|---|
| `latitude` | Required. Sent to Open-Meteo, so round it if you prefer. |
| `longitude` | Required. |

```json
{ "source": "github:drax98/tomtly-extensions/weather@weather-v1.1.0", "settings": { "latitude": 52.23, "longitude": 21.01 } }
```

## In a script

```ts
const weather = home.plugin("weather");

home.reconcile(() => {
  const now = weather.data();
  const age = weather.ageSeconds();
  if (!now || age === undefined || age > 3600) return; // no fresh data: leave things as they are
  home.log(`${now.temperature} °C`);
});
```

`data()` is `undefined` until the first successful fetch. If a fetch fails, it keeps the last good result and
`ageSeconds()` keeps growing.

## Develop

See the [repository's README](../README.md#develop). The tests are in [`test/weather`](../test/weather).

## Licence

MIT, see [LICENSE](LICENSE).
