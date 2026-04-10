/**
 * The Odds Authority — Backend Proxy Server v3
 * ─────────────────────────────────────────────
 * Your API key never reaches the browser.
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
        (!origin || list.includes(origin)) ? cb(null, true) : cb(new Error('CORS: ' + origin));
      }
    }
));
app.use(express.json());

// ── API-FOOTBALL FETCH ────────────────────────────────────────
const API_KEY  = process.env.API_FOOTBALL_KEY;
const API_HOST = 'v3.football.api-sports.io';

if (!API_KEY || API_KEY === 'YOUR_KEY_HERE') {
  console.warn('\n⚠  WARNING: API_FOOTBALL_KEY not set in .env\n');
}

function apiFetch(path) {
  return new Promise((resolve, reject) => {
    const hit = cache.get(path);
    if (hit) { console.log(`[CACHE] ${path}`); return resolve(hit); }

    console.log(`[API]   https://${API_HOST}${path}`);
    const req = https.request(
      { hostname: API_HOST, path, method: 'GET', headers: { 'x-apisports-key': API_KEY } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.results !== undefined) cache.set(path, parsed);
            resolve(parsed);
          } catch(e) { reject(new Error('Parse error')); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── KEY GUARD ─────────────────────────────────────────────────
function guard(req, res, next) {
  if (!API_KEY || API_KEY === 'YOUR_KEY_HERE')
    return res.status(503).json({ error: true, message: 'API key not configured on server.' });
  next();
}

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'The Odds Authority Backend v3',
  timestamp: new Date().toISOString(),
  apiKeySet: !!(API_KEY && API_KEY !== 'YOUR_KEY_HERE'),
  cached: cache.keys().length
}));

// Team search autocomplete
app.get('/api/teams', guard, async (req, res) => {
  const { search } = req.query;
  if (!search || search.trim().length < 3)
    return res.status(400).json({ error: true, message: 'Minimum 3 characters required' });
  try { res.json(await apiFetch(`/teams?search=${encodeURIComponent(search.trim())}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// Upcoming fixtures — uses next= with no status filter so all scheduled games appear
app.get('/api/fixtures', guard, async (req, res) => {
  const { team, next } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team required' });
  try { res.json(await apiFetch(`/fixtures?team=${team}&next=${next||5}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// Last N fixtures for form context
app.get('/api/fixtures/last', guard, async (req, res) => {
  const { team, last } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team required' });
  try { res.json(await apiFetch(`/fixtures?team=${team}&last=${last||5}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// Season statistics — tries current season first, falls back to previous
app.get('/api/stats', guard, async (req, res) => {
  const { team, league, season } = req.query;
  if (!team || !league || !season)
    return res.status(400).json({ error: true, message: 'team, league, season required' });
  try {
    const data = await apiFetch(`/teams/statistics?team=${team}&league=${league}&season=${season}`);
    // If no data returned for this season, try the previous season automatically
    if (!data.response || !data.response.fixtures) {
      const prev = parseInt(season) - 1;
      const fallback = await apiFetch(`/teams/statistics?team=${team}&league=${league}&season=${prev}`);
      return res.json(fallback);
    }
    res.json(data);
  } catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// Leagues for a team — always fetch current=true to get active season year
app.get('/api/leagues', guard, async (req, res) => {
  const { team, current } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team required' });
  try { res.json(await apiFetch(`/leagues?team=${team}${current === 'true' ? '&current=true' : ''}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// Predictions — returns winner, win/draw/away %, under/over, predicted goals, comparison
app.get('/api/predictions', guard, async (req, res) => {
  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: true, message: 'fixture id required' });
  try { res.json(await apiFetch(`/predictions?fixture=${fixture}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// Head-to-head
app.get('/api/h2h', guard, async (req, res) => {
  const { h2h, last } = req.query;
  if (!h2h) return res.status(400).json({ error: true, message: 'h2h required (e.g. 33-34)' });
  try { res.json(await apiFetch(`/fixtures/headtohead?h2h=${h2h}&last=${last||10}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// League standings
app.get('/api/standings', guard, async (req, res) => {
  const { league, season } = req.query;
  if (!league || !season) return res.status(400).json({ error: true, message: 'league, season required' });
  try { res.json(await apiFetch(`/standings?league=${league}&season=${season}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// Injuries for a fixture
app.get('/api/injuries', guard, async (req, res) => {
  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: true, message: 'fixture id required' });
  try { res.json(await apiFetch(`/injuries?fixture=${fixture}`)); }
  catch(e) { res.status(502).json({ error: true, message: e.message }); }
});

// 404
app.use((req, res) => res.status(404).json({ error: true, message: 'Not found' }));

// ── START ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  The Odds Authority Backend v3  →  port ${PORT}`);
  console.log(`    API key set: ${!!(API_KEY && API_KEY !== 'YOUR_KEY_HERE')}\n`);
});
