// =============================================================
// config.example.js  ->  kopiere diese Datei zu  config.js
// und trag deine Spotify CLIENT_ID ein.
//
//   cp frontend/config.example.js frontend/config.js
//
// config.js steht in .gitignore und landet NIE im Repo.
//
// Hinweis: Die CLIENT_ID ist bei PKCE kein Geheimnis (sie steht ohnehin
// sichtbar in der Login-URL). Der Grund fürs Auslagern ist Ordnung —
// jeder trägt seine eigene ID ein, ohne die committete Datei zu ändern.
// Ein CLIENT_SECRET gibt es hier bewusst NICHT.
// =============================================================

window.MATCHIFY_CONFIG = {
  CLIENT_ID: "HIER_DEINE_SPOTIFY_CLIENT_ID",

  // Optional überschreibbar:
  // MARKET: "DE",
  // SCOPES: "user-top-read playlist-modify-private",
  // BACKEND_URL: "http://127.0.0.1:8000",  // Deezer-Proxy + ML-Ranker
};
