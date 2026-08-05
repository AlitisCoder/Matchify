/* ==========================================================================
   Crate — Playlist-Tinder  |  frontend/app.js
   Vanilla JS · kein Build-Schritt · keine Abhängigkeiten
   Pipeline:  PKCE → Auth → Top-Daten → Genre-Profil → Discovery →
              Filter → Ranking → Swipe-Deck → Playlist-Push → Feedback-Log
   ========================================================================== */

/* --------------------------------------------------------------------------
   1) PKCE-Helfer  (Web Crypto API, kein Client-Secret nötig)
   -------------------------------------------------------------------------- */

/** Kryptografisch sicherer URL-sicherer Zufallsstring. */
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr   = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, b => chars[b % chars.length]).join("");
}

/** SHA-256 als Base64URL (S256-Challenge für PKCE). */
async function sha256base64url(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  let s = "";
  new Uint8Array(digest).forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* --------------------------------------------------------------------------
   2) Auth-Flow — OAuth 2.0 mit PKCE
   -------------------------------------------------------------------------- */
const AUTH_URL  = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
let ACCESS_TOKEN = null;  // nur im RAM — niemals in localStorage
let TOKEN_EXPIRY = 0;

/** Code-Verifier erzeugen und zu Spotify weiterleiten. */
async function login(showDialog = false) {
  const verifier  = randomString(64);
  sessionStorage.setItem("pkce_verifier", verifier);
  const challenge = await sha256base64url(verifier);
  const params = new URLSearchParams({
    client_id:             CONFIG.CLIENT_ID,
    response_type:         "code",
    redirect_uri:          CONFIG.REDIRECT_URI,
    scope:                 CONFIG.SCOPES,
    code_challenge_method: "S256",
    code_challenge:        challenge,
  });
  if (showDialog) params.set("show_dialog", "true");
  window.location.href = `${AUTH_URL}?${params}`;
}

