# Matchify 🎧

**Playlist-Tinder für Spotify.** Wische durch Songs von Künstlern, die du noch
nicht hörst — vorgeschlagen aus deinen meistgehörten Genres. Rechts = rein in die
Playlist, links = weg.

<!-- Screenshot/GIF hier einbinden, sobald vorhanden: -->
<!-- ![Matchify](docs/screenshot.png) -->

---

## Was es macht

1. **Login** über Spotify (OAuth 2.0 mit PKCE — kein Passwort, kein Secret).
2. Liest deine **Top-Artists & Top-Tracks** (Ersatz fürs deprecatete Wrapped-/Recommendations-Feature).
3. Baut aus deren **Genres** ein gewichtetes Profil und sucht darüber **neue** Künstler & Songs (bereits gehörte werden rausgefiltert).
4. **Swipe-UI**: ziehen, Buttons oder Pfeiltasten. 30-Sekunden-Vorschau, wo Spotify sie noch liefert.
5. Rechts-Swipe **pusht den Track in eine private Playlist**.

---

## Warum kein CLIENT_SECRET / kein Backend?

Bewusste Design-Entscheidung: Die App läuft **rein im Browser** und nutzt den
**PKCE-Flow**. Dabei gibt es prinzipbedingt **kein Client-Secret** — genau deshalb
ist ein reiner Frontend-Flow sicher. Was das für dich heißt:

- Nichts Geheimes kann versehentlich ins Repo geraten (es *existiert* kein Secret).
- Der Access-Token lebt nur im RAM (nicht in `localStorage`) → kleinere XSS-Angriffsfläche.
- Kein Server, keine Wrapper-Library (`spotipy` & Co.) nötig — die Spotify Web API wird direkt per `fetch` angesprochen.

Ein Secret bzw. `spotipy` wird erst relevant, **wenn** das geplante Python-Backend
(siehe [Roadmap](#roadmap)) dazukommt — dafür sind `.env.example` und
`backend/requirements.txt` bereits vorbereitet.

---

## Setup

### 1. Spotify-App anlegen
1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → **Create app**
2. **Redirect URI** exakt eintragen (Spotify lehnt `localhost` ab → `127.0.0.1` nutzen) und **Add** klicken:
   ```
   http://127.0.0.1:5500/
   ```
3. Nur **Web API** ankreuzen, speichern.
4. **Settings → User Management**: deine eigene Spotify-E-Mail eintragen (im Dev Mode Pflicht, sonst 403 beim Login).
5. **Client ID** aus den Settings kopieren.

### 2. Config setzen
```bash
cp frontend/config.example.js frontend/config.js
# dann in frontend/config.js die CLIENT_ID eintragen
```
`config.js` steht in `.gitignore` und landet nicht im Repo.

### 3. Lokal starten
```bash
npm install
npm start          # startet einen statischen Server auf Port 5500
```
Dann im Browser **`http://127.0.0.1:5500/`** öffnen (mit Slash am Ende, **nicht**
`/index.html` — sonst passt die Redirect-URI nicht).

> Ohne Node geht auch: `python3 -m http.server 5500 --directory frontend`

---

## Projektstruktur

```
matchify/
├── README.md
├── .gitignore              # ignoriert .env und frontend/config.js
├── .env.example            # Vorlage fürs Backend (v1), ohne echte Werte
├── package.json            # npm start → Dev-Server auf :5500
├── frontend/
│   ├── index.html          # die komplette App (Vanilla JS, kein Build)
│   ├── config.example.js   # Vorlage → kopieren zu config.js (gitignored)
│   └── config.js           # DEINE CLIENT_ID (nicht im Repo)
├── backend/                # v1 — noch nicht implementiert
│   ├── README.md
│   └── requirements.txt
└── docs/                   # Screenshot / GIF
```

---

## Roadmap

- **v0 (jetzt)** — Login, Genre-basierte Discovery, Swipe-UI, Playlist-Push. ✅
- **v1 — Online-Learning-Ranker.** Jeder Swipe wird bereits in `STATE.swipeLog`
  als `{features, label}` mitgeschrieben. Darauf ein leichtes Modell (logistische
  Regression), das das Deck live re-rankt.
- **v1 — Deezer-Proxy.** `artist/{id}/related` (keyless) über ein dünnes
  FastAPI-Backend → echte „ähnliche Künstler" statt reiner Genre-Suche.
- **später** — echte Audio-Features (BPM/Energy) aus 30s-Previews via `librosa`.

---

## Einschränkungen (Spotify Dev Mode)

- Erfordert ein **Spotify-Premium-Konto** und erlaubt **max. 5 Testnutzer**, die
  einzeln im Dashboard freizuschalten sind. Für Demo & Freundeskreis reicht das;
  ein öffentlicher Launch würde „Extended Quota" verlangen (registrierte Firma +
  250.000 MAU) und ist für ein Studienprojekt nicht vorgesehen.
- Spotify hat 2024 u.a. den Recommendations-Endpoint und die Audio-Features
  abgeschaltet — deshalb die eigene, genre-basierte Discovery.
- Viele Tracks liefern kein `preview_url` mehr; dann fehlt der 30s-Vorhörer,
  gewischt werden kann trotzdem.

---

## Lizenz

MIT
