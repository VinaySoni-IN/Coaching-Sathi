# PWA manifest — every line of the install audit

The two manifests (`public/manifest.webmanifest` for the teacher app, `student-hub/manifest.webmanifest` for the
Student Hub) are install surfaces, not decoration. Anything declared here is backed by code in this repo, and
anything that would be a false claim is deliberately absent. `tests/pwa.test.ts` checks both directions.

## Installed end to end

| Member | What it does | Where the behaviour lives |
| --- | --- | --- |
| `shortcuts` | Attendance, Fees, Students, Hub shortcuts open the workspace on that page | `?go=` is read by `src/lib/launch.ts`, applied in `src/App.tsx` |
| `protocol_handlers` | `web+coachingsathi:attendance` (and `fees`, `students`, `hub`, `backup`) opens the same screens | same handler; `?p=%s` is treated exactly like `?go=` |
| `file_handlers` | Opening a `.json` backup with the installed app opens the restore confirmation | Launch Queue consumer in `src/lib/launch.ts` → `parseBackup()` → the existing restore dialog |
| `share_target` | Share a contact or a text to Coaching Sathi and "Add student" opens prefilled | `public/sw.js` answers `POST ./share-target`, parks the payload in the cache, redirects to `?go=shared`; the app reads it once and seeds the form draft |
| `launch_handler` | A second launch focuses the existing window instead of a duplicate | `client_mode: "navigate-existing"` (browser-implemented) |
| `edge_side_panel` | Preferred width if the app is opened in a side panel | `preferred_width: 420` (browser-implemented) |
| `display_override` | Installed windows fall back to `minimal-ui` where `standalone` is unavailable | `["standalone", "minimal-ui"]` |
| `screenshots` | Android's richer install sheet: a six-shot carousel for the teacher app, so the install card never shows just two tiles. The shots are the README's own grid (deck, marked day, fees, students, hub, invoice) copied byte for byte into `public/screenshots/`; `tests/pwa.test.ts` fails if the two sets drift. The Student Hub ships its own single `780x1688` shot | `public/screenshots/*`, `student-hub/screenshots/portal-hub.png` |
| `lang`, `dir`, `id`, `start_url`, `scope`, `display` | Base install identity for both apps | both manifests |
| `prefer_related_applications: false` | No store app is being advertised | both manifests |
| Service worker | Offline shell, and the share POST handler | `public/sw.js` (`coachsathi-v30`), registered in `src/main.tsx`; the portal registers `student-hub/sw.js` for push |

## Deliberately absent

- **`scope_extensions`** — only useful to hand navigation from a *different* origin to this app. Coaching Sathi is
  deployed on a single origin (`vinaysoni-in.github.io/Coaching-Sathi/`), so there is nothing to extend.
- **`iarc_rating_id`** — this is an issued age rating for store-listed apps. We do not have one, and inventing an
  identifier would put a false rating on the install sheet.
- **`related_applications`** — there is no native app to point at. `prefer_related_applications` stays `false`.
- **`widgets`** — the widget member requires a hosted `ms_ac_template` document and is still Chrome-experimental.
  Shipping one would be a claim we cannot back; the shortcuts above cover the same "one tap to the useful screen" need.

## Version bumps

`?v=` on the manifest link forces a fresh manifest after a change (`?v=17` teacher app, `?v=3` Student Hub).
The service worker cache name (`coachsathi-v30`) must change whenever `public/sw.js` changes, or installed
copies keep the old worker. `tests/pwa.test.ts` pins all four strings.