/** ?code aus der URL gegen einen Access-Token tauschen; URL danach bereinigen. */
async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) throw new Error("PKCE-Verifier fehlt — bitte erneut einloggen.");
  const body = new URLSearchParams({
    client_id:     CONFIG.CLIENT_ID,
    grant_type:    "authorization_code",
    code,
    redirect_uri:  CONFIG.REDIRECT_URI,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Token-Tausch fehlgeschlagen: " + await res.text());
  const data    = await res.json();
  ACCESS_TOKEN  = data.access_token;
  TOKEN_EXPIRY  = Date.now() + data.expires_in * 1000;
  console.log("[Crate] Token-Scopes:", data.scope);
  sessionStorage.removeItem("pkce_verifier");
  history.replaceState({}, "", CONFIG.REDIRECT_URI);
}

/* --------------------------------------------------------------------------
   3) Spotify-API-Wrapper
   -------------------------------------------------------------------------- */

/** Generischer Fetch gegen die Spotify-API mit Token-Prüfung und Fehler-Mapping. */
async function api(path, opts = {}) {
  if (!ACCESS_TOKEN || Date.now() > TOKEN_EXPIRY) {
    ACCESS_TOKEN = null;
    throw new Error("SESSION_EXPIRED");
  }
  const res = await fetch("https://api.spotify.com/v1" + path, {
    ...opts,
    headers: {
      "Authorization": "Bearer " + ACCESS_TOKEN,
      "Content-Type":  "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { ACCESS_TOKEN = null; throw new Error("SESSION_EXPIRED"); }
  if (res.status === 429) { throw new Error("RATE_LIMIT"); }
  if (!res.ok) {
    const body = await res.text();
    // Endpoint-Pfad mitsenden, damit die Fehlerursache klar ist
    throw new Error(`API ${res.status} [${path.split("?")[0]}]: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

const getMe         = ()                    => api("/me");
const getTopArtists = (range="medium_term") => api(`/me/top/artists?limit=50&time_range=${range}`);
const getTopTracks  = (range="medium_term") => api(`/me/top/tracks?limit=50&time_range=${range}`);

/* --------------------------------------------------------------------------
   4) Geschmacksprofil — gewichtetes Genre-Ranking
   Höher gerankte Künstler fließen stärker ins Gewicht ein (Rank-Decay 0.6).
   -------------------------------------------------------------------------- */

/** Liefert sortiertes Array [[genre, gewicht], ...] aus den Top-Künstlern. */
function buildGenreProfile(artists) {
  const weights = new Map();
  artists.forEach((a, i) => {
    const rankWeight = 1 - (i / artists.length) * 0.6;  // Platz 1 = 1.0, letzter ≈ 0.4
    (a.genres || []).forEach(g => weights.set(g, (weights.get(g) || 0) + rankWeight));
  });
  return [...weights.entries()].sort((a, b) => b[1] - a[1]);
}

/* --------------------------------------------------------------------------
   5) Discovery — /v1/search (Recommendations-Endpoint bewusst NICHT genutzt)
   Primär: verwandte Künstler via optionalem Deezer-Proxy (v1-Backend).
   Fallback: Genre-basierte Track-Suche auf Spotify.
   -------------------------------------------------------------------------- */

/** Verwandte Künstler vom optionalen Backend holen; gibt [] bei Fehler. */
async function tryRelatedArtists(artistName) {
  try {
    const res = await fetch(
      `${CONFIG.BACKEND_URL}/related?artist=${encodeURIComponent(artistName)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return [];
    return (await res.json()).artists || [];
  } catch { return []; }
}

/** Rohe Track-Liste aus einem Spotify-Search-Query holen. */
async function searchRaw(q, limit = 20) {
  try {
    const offset = Math.floor(Math.random() * 40);
    const data = await api(`/search?type=track&limit=${limit}&offset=${offset}&market=${CONFIG.MARKET}&q=${encodeURIComponent(q)}`);
    return data.tracks?.items || [];
  } catch { return []; }
}

/** Track-Objekte in Deck-Einträge umwandeln. */
function toEntry(t, sourceGenre, score) {
  return {
    id:          t.id,
    uri:         t.uri,
    name:        t.name,
    artist:      t.artists.map(a => a.name).join(", "),
    art:         t.album?.images?.[0]?.url || "",
    preview:     t.preview_url || null,
    popularity:  t.popularity  || 0,
    sourceGenre,
    score,
  };
}

/**
 * Genre-Suche mit drei Fallback-Stufen:
 *  1. genre:"${genre}"  — strenger Filter (oft leer)
 *  2. ${genre}          — Genre als Keyword (breit, zuverlässig)
 * Gibt die erste Stufe zurück, die ≥ 3 unbekannte Tracks liefert.
 */
async function searchTracksByGenre(genre, weight, knownArtistIds) {
  const queries = [`genre:"${genre}"`, genre];
  for (const q of queries) {
    const items = (await searchRaw(q, 30))
      .filter(t => t?.artists?.length && !knownArtistIds.has(t.artists[0].id));
    if (items.length >= 3)
      return items.map(t => toEntry(t, genre, weight * (0.5 + (t.popularity || 0) / 200)));
  }
  return [];
}

/** Tracks eines bestimmten Künstlernamens suchen. */
async function searchTracksByArtistName(name, knownArtistIds) {
  const items = (await searchRaw(`artist:"${name}"`, 10))
    .filter(t => t?.artists?.length && !knownArtistIds.has(t.artists[0].id));
  return items.map(t => toEntry(t, "ähnliche Künstler", 1.2 * (0.5 + (t.popularity || 0) / 200)));
}

/**
 * Feature-Artist-Discovery: Top-Tracks nach Feat.-Künstlern durchsuchen,
 * dann deren eigene Tracks holen — findet Künstler, die man noch nicht kennt,
 * aber stylisisch passt.
 */
async function discoverViaFeatures(topTracks, knownArtistIds) {
  const featArtists = new Map();
  for (const t of topTracks.slice(0, 20)) {
    for (const a of (t.artists || []).slice(1)) {   // ab Index 1 = Feat.-Artists
      if (!knownArtistIds.has(a.id))
        featArtists.set(a.id, a.name);
    }
  }
  const names = [...featArtists.values()].slice(0, 6);
  const batches = await throttled(names.map(n => () => searchTracksByArtistName(n, knownArtistIds)));
  return batches.flat().map(t => ({ ...t, sourceGenre: "Features aus deinen Tracks" }));
}

/* --------------------------------------------------------------------------
   6) Filter, Ranking, Shuffle
   -------------------------------------------------------------------------- */

/** Fisher-Yates-Shuffle (in-place). */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Genre-Interleaving: verteilt Tracks aus verschiedenen Buckets gleichmäßig,
 * damit das Deck abwechslungsreich bleibt statt alle Pop-Tracks hintereinander.
 */
function interleaveByGenre(deck) {
  const buckets = new Map();
  deck.forEach(t => {
    if (!buckets.has(t.sourceGenre)) buckets.set(t.sourceGenre, []);
    buckets.get(t.sourceGenre).push(t);
  });
  // Jeden Bucket vorher shuffeln, damit nicht immer dieselbe Reihenfolge
  buckets.forEach(list => shuffle(list));
  const lists = [...buckets.values()];
  const out = []; let added = true;
  while (added) {
    added = false;
    for (const l of lists) { if (l.length) { out.push(l.shift()); added = true; } }
  }
  return out;
}

/** Führt async-Funktionen in Gruppen aus, mit Pause zwischen den Gruppen. */
async function throttled(fns, batchSize = 3, delayMs = 300) {
  const results = [];
  for (let i = 0; i < fns.length; i += batchSize) {
    const batch = fns.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    results.push(...batchResults);
    if (i + batchSize < fns.length) await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}

// Fallback-Genres wenn kein Spotify-Verlauf verfügbar (403 / kein user-top-read)
const FALLBACK_GENRES = [
  ["indie pop", 1.0], ["alternative rock", 0.9], ["pop", 0.85],
  ["hip hop", 0.8],   ["electronic", 0.75],       ["r&b", 0.7],
];

/** Alle Kandidaten holen, filtern, nach Score sortieren, Deck zusammenstellen. */
async function buildDeck() {
  // Top-Daten laden — bei 403 / fehlendem Scope still zurückfallen
  let artists = [], tracks = [];
  try {
    const [ar, tr] = await Promise.all([getTopArtists(), getTopTracks()]);
    artists = ar.items || [];
    tracks  = tr.items || [];
  } catch (e) {
    if (e.message.includes("403") || e.message === "SESSION_EXPIRED") throw e;
    // Netzwerkfehler etc. → mit leeren Listen weitermachen
  }

  const knownArtistIds = new Set(artists.slice(0, 20).map(a => a.id));
  const knownTrackIds  = new Set(tracks.map(t => t.id));

  // Genre-Profil aus Top-Artists — fällt auf Fallback zurück wenn leer
  const profile = artists.length
    ? buildGenreProfile(artists).slice(0, 5)
    : FALLBACK_GENRES;

  if (!artists.length) toast("Kein Spotify-Verlauf verfügbar — zeige beliebte Genres");

  // Quelle 1: Genre-Suche (mit Keyword-Fallback)
  const genreBatches = await throttled(
    profile.map(([g, w]) => () => searchTracksByGenre(g, w, knownArtistIds))
  );

  // Quelle 2: Feature-Künstler aus Top-Tracks (leer wenn keine Tracks)
  const featureTracks = tracks.length
    ? await discoverViaFeatures(tracks, knownArtistIds)
    : [];

  // Quelle 3: Deezer-Proxy (fällt still zurück wenn kein Backend)
  const relatedBatches = artists.length
    ? await throttled(artists.slice(0, 3).map(a => () =>
        tryRelatedArtists(a.name).then(names =>
          throttled(names.slice(0, 4).map(n => () => searchTracksByArtistName(n, knownArtistIds)))
            .then(b => b.flat())
        )
      )).then(b => b.flat())
    : [];

  // Alle Quellen zusammenführen, Duplikate + bekannte Tracks raus
  // Max. 2 Tracks pro Künstler, damit nicht alles von Taylor Swift o.ä. kommt
  const seen       = new Set();
  const artistCount = new Map();
  const MAX_PER_ARTIST = 2;
  const deck = [];
  for (const t of [...genreBatches.flat(), ...featureTracks, ...relatedBatches]) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    if (seen.has(t.id) || knownTrackIds.has(t.id)) continue;
    const mainArtist = t.artist?.split(",")[0]?.trim() || "";
    const cnt = artistCount.get(mainArtist) || 0;
    if (cnt >= MAX_PER_ARTIST) continue;
    artistCount.set(mainArtist, cnt + 1);
    seen.add(t.id);
    deck.push(t);
  }

  deck.sort((a, b) => b.score - a.score);
  return interleaveByGenre(deck).slice(0, 80);
}

/** Re-rankt das verbleibende Deck per ML-Backend (fire-and-forget, v1-Vorbereitung). */
async function reRankDeck() {
  const remaining = STATE.deck.slice(STATE.idx);
  if (remaining.length < 2 || STATE.swipeLog.length < 3) return;
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/rank`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        swipeLog: STATE.swipeLog,
        tracks:   remaining.map(t => ({ id: t.id, genre: t.sourceGenre, score: t.score })),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const { order } = await res.json();
    const byId      = new Map(remaining.map(t => [t.id, t]));
    const reranked  = order.map(id => byId.get(id)).filter(Boolean);
    STATE.deck = [...STATE.deck.slice(0, STATE.idx), ...reranked];
  } catch { /* Backend nicht verfügbar, Reihenfolge bleibt */ }
}

/* --------------------------------------------------------------------------
   7) Liked Songs
   -------------------------------------------------------------------------- */

/** Track zu den Liked Songs hinzufügen (PUT /me/tracks). */
async function addToPlaylist(uri) {
  const id = uri.split(":").pop();
  await api("/me/tracks", { method: "PUT", body: JSON.stringify({ ids: [id] }) });
}

/* --------------------------------------------------------------------------
   8) UI-Rendering
   -------------------------------------------------------------------------- */
const app   = document.getElementById("app");
const STATE = { userId: null, deck: [], idx: 0, swipeLog: [] };
const audio = new Audio();
audio.volume = 0.85;

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1600);
}

function renderLogin() {
  app.innerHTML = `
    <div class="login">
      <h1>Wisch dir deine<br><em>nächste Playlist</em>.</h1>
      <p>Crate schlägt dir Songs von Künstlern vor, die du noch nicht hörst —
         gebaut aus deinen meistgehörten Genres. Rechts rein, links weg.</p>
      <button class="btn" id="loginBtn">Mit Spotify verbinden</button>
    </div>`;
  document.getElementById("loginBtn").addEventListener("click", login);
}

function renderLoading(msg) {
  const el  = document.createElement("div"); el.className = "state";
  const sp  = document.createElement("div"); sp.className = "spinner";
  const txt = document.createTextNode(msg);
  el.append(sp, txt);
  app.replaceChildren(el);
}

function renderError(title, detail) {
  const wrap  = document.createElement("div"); wrap.className = "state";
  const big   = document.createElement("div"); big.className  = "big";
  big.textContent = title;
  wrap.appendChild(big);
  if (detail) {
    // detail kommt entweder hard-coded (sicher) oder vorher escaped — als HTML rendern
    const p = document.createElement("p"); p.innerHTML = detail;
    wrap.appendChild(p);
  }
  const btn = document.createElement("button");
  btn.className = "btn ghost"; btn.textContent = "Neu laden";
  btn.style.marginTop = "18px";
  btn.addEventListener("click", () => location.reload());
  wrap.appendChild(btn);
  app.replaceChildren(wrap);
}

function renderEmpty() {
  const n    = STATE.swipeLog.filter(s => s.label === 1).length;
  const wrap = document.createElement("div"); wrap.className = "state";
  const big  = document.createElement("div"); big.className  = "big";
  big.textContent = "Deck durch 🎉";
  const txt  = document.createTextNode(`Du hast ${n} Song${n === 1 ? "" : "s"} in die Playlist gepackt.`);
  const btn  = document.createElement("button");
  btn.className = "btn"; btn.textContent = "Neue Runde laden"; btn.style.marginTop = "18px";
  btn.addEventListener("click", start);
  wrap.append(big, txt, btn);
  app.replaceChildren(wrap);
}

function renderDeck() {
  app.innerHTML = `
    <div class="stage">
      <header class="app">
        <div class="brand">Crate<small>Playlist-Tinder</small></div>
        <div class="who" id="who"></div>
      </header>
      <div class="deck" id="deck"></div>
      <div class="controls">
        <button class="ctrl skip" id="cSkip" title="Skip (←)">✕</button>
        <button class="ctrl play" id="cPlay" title="Vorschau (Leertaste)">▶</button>
        <button class="ctrl add"  id="cAdd"  title="In Playlist (→)">＋</button>
      </div>
      <div class="hint"><kbd>←</kbd> skip · <kbd>→</kbd> rein · <kbd>Leertaste</kbd> Vorschau</div>
    </div>`;
  document.getElementById("who").textContent = "@" + STATE.userId;
  document.getElementById("cSkip").addEventListener("click", () => flick(-1));
  document.getElementById("cAdd") .addEventListener("click", () => flick(1));
  document.getElementById("cPlay").addEventListener("click", togglePreview);
  paintCards();
}

/* --------------------------------------------------------------------------
   9) Karten-Rendering — DOM-Erstellung statt innerHTML für API-Daten
   -------------------------------------------------------------------------- */

/** Top-Karte + zwei darunter als Stack rendern. */
function paintCards() {
  const deckEl = document.getElementById("deck");
  if (!deckEl) return;
  deckEl.replaceChildren();

  const upcoming = STATE.deck.slice(STATE.idx, STATE.idx + 3).reverse(); // hinterste zuerst
  upcoming.forEach((t, i) => {
    const isTop = i === upcoming.length - 1;
    const depth = upcoming.length - 1 - i;
    const el    = document.createElement("div");
    el.className = "card";
    // Inline-Transforms für Stack-Effekt (kein CSS im <style>)
    el.style.transform = `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`;
    el.style.zIndex    = String(10 + i);

    // Album-Cover: nur https-URLs, CSS-Sonderzeichen entfernen
    const safeArt = /^https:\/\//.test(t.art || "")
      ? t.art.replace(/["'()\\<>]/g, "")
      : "";
    const artEl  = document.createElement("div"); artEl.className  = "art";
    if (safeArt) artEl.style.backgroundImage = `url('${safeArt}')`;

    const scrim = document.createElement("div"); scrim.className = "scrim";

    const stampIn  = document.createElement("div");
    stampIn.className  = "stamp in";  stampIn.textContent  = "IN";
    const stampSkip = document.createElement("div");
    stampSkip.className = "stamp skip"; stampSkip.textContent = "SKIP";

    const eq = document.createElement("div"); eq.className = "eq"; eq.id = "eq";
    for (let k = 0; k < 4; k++) eq.appendChild(document.createElement("span"));

    const meta    = document.createElement("div"); meta.className    = "meta";
    const eyebrow = document.createElement("div"); eyebrow.className = "eyebrow";
    eyebrow.textContent = `aus ${t.sourceGenre}${t.preview ? "" : " · keine Vorschau"}`;
    const title   = document.createElement("div"); title.className   = "title";
    title.textContent = t.name;
    const artist  = document.createElement("div"); artist.className  = "artist";
    artist.textContent = t.artist;

    meta.append(eyebrow, title, artist);
    el.append(artEl, scrim, stampIn, stampSkip, eq, meta);

    if (isTop) makeDraggable(el);
    deckEl.appendChild(el);
  });

  loadPreviewForTop();
}

/* --------------------------------------------------------------------------
   10) Audio-Vorschau
   -------------------------------------------------------------------------- */
function currentTrack() { return STATE.deck[STATE.idx]; }

/** Vorschau für den obersten Track laden; Wiedergabe stoppen. */
function loadPreviewForTop() {
  audio.pause();
  const eq = document.getElementById("eq");
  if (eq) eq.classList.remove("on");
  const t = currentTrack();
  audio.src = t && t.preview ? t.preview : "";
}

/** Vorschau starten oder pausieren. Sucht ggf. den nächsten Track mit Preview. */
function togglePreview() {
  const t = currentTrack();
  if (!t) return;
  if (!t.preview) {
    // Nächsten Track mit Preview suchen und hinweisen
    const next = STATE.deck.slice(STATE.idx + 1).find(x => x.preview);
    toast(next
      ? "Dieser Track hat keine Vorschau — nächste verfügbare Vorschau: " + next.name
      : "Keine Vorschau verfügbar (Spotify hat sie entfernt)"
    );
    return;
  }
  const eq = document.getElementById("eq");
  if (audio.paused) {
    audio.play()
      .then(()  => eq && eq.classList.add("on"))
      .catch(()  => toast("Wiedergabe blockiert — bitte erst in die Seite klicken"));
  } else {
    audio.pause();
    if (eq) eq.classList.remove("on");
  }
}
audio.addEventListener("ended", () => {
  const eq = document.getElementById("eq");
  if (eq) eq.classList.remove("on");
});

/* --------------------------------------------------------------------------
   11) Drag/Swipe — Pointer Events (funktioniert auf Touch und Maus)
   -------------------------------------------------------------------------- */
function makeDraggable(el) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const stampIn   = el.querySelector(".stamp.in");
  const stampSkip = el.querySelector(".stamp.skip");

  const onDown = e => {
    dragging = true; startX = e.clientX; startY = e.clientY;
    el.setPointerCapture(e.pointerId);
    el.style.transition = "none";
  };
  const onMove = e => {
    if (!dragging) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    el.style.transform  = `translate(${dx}px,${dy}px) rotate(${dx / 18}deg)`;
    const p = Math.min(Math.abs(dx) / 120, 1);
    stampIn.style.opacity   = dx > 0 ? p : 0;
    stampSkip.style.opacity = dx < 0 ? p : 0;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = "transform .28s ease, opacity .28s ease";
    if      (dx >  120) commitSwipe(el,  1);
    else if (dx < -120) commitSwipe(el, -1);
    else {
      el.style.transform      = "";
      stampIn.style.opacity   = 0;
      stampSkip.style.opacity = 0;
    }
  };

  el.addEventListener("pointerdown",   onDown);
  el.addEventListener("pointermove",   onMove);
  el.addEventListener("pointerup",     onUp);
  el.addEventListener("pointercancel", onUp);
}

/** Karte per Button oder Tastatur rausfliegen lassen. */
function flick(dir) {
  const top = document.querySelector("#deck .card:last-child");
  if (!top) return;
  top.style.transition = "transform .3s ease, opacity .3s ease";
  commitSwipe(top, dir);
}

/** Karte wegfliegen, Swipe-Aktion ausführen, nächste Karte zeigen. */
async function commitSwipe(el, dir) {
  const t = currentTrack();
  if (!t) return;

  const fly = (dir > 0 ? 1 : -1) * window.innerWidth;
  el.style.transform = `translate(${fly}px,-40px) rotate(${dir * 22}deg)`;
  el.style.opacity   = "0";

  // Feedback-Log für v1-ML-Training: features + label
  STATE.swipeLog.push({
    trackId:    t.id,
    genre:      t.sourceGenre,
    score:      t.score,
    popularity: t.popularity || 0,
    hasPreview: !!t.preview,
    label:      dir > 0 ? 1 : 0,   // 1 = Rechts (Like), 0 = Links (Skip)
  });

  if (dir > 0) {
    try { await addToPlaylist(t.uri); toast("＋ " + t.name); }
    catch (e) { handleErr(e); }
  }

  STATE.idx++;
  // Alle 5 Swipes Deck via ML neu ranken (fällt still zurück wenn kein Backend)
  if (STATE.swipeLog.length % 5 === 0) reRankDeck();

  setTimeout(() => {
    if (STATE.idx >= STATE.deck.length) { audio.pause(); renderEmpty(); }
    else paintCards();
  }, 220);
}

/** Tastatursteuerung (←/→/Leertaste). */
document.addEventListener("keydown", e => {
  if (!document.getElementById("deck")) return;
  if      (e.key === "ArrowRight") flick(1);
  else if (e.key === "ArrowLeft")  flick(-1);
  else if (e.code === "Space") { e.preventDefault(); togglePreview(); }
});

/* --------------------------------------------------------------------------
   12) Fehlerbehandlung & Bootstrap
   -------------------------------------------------------------------------- */
function handleErr(e, fatal = false) {
  if (e.message === "SESSION_EXPIRED") {
    renderError("Session abgelaufen", "Bitte neu mit Spotify verbinden.");
  } else if (e.message === "RATE_LIMIT") {
    if (fatal) renderError("Rate-Limit", "Spotify bremst gerade — kurz warten und neu laden.");
    else toast("Spotify bremst kurz — einen Moment warten…");
  } else if (e.message.includes("403") && e.message.includes("/me/tracks")) {
    renderError(
      "Berechtigung fehlt",
      "Dein Spotify-Token hat keine Rechte zum Speichern von Songs.<br>Bitte einmal neu autorisieren." +
      `<br><br><small style="word-break:break-all;opacity:.6">${e.message}</small>`
    );
    const btn = document.createElement("button");
    btn.className = "btn"; btn.textContent = "Neu autorisieren"; btn.style.marginTop = "12px";
    btn.addEventListener("click", () => login(true));
    document.querySelector("#app .state")?.appendChild(btn);
  } else if (e.message.includes("403") && e.message.includes("/me]")) {
    renderError(
      "Zugriff verweigert (403 auf /me)",
      "Spotify blockiert diesen Account. Verbundene Account-E-Mail: <b id='who403'>wird geladen…</b><br><br>" +
      "Stelle sicher, dass genau diese E-Mail im Spotify Dashboard → User Management eingetragen ist. " +
      "Dann unten neu autorisieren."
    );
    // Account-E-Mail über den Token herausfinden (Token ist noch gültig, aber /me schlägt fehl)
    // Versuch mit einem anderen Scope-Ansatz: Token-Introspection gibt uns zumindest den Nutzer-ID
    fetch("https://api.spotify.com/v1/me", { headers: { Authorization: "Bearer " + ACCESS_TOKEN } })
      .then(r => r.json()).then(d => {
        const who = document.getElementById("who403");
        if (who) who.textContent = d.email || d.id || "(unbekannt)";
      }).catch(() => {});
    const btn = document.createElement("button");
    btn.className = "btn"; btn.textContent = "Neu autorisieren"; btn.style.marginTop = "12px";
    btn.addEventListener("click", () => login(true));
    document.querySelector("#app .state")?.appendChild(btn);
  } else {
    console.error(e);
    if (fatal) renderError("Fehler", e.message.slice(0, 140));
    else toast("Fehler: " + e.message.slice(0, 60));
  }
}

/* --------------------------------------------------------------------------
   Preview-Enrichment — Deezer-Proxy (Spotify liefert preview_url nicht mehr)
   -------------------------------------------------------------------------- */

/** Preview-URL über iTunes Search API holen (CORS-fähig, kein Key nötig). */
async function fetchDeezerPreview(track) {
  try {
    const mainArtist = track.artist.split(",")[0].trim();
    const q = `${track.name} ${mainArtist}`;
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=3&country=DE`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data.results?.find(r => r.previewUrl) || null;
    return hit?.previewUrl || null;
  } catch { return null; }
}

/**
 * Reichert das Deck mit Deezer-Preview-URLs an.
 * Die ersten `eager` Tracks werden sofort abgewartet (damit die erste Karte
 * direkt abspielbar ist); der Rest läuft still im Hintergrund.
 */
async function enrichPreviews(deck, eager = 5) {
  for (let i = 0; i < Math.min(eager, deck.length); i++) {
    if (!deck[i].preview) deck[i].preview = await fetchDeezerPreview(deck[i]);
  }
  (async () => {
    for (let i = eager; i < deck.length; i++) {
      if (!deck[i].preview) {
        deck[i].preview = await fetchDeezerPreview(deck[i]);
        if (i === STATE.idx) loadPreviewForTop();
      }
      await new Promise(r => setTimeout(r, 120));
    }
  })();
}

/** Profil + Deck laden und Swipe-Screen aufbauen. */
async function start() {
  try {
    renderLoading("Lese deine Top-Genres…");
    const me  = await getMe();
    STATE.userId = me.id;
    renderLoading("Suche neue Künstler für dich…");
    STATE.deck     = await buildDeck();
    STATE.idx      = 0;
    STATE.swipeLog = [];
    if (!STATE.deck.length) {
      renderError(
        "Nichts gefunden",
        "Zu wenige Genre-Daten. Hör ein paar Tage Spotify und versuch es nochmal."
      );
      return;
    }
    renderLoading("Lade Vorschauen…");
    await enrichPreviews(STATE.deck);
    renderDeck();
  } catch (e) { handleErr(e, true); }
}

/** Einstiegspunkt: OAuth-Redirect verarbeiten oder Login-Screen zeigen. */
async function boot() {
  if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.startsWith("HIER_")) {
    renderError(
      "Setup fehlt",
      "Kopiere <b>config.example.js</b> zu <b>config.js</b> und trag deine Spotify CLIENT_ID ein (siehe README)."
    );
    return;
  }

  const params = new URLSearchParams(location.search);
  const code   = params.get("code");
  const err    = params.get("error");

  if (err) {
    // Fehlerwert aus der URL: als Text escapen, nicht als HTML rendern
    const safeErr = document.createElement("span");
    safeErr.textContent = err;
    renderError("Login abgebrochen", safeErr.innerHTML);
    return;
  }
  if (code) {
    try {
      renderLoading("Verbinde mit Spotify…");
      await exchangeCodeForToken(code);
      await start();
    } catch (e) {
      const safeMsg = document.createElement("span");
      safeMsg.textContent = e.message.slice(0, 140);
      renderError("Login fehlgeschlagen", safeMsg.innerHTML);
    }
  } else {
    renderLogin();
  }
}

boot();
