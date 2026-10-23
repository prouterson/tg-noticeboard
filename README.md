# TG Carindale Notice Board

A notice board for an old iPad in kiosk mode at Tommy Gun's Carindale, and a web editor for changing what it shows.

- Board: https://prouterson.github.io/tg-noticeboard/
- Editor: https://prouterson.github.io/tg-noticeboard/editor.html

Both are served by GitHub Pages from the `main` branch. Pushing to `main` updates the site. Every 5 minutes the board compares its `BUILD` with `version.json` and, if they differ, loads `?v=<build>`, which skips the iPad's saved copy. The git pre-commit hook (`.githooks/pre-commit`, enabled with `git config core.hooksPath .githooks`) runs `dev/stamp.mjs`, which sets `BUILD`, the `?v=` on the board's scripts, and `version.json` from a hash of the board files. Board content lives in Firebase project `tg-notice-board`, not in this repo.

- `index.html`: the board. Plain ES5 JavaScript so old iOS Safari (9.3 and later) can run it. Every minute it reads the published content from Firestore over plain REST, with no Firebase library. Around 3am it reloads itself, but only if the site answers.
- `checkin.js`: staff check-in on the board (name, 4-digit PIN, then start shift, break, back or finish). It is an ES module, so iPads too old for modules just skip it. The iPad signs in anonymously and an editor registers it once by typing the 6-character code it shows. Check-ins are cached on the iPad (Firestore persistent cache), so they survive a Wi-Fi drop.
- `editor.html`: the editor. Sign in with Google, edit, see a live preview, then Publish. It uses the Firebase JS SDK from gstatic. The Shifts tab (the timesheet, fixes, Download for pay, the shop iPad and barbers) saves straight to Firestore, with nothing to publish.
- `config.js`: the Firebase web app settings. These are public. While `apiKey` is empty, the board shows its starter content and the editor runs as a demo that saves nothing.
- `firestore.rules`: the database rules. Paste them into Firebase console > Firestore Database > Rules.
- `img/`: logos. `posters/`: the starter poster.

## Data in Firestore

| Document | Fields |
| --- | --- |
| `board/content` | `json` (the whole board as JSON text, without poster images), `publishedAt`, `publishedBy` |
| `posters/{id}` | `data` (a JPG data URL of at most 900x1350, under about 650 KB) |
| `editors/{gmail}` | `name`, `role` (`Owner` or `Editor`). Only the owner can change this list. |
| `devices/{uid}` | a registered shop iPad (its anonymous sign-in uid): `name`, `registeredAt`, `registeredBy`, and `lastSeen`, which the iPad updates every 10 minutes |
| `pairing/{code}` | `uid`, `createdAt`: posted by an unregistered iPad and deleted when an editor registers it |
| `staff/{id}` | `name`, `active`, `pinHash` (SHA-256 of `tgnb:{id}:{pin}`; the iPad checks PINs locally) |
| `events/{id}` | `staffId`, `name`, `type` (`start`, `break`, `back` or `finish`), `at`, `day` (YYYY-MM-DD), `device`. iPads can only create these. An editor's fix marks the old entries `void` and adds new ones with `editedBy` and `reason`. |

Anonymous sign-in must stay enabled in Firebase Authentication, with **Auto clean-up off**: clean-up would delete the iPad's 30-day-old account and unregister it.

## Preview on this PC

Use the `tg-noticeboard` entry in `C:\Projects\.claude\launch.json` (port 8792). The page `editor.html` shows the board inside it through `index.html?preview`.
