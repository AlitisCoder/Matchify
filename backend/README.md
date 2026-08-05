# Backend (v1 — geplant, noch nicht implementiert)

Das Frontend läuft komplett ohne Backend. Dieser Ordner ist der vorbereitete
Slot für die nächste Ausbaustufe:

- **Deezer-Proxy** — ruft `https://api.deezer.com/artist/{id}/related` (keyless)
  auf und umgeht so das CORS-Problem im Browser. Ziel: echte „ähnliche Künstler"
  statt reiner Genre-Suche.
- **Online-Learning-Ranker** — re-rankt das Swipe-Deck live anhand der Swipes
  (logistische Regression über die in `STATE.swipeLog` gesammelten Daten).

## Start (sobald Code existiert)

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```
