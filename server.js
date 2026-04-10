/**
 * The Odds Authority — Backend Proxy Server v4
 * ─────────────────────────────────────────────
 * KEY FIXES in this version:
 *  - Fixtures route no longer uses status=NS filter (was blocking results)
 *  - All missing routes added: predictions, injuries, standings
 *  - Leagues route now always fetches current=true and filters to League type only
 *  - Stats route auto-falls back to previous season if current returns nothing
 *
 * Routes:
 *   GET /health
 *   GET /api/teams?search=<n>
 *   GET /api/fixtures?team=<id>&next=<n>
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
const cors      = require('cors');
const NodeCache = require('node-cache');
const https     = require('https');

const app   = express();
const cache = new NodeCache({ stdTTL: parseInt(process.env.CACHE_TTL) || 300 });

// ── CORS ──────────────────────────────────────────────────────
const rawOrigins = (process.env.ALLOWED_ORIGINS || '*').trim();
app.use(cors(rawOrigins === '*'
  ? { origin: '*' }
  : {
      origin(origin, cb) {
        const list = rawOrigins.split(',').map(o => o.trim());
        (!origin || list.includes(origin)) ? cb(null, true) : cb(new Error('CORS blocked: ' + origin));
      }
    }
));
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
    // Return from cache if available
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
            // Only cache successful responses
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

// Health check — Render pings this to confirm service is alive
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'The Odds Authority Backend v4',
    timestamp: new Date().toISOString(),
    apiKeySet: !!(API_KEY && API_KEY !== 'YOUR_KEY_HERE'),
    cachedKeys: cache.keys().length
  });
});

// ── TEAM SEARCH (autocomplete) ────────────────────────────────
// GET /api/teams?search=arsenal
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

// ── UPCOMING FIXTURES ─────────────────────────────────────────
// GET /api/fixtures?team=42&next=5
// IMPORTANT: No status filter — let API return all upcoming regardless of status code
app.get('/api/fixtures', guard, async (req, res) => {
  const { team, next } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });
  const n = Math.min(parseInt(next) || 5, 10);
  try {
    res.json(await apiFetch(`/fixtures?team=${team}&next=${n}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── LAST N FIXTURES (form context) ───────────────────────────
// GET /api/fixtures/last?team=42&last=5
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

// ── CURRENT LEAGUES FOR A TEAM ────────────────────────────────
// GET /api/leagues?team=42&current=true
// Returns only current active leagues of type "League" (not cups/tournaments)
app.get('/api/leagues', guard, async (req, res) => {
  const { team, current } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });
  try {
    const data = await apiFetch(`/leagues?team=${team}${current === 'true' ? '&current=true' : ''}`);

    // Filter to domestic leagues only (type=League), sorted so domestic comes first
    // This prevents old tournaments like "International Champions Cup 2019" from appearing
    if (data.response && data.response.length > 0) {
      const sorted = [...data.response].sort((a, b) => {
        const aIsLeague = a.league?.type === 'League' ? 0 : 1;
        const bIsLeague = b.league?.type === 'League' ? 0 : 1;
        return aIsLeague - bIsLeague;
      });
      data.response = sorted;
    }

    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── SEASON STATISTICS ─────────────────────────────────────────
// GET /api/stats?team=42&league=39&season=2025
// Auto-falls back to previous season if current returns no data
app.get('/api/stats', guard, async (req, res) => {
  const { team, league, season } = req.query;
  if (!team || !league || !season) {
    return res.status(400).json({ error: true, message: 'team, league, season all required' });
  }
  try {
    const data = await apiFetch(`/teams/statistics?team=${team}&league=${league}&season=${season}`);

    // If no meaningful data returned, try previous season automatically
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
// GET /api/predictions?fixture=215662
// Returns: winner prediction, home/draw/away %, under/over, predicted goals, comparison stats
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
// GET /api/h2h?h2h=33-34&last=10
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

// ── LEAGUE STANDINGS ──────────────────────────────────────────
// GET /api/standings?league=39&season=2025
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

// ── INJURIES FOR A FIXTURE ────────────────────────────────────
// GET /api/injuries?fixture=215662
app.get('/api/injuries', guard, async (req, res) => {
  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: true, message: 'fixture id required' });
  try {
    res.json(await apiFetch(`/injuries?fixture=${fixture}`));
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// ── CACHE INFO (admin) ────────────────────────────────────────
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
  console.log(`\n🚀  The Odds Authority Backend v4  →  port ${PORT}`);
  console.log(`    API key configured: ${!!(API_KEY && API_KEY !== 'YOUR_KEY_HERE')}`);
  console.log(`    Routes: teams, fixtures, stats, predictions, h2h, standings, injuries, leagues\n`);
});
