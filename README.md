# Leading Edge Live

A Leading Edge web app for wingsuit pilots with a FlySight 2. It connects over Bluetooth and shows live GPS and barometric altitude. It can also import jumps from the FlySight (or a TRACK.CSV file) and check them against the acrobatic exit rules of the FAI ISC Wingsuit Flying Competition Rules (2026 edition).

It is a plain static site with no build step and no server code. It installs as an app and works offline once it has been opened.

Use it at https://envizio.github.io/le-altitude/.

## Open source

The software and documentation are licensed under the GNU Affero General Public License, version 3 only. The complete terms are in [LICENSE](LICENSE). If you run a modified version as a network service, AGPL-3.0 section 13 requires offering its Corresponding Source to users interacting with it remotely.

The Leading Edge name, wordmark, logos, and other trademarks are not licensed by AGPL. In particular, `logo-light.webp`, `favicon.svg`, `favicon.ico`, `favicon-192.png`, `favicon-512.png`, and `apple-touch-icon.png` are brand assets and are not covered by the project license.

The fonts in `fonts/` (Anton, Archivo and JetBrains Mono) are under the SIL Open Font License 1.1. Their copyright notices and license are next to them in `fonts/*-OFL.txt`; keep those files with the fonts when redistributing.

Contributions are submitted under AGPL-3.0-only. By opening a pull request, you confirm that you have the right to submit the contribution under those terms. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project workflow.

## Contributing

Issues and pull requests are welcome at the [GitHub repository](https://github.com/envizio/le-altitude). Describe the behavior affected and the checks you ran in the pull request, and keep changes focused.

## What it does

**Live tab**

- GPS altitude above sea level, or above a saved dropzone (AGL).
- Barometric height above the point where the FlySight was switched on, on firmware that streams the barometer. Older firmware shows GPS only.
- Vertical and ground speed.
- Feet/mph or metres/km/h.
- Keeps the screen awake while connected, reconnects when the FlySight drops out, and picks the last FlySight back up after a reload.

**Jumps tab**

- Import a TRACK.CSV straight off the FlySight over Bluetooth, or from a file (FlySight 2 TRACK.CSV or FlySight 1 CSV).
- Over Bluetooth it also samples SENSOR.CSV from the same folder to get barometric height for the jump. A SENSOR.CSV can be added to a jump later from a file too.
- For each jump: exit altitude, working time, average glide ratio, distance and speeds through the window, plus altitude, glide ratio and speed charts that share one cursor.
- A verdict on whether the exit altitude allows a rejump (rule 6.3.1), for a free or compulsory round, with a 7,500 ft window or a 5,000 ft lowered-exit window.

Jumps are stored in the browser's IndexedDB. Settings and saved dropzones are stored in localStorage. Nothing leaves the device.

## Browser support

The app needs Web Bluetooth: Chrome on Android, desktop Chrome or Edge, or the Bluefy browser on iPhone. Safari and Firefox do not support it. To rejoin the last FlySight after a reload without the device picker, Chrome's persistent Bluetooth permissions must be on.

The FlySight talks to one device at a time, so disconnect any other phone or laptop first. On a device it has not paired with before, put the FlySight in pairing mode and accept the pairing prompt.

Track downloads need the FlySight's card to be free. If it is logging, the app offers to put it to sleep. A FlySight that is plugged into USB, or in config or start mode, has to be unplugged or switched off first.

## Run it

Serve the folder with any static file server, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Web Bluetooth and the service worker only work in a secure context: localhost is fine, but any other host needs HTTPS. To try it on a phone, deploy it or tunnel to it over HTTPS.

## Deploy

The site is served by GitHub Pages from the root of `main`, so every push to `main` goes live. There is nothing to build, and any other static host that serves HTTPS works the same way.

The service worker (`sw.js`) caches the app so it opens with no signal. When you change a file:

- Bump `CACHE` in `sw.js` (for example `le-live-v21` to `le-live-v22`) so phones fetch the new version, and bump the `LE LIVE v21` label in `index.html` to match. The label shows on the Live tab until a FlySight connects, so you can see which version a phone is running.
- If you add a file the app needs, add it to `FILES` in `sw.js`.

Open copies of the app reload themselves when a new version takes over, unless they are connected to a FlySight.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Markup and styles for every screen |
| `app.js` | Live Bluetooth readout, units, dropzones, settings and routing (`#live`, `#jumps`, `#jump/<id>`) |
| `fsfiles.js` | FlySight file transfer over Bluetooth: directory listing, file reads and sleep requests |
| `jumps.js` | Jump logbook: storage, import, the jump screen and its charts |
| `analysis.js` | Track and sensor file parsing and the acro analysis |
| `sw.js` | Offline cache |
| `manifest.json` | Install metadata |

`analysis.js` is pure functions with no DOM access and exports them under Node, so it can be tested directly:

```js
const { parseTrack, analyseAcro } = require('./analysis.js');
```

## How a jump is analysed

All altitudes in the rules are GPS height above ground, so the exit verdict needs a dropzone elevation.

1. **Window top**: the first time vertical speed climbs through 10 m/s and stays above it for about 5 seconds (rule 2.3).
2. **Exit**: about one second before the window top, the time it takes to reach 10 m/s from a standing start.
3. **Window bottom**: 7,500 ft below the window top (rule 6.3.3), or 5,000 ft for a lowered exit (rule 6.3.5). If the track ends before it, there is no working time.
4. **Averages**: distance is integrated from ground speed through the window. Glide ratio is that distance over the height lost.
5. **Verdict** (rule 6.3.1): an exit below 12,000 ft AGL allows a rejump. An exit above 12,500 ft allows one in a free round but not in a compulsory round. With a lowered exit the Meet Director sets the altitude, so the limits are not checked.

Barometric height uses the standard atmosphere and is zeroed at ground level, taken as the highest pressure in the file. SENSOR.CSV timestamps are matched to the track through its `$TIME` rows. The sampled Bluetooth download can leave seconds between barometer readings, so the jump screen interpolates the difference between barometric and GPS height rather than the height itself.

## FlySight protocol

The Bluetooth UUIDs and packet layouts come from [flysight-2-firmware](https://github.com/flysight/flysight-2-firmware) (`Docs/ble.md`, `STM32_WPAN/App/custom_app.c`, `FlySight/crs.c`). The live barometer characteristic is only on firmware that streams sensor data; the app sets the barometer mask and rate on connect, since those settings last until the FlySight is switched off and another app may have changed them.
