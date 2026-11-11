# Tomtly extensions

The official integrations and plugins for [Tomtly](https://github.com/drax98/Tomtly), one folder each. Tomtly installs a
folder straight from here: on the **Integrations** or **Plugins** page choose **Add**, then **From a GitHub repo**, and
give this repository, the folder and a version tag, such as `tuya` at `tuya-v1.2.4`. Its settings, keys and credential
files included, are filled in there and kept encrypted in Tomtly's database.

| Folder | What | Latest |
|---|---|---|
| [`tuya`](tuya) (Smart Life) | Tuya Zigbee and Wi-Fi devices, LAN port 6668, protocols 3.1 to 3.5 | `tuya-v1.2.4` |
| [`xiaomi`](xiaomi) (Xiaomi Home) | Wi-Fi MIoT devices from their spec, older Yeelight, Philips, Zhimi, Chuangmi, Aqara gateway models, Roborock vacuums; miIO over UDP | `xiaomi-v1.3.4` |
| [`gree`](gree) | Gree-based ACs such as Sinclair and EWPE Smart, UDP port 7000 | `gree-v1.3.0` |
| [`weather`](weather) | A plugin: weather and forecast from Open-Meteo | `weather-v1.1.1` |

Each folder's README says how to get its credentials, what it was tested against, and what it asks access for. Pin a
tag: what you install can't change unless you change the tag.

## Develop

```bash
pnpm install
pnpm typecheck   # each folder against sdk/extension.d.ts, a copy of Tomtly's
pnpm test        # Vitest against a mock of the host API (test/harness.ts), with coverage
```

- An extension is a folder with `extension.ts` at its top, its own `README.md`, `LICENSE` and `tsconfig.json`. Its tests
  go in `test/<folder>/`, so the folder Tomtly downloads holds only what runs.
- To try a change in Tomtly, copy the folder into your config folder's `extensions/` and add it on the page from local files, as `./extensions/<folder>`.
- A release is a tag `<folder>-v<version>`, with the `version` in its `extension.ts`. Bump the version for every change.
- See Tomtly's [extension guide](https://github.com/drax98/Tomtly/blob/main/docs/extensions.md) and
  [style guide](https://github.com/drax98/Tomtly/blob/main/docs/extension-style-guide.md).

## Licence

MIT, see [LICENSE](LICENSE). The Tuya protocol is ported from TinyTuya, see [tuya/NOTICE](tuya/NOTICE).
