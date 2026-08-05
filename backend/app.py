"""
Matchify Backend v1
  GET  /related?artist=<name>  — Deezer-Proxy: verwandte Künstler (keyless, kein CORS)
  POST /rank                   — Online-Learning-Ranker (logistische Regression)
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from pydantic import BaseModel
from typing import List

app = FastAPI(title="Matchify Backend v1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

DEEZER = "https://api.deezer.com"


# ── Deezer-Proxy ─────────────────────────────────────────────────────────────

@app.get("/related")
async def get_related(artist: str = Query(..., min_length=1)):
    """Sucht den Künstler auf Deezer und gibt verwandte Künstler zurück."""
    async with httpx.AsyncClient(timeout=8.0) as client:
        search = await client.get(
            f"{DEEZER}/search/artist",
            params={"q": artist, "limit": 1},
        )
        if search.status_code != 200:
            return {"artists": []}

        data = search.json().get("data", [])
        if not data:
            return {"artists": []}

        artist_id = data[0]["id"]

        related = await client.get(
            f"{DEEZER}/artist/{artist_id}/related",
            params={"limit": 12},
        )
        if related.status_code != 200:
            return {"artists": []}

        names = [a["name"] for a in related.json().get("data", [])]
        return {"artists": names}


# ── Deezer Preview-Proxy ──────────────────────────────────────────────────────

@app.get("/preview")
async def get_preview(
    title: str = Query(..., min_length=1),
    artist: str = Query(..., min_length=1),
):
    """Sucht einen Track auf Deezer und gibt die 30-Sekunden Preview-URL zurück."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        res = await client.get(
            f"{DEEZER}/search/track",
            params={"q": f"{artist} {title}", "limit": 1},
        )
        if res.status_code != 200:
            return {"preview_url": None}
        data = res.json().get("data", [])
        if not data:
            return {"preview_url": None}
        return {"preview_url": data[0].get("preview") or None}


# ── ML-Ranker ─────────────────────────────────────────────────────────────────

class SwipeEntry(BaseModel):
    trackId: str
    genre: str
    score: float
    label: int   # 1 = rechts (rein), 0 = links (skip)


class TrackFeature(BaseModel):
    id: str
    genre: str
    score: float


class RankRequest(BaseModel):
    swipeLog: List[SwipeEntry]
    tracks: List[TrackFeature]


@app.post("/rank")
async def rank_tracks(req: RankRequest):
    """Re-rankt die verbleibenden Tracks per logistischer Regression."""
    if not req.tracks:
        return {"order": []}

    labels = [e.label for e in req.swipeLog]

    # Mindestens 3 Samples und beide Klassen vorhanden
    if len(req.swipeLog) < 3 or len(set(labels)) < 2:
        return {"order": [t.id for t in req.tracks]}

    try:
        from sklearn.linear_model import LogisticRegression

        all_genres = list(
            set(e.genre for e in req.swipeLog) | set(t.genre for t in req.tracks)
        )
        genre_idx = {g: i for i, g in enumerate(all_genres)}

        def to_vec(genre: str, score: float) -> list:
            vec = [0.0] * len(all_genres)
            if genre in genre_idx:
                vec[genre_idx[genre]] = 1.0
            vec.append(float(score))
            return vec

        X_train = [to_vec(e.genre, e.score) for e in req.swipeLog]
        clf = LogisticRegression(max_iter=300, random_state=42)
        clf.fit(X_train, labels)

        X_pred = [to_vec(t.genre, t.score) for t in req.tracks]
        probs = clf.predict_proba(X_pred)[:, 1]

        ranked = sorted(zip(req.tracks, probs), key=lambda x: -x[1])
        return {"order": [t.id for t, _ in ranked]}

    except Exception:
        return {"order": [t.id for t in req.tracks]}
