/**
 * GoalScope Backend — API-Football Proxy Server
 * ─────────────────────────────────────────────
 * Sits between your users and API-Football.
 * Your API key never reaches the browser.
 *
 * Endpoints exposed to the frontend:
 *   GET /api/teams?search=<name>
 *   GET /api/fixtures?team=<id>&next=<n>
 *   GET /api/fixtures/last?team=<id>&last=<n>
 *   GET /api/stats?team=<id>&league=<id>&season=<year>
 *   GET /api/leagues?team=<id>&current=true
 *   GET /health
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const NodeCache = require('node-cache');
const https    = require('https');

const app   = express();
const cache = new NodeCache({ stdTTL: parseInt(process.env.CACHE_TTL) || 300 });

// ── CORS ────────────────────────────────────────────────────
const rawOrigins = process.env.ALLOWED_ORIGINS || '*';
const corsOptions = rawOrigins === '*'
  ? { origin: '*' }
  : {
      origin: function (origin, callback) {
        const list = rawOrigins.split(',').map(o => o.trim());
        if (!origin || list.includes(origin)) return callback(null, true);
        callback(new Error('CORS blocked: ' + origin));
      }
    };
app.use(cors(corsOptions));
app.use(express.json());

// ── CONFIG ───────────────────────────────────────────────────
const API_KEY  = process.env.API_FOOTBALL_KEY;
const API_BASE = 'v3.football.api-sports.io';

if (!API_KEY || API_KEY === 'YOUR_API_FOOTBALL_KEY_HERE') {
  console.warn('\n⚠️  WARNING: API_FOOTBALL_KEY not set in .env\n');
}

// ── API-FOOTBALL FETCH ────────────────────────────────────────
function apiFootball(path) {
  return new Promise((resolve, reject) => {
    const cacheKey = path;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] ${path}`);
      return resolve(cached);
    }

    const options = {
      hostname: API_BASE,
      path: path,
      method: 'GET',
      headers: {
        'x-apisports-key': API_KEY
      }
    };

    console.log(`[API CALL] https://${API_BASE}${path}`);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Cache only successful responses with results
          if (parsed.results !== undefined) {
            cache.set(cacheKey, parsed);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse API response'));
        }
      });
    });

    req.on('error', err => reject(err));
    req.end();
  });
}

// ── MIDDLEWARE: key guard ─────────────────────────────────────
function keyGuard(req, res, next) {
  if (!API_KEY || API_KEY === 'YOUR_API_FOOTBALL_KEY_HERE') {
    return res.status(503).json({
      error: true,
      message: 'Server not configured — API key missing. Set API_FOOTBALL_KEY in .env'
    });
  }
  next();
}

// ── ROUTES ────────────────────────────────────────────────────

// Health check (Render uses this to confirm the service is alive)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'GoalScope Backend',
    timestamp: new Date().toISOString(),
    apiKeySet: !!(API_KEY && API_KEY !== 'YOUR_API_FOOTBALL_KEY_HERE'),
    cacheKeys: cache.keys().length
  });
});

// Team search — autocomplete
// GET /api/teams?search=arsenal
app.get('/api/teams', keyGuard, async (req, res) => {
  const { search } = req.query;
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: true, message: 'search param must be at least 3 characters' });
  }
  try {
    const data = await apiFootball(`/teams?search=${encodeURIComponent(search.trim())}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// Upcoming fixtures for a team
// GET /api/fixtures?team=33&next=5
app.get('/api/fixtures', keyGuard, async (req, res) => {
  const { team, next, status } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });
  const n = parseInt(next) || 5;
  const st = status || 'NS';
  try {
    const data = await apiFootball(`/fixtures?team=${team}&next=${n}&status=${st}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// Last N fixtures (for form context)
// GET /api/fixtures/last?team=33&last=5
app.get('/api/fixtures/last', keyGuard, async (req, res) => {
  const { team, last } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });
  const n = parseInt(last) || 5;
  try {
    const data = await apiFootball(`/fixtures?team=${team}&last=${n}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// Team season statistics
// GET /api/stats?team=33&league=39&season=2024
app.get('/api/stats', keyGuard, async (req, res) => {
  const { team, league, season } = req.query;
  if (!team || !league || !season) {
    return res.status(400).json({ error: true, message: 'team, league, and season params required' });
  }
  try {
    const data = await apiFootball(`/teams/statistics?team=${team}&league=${league}&season=${season}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// Leagues a team is in (to discover leagueId + season)
// GET /api/leagues?team=33&current=true
app.get('/api/leagues', keyGuard, async (req, res) => {
  const { team, current } = req.query;
  if (!team) return res.status(400).json({ error: true, message: 'team param required' });
  const cur = current === 'true' ? '&current=true' : '';
  try {
    const data = await apiFootball(`/leagues?team=${team}${cur}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// Head-to-head
// GET /api/h2h?h2h=33-34&last=10
app.get('/api/h2h', keyGuard, async (req, res) => {
  const { h2h, last } = req.query;
  if (!h2h) return res.status(400).json({ error: true, message: 'h2h param required (e.g. 33-34)' });
  const n = parseInt(last) || 10;
  try {
    const data = await apiFootball(`/fixtures/headtohead?h2h=${h2h}&last=${n}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: true, message: e.message });
  }
});

// Cache stats (admin use)
app.get('/api/cache-stats', (req, res) => {
  res.json({
    keys: cache.keys().length,
    stats: cache.getStats()
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: true, message: 'Route not found' });
});

// ── START ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 GoalScope Backend running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   API key set:  ${!!(API_KEY && API_KEY !== 'YOUR_API_FOOTBALL_KEY_HERE')}\n`);
});
