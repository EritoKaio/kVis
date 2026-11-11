# kVis

kVis is a JavaScript and Three.js visualization project for Kerbal Space Program. The 16:9 preview works offline, and an optional local bridge can display the active vessel's live orbit, marker, name, and altitude from KSP.

## Run

Requires Node.js `^20.19.0 || >=22.12.0` and npm 10 or later. npm 10 is required to apply the patched kRPC client dependency overrides.

```powershell
npm install
npm run dev
```

For live KSP data, set the kRPC server protocol to **Protobuf over TCP**, keep it bound to the local machine with RPC port `50000` and stream port `50001`, and start the bridge in a second terminal:

```powershell
npm run bridge
```

The bridge is local-only. It connects to kRPC over TCP, checks for active-vessel changes, and streams the current vessel's orbital elements, true anomaly, mean altitude, and body's radius and rotation angle to the browser on `127.0.0.1:5174`. It also streams every celestial body's center position at 1 Hz and orientation at 10 Hz in Kerbol's non-rotating reference frame. The selected body's live orientation is applied to its globe, and a directional key light follows the vector from that body to Kerbol; the preview uses a fixed light when live transforms are unavailable. Switching vessels replaces the vessel-specific streams and updates the visualization; when the vessel's orbiting body changes, the body selector follows it. The vessel name is attached to its marker, and altitude is displayed in the top menu. The orbit and apsis markers are reconstructed from the body's orbital elements; apoapsis and periapsis use compact, screen-fixed tags styled after KSP's map markers. A thin surface track line runs from the vessel marker to the point directly beneath it on the body. Choose any stock Kerbol-system body from the top-bar selector. Kerbin uses its supplied texture; the other bodies currently use generated visual placeholders. The camera follows the vessel at a close, launch-friendly distance and stays on the body's outward side; the vessel and apsis markers remain a consistent on-screen size as you zoom. The orbit line is white. The screen is kept clear of fixed data panels for future overlays. Drag/scroll controls remain available. The top menu reveals near the top edge of the screen and hides when the pointer moves away. The black equirectangular environment placeholder at `public/assets/environment/space-background.svg` can be replaced with a 2:1 space environment image.

Open `/telemetry.html` from the top-menu link to use the transparent live telemetry widget as a separate OBS browser source. Its velocity gauge is normalized to circular orbital speed at the body's atmosphere boundary, and its altitude gauge fills to the top of the atmosphere. Bodies without atmospheres use a 70 km altitude gauge range. The widget shows live speed, mean altitude, and G-force, plus a 3D vehicle indicator driven by the vessel's attitude relative to the orbiting body. The orientation globe has a simplified equatorial plane and north marker; its view aligns prograde to the right and body north to the top.

## Current Scope

- Vite development server and production build
- Selectable catalog of all 17 stock Kerbol-system bodies, including moons
- Three.js body preview with generated placeholder maps and a star field
- Optional local kRPC TCP-to-WebSocket bridge for active vessel name and altitude
- 16:9 scene framing
- Live Keplerian orbit reconstructed from kRPC orbital elements
- Live vessel marker driven by kRPC true anomaly
- Offline demo orbit and marker when the bridge is disconnected

Build the current milestone with `npm run build`.

## License

The project code is licensed under the MIT License; see [LICENSE](./LICENSE).
Third-party dependencies and assets may have separate license terms.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and pull request guidance.