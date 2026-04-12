/**
 * The Odds Authority — Backend Proxy Server v5
 * ─────────────────────────────────────────────
 * v5 fixes:
 *  - Explicit OPTIONS preflight handler (fixes CORS "Connecting" issue)
 *  - Manual CORS headers on every response (belt-and-braces)
 *  - Live fixtures status param now passed through correctly
 *
 * Routes:
 *   GET /health
 *   GET /api/teams?search=<n>
 *   GET /api/fixtures?team=<id>&next=<n>
 *   GET /api/fixtures?team=<id>&status=<codes>   ← NEW: live games
 *   GET /api/fixtures/last?team=<id>&last=<n>
 *   GET /api/stats?team=<id>&league=<id>&season=<year>
 *   GET /api/leagues?team=<id>&current=true
 *   GET /api/predictions?fixture=<id>
 *   GET /api/h2h?h2h=<id1-id2>&last=<n>
 *   GET /api/standings?league=<id>&season=<year>
 *   GET /api/injuries?fixture=<id>
 */

require('dotenv').config();
const express   = require('express');
const NodeCache = require('node-cache');
const https     = require('https');

const app   = express();
const cache = new NodeCache({ stdTTL: parseInt(process.env.CACHE_TTL) || 300 });

// ── CORS — manual headers on every response ───────────────────
// Belt-and-braces: don't rely on the cors package at all.
// This guarantees preflight OPTIONS requests are handled correctly.
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────
const API_KEY  = process.env.API_FOOTBALL_KEY;
const API_HOST = 'v3.football.api-sports.io';

if (!API_KEY || API_KEY === 'YOUR_KEY_HERE') {
  console.warn('\n⚠  WARNING: API_FOOTBALL_KEY not set in .env\n');
}

// ── CORE FETCH ────────────────────────────────────────────────
function apiFetch(path) {
  return new Promise((resolve, reject) => {
    const hit = cache.get(path);
    if (hit) {
      console.log(`[CACHE] ${path}`);
      return resolve(hit);
    }

    console.log(`[API]   https://${API_HOST}${path}`);

    const req = https.request(
      {
        hostname: API_HOST,
        path,
        method: 'GET',
        headers: { 'x-apisports-key': API_KEY }
      },
      res => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.results !== undefined) cache.set(path, parsed);
            resolve(parsed);
          } catch (e) {
            reject(new Error('Failed to parse API response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── KEY GUARD ─────────────────────────────────────────────────
function guard(req, res, next) {
  if (!API_KEY || API_KEY === 'YOUR_KEY_HERE') {
    return res.status(503).json({
      error: true,
      message: 'API key not configured. Set API_FOOTBALL_KEY in Render environment variables.'
    });
  }
  next();
}

// ── ROUTES ────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'The Odds Authority Backend v5',
    timestamp: new Date().toISOString(),
    apiKeySet: !!(API_KEY && API_KEY !== 'YOUR_KEY_HERE'),
    cachedKeys: cache.keys().length
  });
});

// ── TEAM SEARCH ───────────────────────────────────────────────
app.get('/api/teams', guard, async (req, res) => {
  const { search } = req.query;
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: true, message: 'Minimum 3 characters required' });
  }
  try {
    res.json(await apiFetch(`/teams?search=${encodeURIComponent(search.trim())}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── FIXTURES (upcoming AND live) ──────────────────────────────
// Supports:
//   ?team=42&next=5          → upcoming fixtures
//   ?team=42&status=1H-HT-2H → live fixtures (new)
app.get('/api/fixtures', guard, async (req, res) => {
  const { team, next, status } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });

  try {
    let apiPath;
    if (status) {
      // Live games query — pass status codes through directly
      apiPath = `/fixtures?team=${team}&status=${encodeURIComponent(status)}`;
    } else {
      const n = Math.min(parseInt(next) || 5, 10);
      apiPath = `/fixtures?team=${team}&next=${n}`;
    }
    res.json(await apiFetch(apiPath));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── LAST N FIXTURES (form context) ───────────────────────────
app.get('/api/fixtures/last', guard, async (req, res) => {
  const { team, last } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });
  const n = Math.min(parseInt(last) || 5, 10);
  try {
    res.json(await apiFetch(`/fixtures?team=${team}&last=${n}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── LEAGUES ───────────────────────────────────────────────────
app.get('/api/leagues', guard, async (req, res) => {
  const { team, current } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });
  try {
    const data = await apiFetch(`/leagues?team=${team}${current === 'true' ? '&current=true' : ''}`);
    if (data.response && data.response.length > 0) {
      const sorted = [...data.response].sort((a, b) => {
        return (a.league?.type === 'League' ? 0 : 1) - (b.league?.type === 'League' ? 0 : 1);
      });
      data.response = sorted;
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── SEASON STATISTICS ─────────────────────────────────────────
app.get('/api/stats', guard, async (req, res) => {
  const { team, league, season } = req.query;
  if (!team || !league || !season) {
    return res.status(400).json({ error: true, message: 'team, league, season all required' });
  }
  try {
    const data = await apiFetch(`/teams/statistics?team=${team}&league=${league}&season=${season}`);
    if (!data.response || !data.response.fixtures || data.response.fixtures.played.total === 0) {
      const prevSeason = parseInt(season) - 1;
      console.log(`[STATS] No data for season ${season}, trying ${prevSeason}`);
      const fallback = await apiFetch(`/teams/statistics?team=${team}&league=${league}&season=${prevSeason}`);
      return res.json(fallback);
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── PREDICTIONS ───────────────────────────────────────────────
app.get('/api/predictions', guard, async (req, res) => {
  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: true, message: 'fixture id required' });
  try {
    res.json(await apiFetch(`/predictions?fixture=${fixture}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── HEAD TO HEAD ──────────────────────────────────────────────
app.get('/api/h2h', guard, async (req, res) => {
  const { h2h, last } = req.query;
  if (!h2h) return res.status(400).json({ error: true, message: 'h2h param required (e.g. 33-34)' });
  const n = Math.min(parseInt(last) || 10, 20);
  try {
    res.json(await apiFetch(`/fixtures/headtohead?h2h=${h2h}&last=${n}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── STANDINGS ─────────────────────────────────────────────────
app.get('/api/standings', guard, async (req, res) => {
  const { league, season } = req.query;
  if (!league || !season) {
    return res.status(400).json({ error: true, message: 'league and season required' });
  }
  try {
    res.json(await apiFetch(`/standings?league=${league}&season=${season}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── INJURIES ──────────────────────────────────────────────────
app.get('/api/injuries', guard, async (req, res) => {
  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: true, message: 'fixture id required' });
  try {
    res.json(await apiFetch(`/injuries?fixture=${fixture}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── CACHE INFO ────────────────────────────────────────────────
app.get('/api/cache', (req, res) => {
  res.json({ keys: cache.keys().length, stats: cache.getStats() });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: true, message: `Route not found: ${req.path}` });
});

// ── START ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  The Odds Authority Backend v5  →  port ${PORT}`);
  console.log(`    API key configured: ${!!(API_KEY && API_KEY !== 'YOUR_KEY_HERE')}`);
  console.log(`    CORS: open to all origins (OPTIONS preflight handled)`);
  console.log(`    Routes: teams, fixtures (+ live), stats, predictions, h2h, standings, injuries, leagues\n`);
});
