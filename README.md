# TG Carindale Notice Board

A notice board for an old iPad in kiosk mode at Tommy Gun's Carindale, and a web editor for changing what it shows.

- `index.html`: the board. Plain ES5 JavaScript so old iOS Safari (9.3 and later) can run it. Every minute it reads the published content from Firestore over plain REST, with no Firebase library. Around 3am it reloads itself, but only if the site answers.
- `editor.html`: the editor. Sign in with Google, edit, see a live preview, then Publish. It uses the Firebase JS SDK from gstatic.
- `config.js`: the Firebase web app settings. These are public. While `apiKey` is empty, the board shows its starter content and the editor runs as a demo that saves nothing.
- `firestore.rules`: the database rules. Paste them into Firebase console > Firestore Database > Rules.
- `img/`: logos. `posters/`: the starter poster.

## Data in Firestore

| Document | Fields |
| --- | --- |
| `board/content` | `json` (the whole board as JSON text, without poster images), `publishedAt`, `publishedBy` |
| `posters/{id}` | `data` (a JPG data URL of at most 900x1350, under about 650 KB) |
| `editors/{gmail}` | `name`, `role` (`Owner` or `Editor`). Only the owner can change this list. |

## Preview on this PC

Use the `tg-noticeboard` entry in `C:\Projects\.claude\launch.json` (port 8792). The page `editor.html` shows the board inside it through `index.html?preview`.
