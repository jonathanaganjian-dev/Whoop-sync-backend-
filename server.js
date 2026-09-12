require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// ---------- Storage ----------
const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,
  recovery REAL, rhr REAL, hrv REAL, skin_temp REAL, spo2 REAL,
  strain REAL, resp_rate REAL, sleep_perf REAL, sleep_eff REAL, asleep_min REAL
);
`);

// ---------- Config ----------
const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI = process.env.WHOOP_REDIRECT_URI; // e.g. https://your-app.onrender.com/auth/callback
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || 'change-me';

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API_BASE = 'https://api.prod.whoop.com/developer/v2';

if(!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI){
  console.warn('[warning] Missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET / WHOOP_REDIRECT_URI env vars. Set these before connecting.');
}

// ---------- Token helpers ----------
function saveTokens(tok){
  const expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  db.prepare(`
    INSERT INTO tokens (id, access_token, refresh_token, expires_at) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at
  `).run(tok.access_token, tok.refresh_token, expiresAt);
}

function getTokens(){
  return db.prepare('SELECT * FROM tokens WHERE id=1').get();
}

async function refreshIfNeeded(){
  const t = getTokens();
  if(!t) throw new Error('Not connected to WHOOP yet. Visit /auth/whoop in your browser once to connect.');
  if(Date.now() < t.expires_at - 60000) return t.access_token;

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await resp.json();
  if(!resp.ok) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  saveTokens(data);
  return data.access_token;
}

// ---------- OAuth routes ----------
app.get('/auth/whoop', (req, res) => {
  const scopes = ['read:recovery','read:cycles','read:sleep','read:workout','read:profile','read:body_measurement','offline'].join(' ');
  const url = `${AUTH_URL}?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=immunitrack`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if(error) return res.status(400).send('WHOOP returned an error: ' + error);
  if(!code) return res.status(400).send('Missing authorization code.');

  try{
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await resp.json();
    if(!resp.ok) throw new Error(JSON.stringify(data));
    saveTokens(data);
    await syncRecentData().catch(e => console.error('[initial sync error]', e.message));
    res.send('Connected to WHOOP. You can close this tab â data will now sync automatically in the background.');
  }catch(e){
    console.error('[oauth callback error]', e.message);
    res.status(500).send('Something went wrong connecting to WHOOP: ' + e.message);
  }
});

// ---------- Data sync ----------
function upsertDay(day){
  db.prepare(`
    INSERT INTO days (date,recovery,rhr,hrv,skin_temp,spo2,strain,resp_rate,sleep_perf,sleep_eff,asleep_min)
    VALUES (@date,@recovery,@rhr,@hrv,@skin_temp,@spo2,@strain,@resp_rate,@sleep_perf,@sleep_eff,@asleep_min)
    ON CONFLICT(date) DO UPDATE SET
      recovery   = COALESCE(excluded.recovery, recovery),
      rhr        = COALESCE(excluded.rhr, rhr),
      hrv        = COALESCE(excluded.hrv, hrv),
      skin_temp  = COALESCE(excluded.skin_temp, skin_temp),
      spo2       = COALESCE(excluded.spo2, spo2),
      strain     = COALESCE(excluded.strain, strain),
      resp_rate  = COALESCE(excluded.resp_rate, resp_rate),
      sleep_perf = COALESCE(excluded.sleep_perf, sleep_perf),
      sleep_eff  = COALESCE(excluded.sleep_eff, sleep_eff),
      asleep_min = COALESCE(excluded.asleep_min, asleep_min)
  `).run(day);
}

// NOTE: WHOOP's API evolves â if field names below don't match what comes back,
// print the raw JSON (console.log(JSON.stringify(data))) and adjust the mapping.
// This reflects the v2 API structure as documented at developer.whoop.com as of this writing.
async function syncRecentData(){
  const token = await refreshIfNeeded();

  const cycleResp = await fetch(`${API_BASE}/cycle?limit=30`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const cycleData = await cycleResp.json();
  if(!cycleResp.ok) throw new Error('Cycle fetch failed: ' + JSON.stringify(cycleData));

  let count = 0;
  for(const cyc of cycleData.records || []){
    const date = (cyc.start || '').slice(0, 10);
    if(!date) continue;

    let recovery = null, hrv = null, rhr = null, spo2 = null, skinTemp = null;
    try{
      const rResp = await fetch(`${API_BASE}/cycle/${cyc.id}/recovery`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rData = await rResp.json();
      if(rResp.ok && rData.score){
        recovery = rData.score.recovery_score ?? null;
        hrv = rData.score.hrv_rmssd_milli ?? null;
        rhr = rData.score.resting_heart_rate ?? null;
        spo2 = rData.score.spo2_percentage ?? null;
        skinTemp = rData.score.skin_temp_celsius ?? null;
      }
    }catch(e){ /* recovery may not exist yet for a very recent cycle */ }

    upsertDay({
      date,
      recovery, rhr, hrv, skin_temp: skinTemp, spo2,
      strain: cyc.score ? cyc.score.strain ?? null : null,
      resp_rate: null,
      sleep_perf: null, sleep_eff: null, asleep_min: null,
    });
    count++;
  }
  console.log(`[sync] pulled ${count} cycle(s) at ${new Date().toISOString()}`);
}

// Runs automatically every 3 hours â this is the actual "automatic" part.
cron.schedule('0 */3 * * *', () => {
  syncRecentData().catch(e => console.error('[scheduled sync error]', e.message));
});

// Also sync once when the server starts up (e.g. after a redeploy).
syncRecentData().catch(e => console.log('[startup] no data yet â', e.message));

// ---------- API for the dashboard ----------
app.get('/api/data', (req, res) => {
  if(req.query.key !== DASHBOARD_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const rows = db.prepare('SELECT * FROM days ORDER BY date ASC').all();
  res.json(rows);
});

app.get('/api/sync-now', async (req, res) => {
  if(req.query.key !== DASHBOARD_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try{
    await syncRecentData();
    res.json({ ok: true });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('ImmuniTrack sync server is running.'));

// ---------- Privacy Policy & Terms (required by WHOOP's developer portal) ----------
// These are served here so you get real, working URLs without needing separate
// hosting. Edit the text below to reflect your actual name/contact if you want.
app.get('/privacy', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Privacy Policy</title>
  <style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1c2321;}
  h1{font-size:22px;} h2{font-size:16px;margin-top:28px;}</style></head><body>
  <h1>Privacy Policy</h1>
  <p><em>Last updated: ${new Date().toISOString().slice(0,10)}</em></p>
  <p>This application ("ImmuniTrack Sync") is a personal health-tracking tool built and used by a single individual for their own use. It is not a commercial product and does not have other users or customers.</p>

  <h2>What data is collected</h2>
  <p>This app connects to the WHOOP API to retrieve the account owner's own physiological data, including heart rate, heart rate variability, respiratory rate, skin temperature, blood oxygen, recovery scores, sleep, and workout strain.</p>

  <h2>How the data is used</h2>
  <p>Data is used exclusively to power a personal dashboard that helps the account owner notice changes in their own body over time. It is not used for any other purpose.</p>

  <h2>How the data is stored</h2>
  <p>Data is stored in a private database controlled by the account owner, on infrastructure the account owner has deployed themselves. It is not shared with, sold to, or accessed by any third party.</p>

  <h2>Data retention and deletion</h2>
  <p>Data is retained for as long as the account owner continues to use the app. The account owner can delete all stored data at any time by deleting the underlying database, or can revoke this app's access at any time from their WHOOP account settings.</p>

  <h2>Advertising</h2>
  <p>This app displays no advertising and shares no data with advertisers.</p>

  <h2>Contact</h2>
  <p>This is a personal project. Questions can be directed to the account owner directly.</p>
  </body></html>`);
});

app.get('/terms', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Terms of Service</title>
  <style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1c2321;}
  h1{font-size:22px;} h2{font-size:16px;margin-top:28px;}</style></head><body>
  <h1>Terms of Service</h1>
  <p><em>Last updated: ${new Date().toISOString().slice(0,10)}</em></p>
  <p>This application ("ImmuniTrack Sync") is a personal, single-user health-tracking tool. It is provided as-is, with no warranty of any kind, for the sole use of its owner.</p>

  <h2>Not a medical device</h2>
  <p>This app is a personal wellness and screening tool. It does not diagnose, treat, cure, or prevent any disease, and is not a substitute for professional medical advice. Always consult a qualified healthcare provider with questions about a medical condition.</p>

  <h2>Use of WHOOP data</h2>
  <p>This app accesses WHOOP account data solely with the account owner's own authorization, for the account owner's own personal use, in accordance with WHOOP's developer platform terms.</p>

  <h2>No warranty</h2>
  <p>This software is provided "as is" without warranty of any kind. The account owner assumes all responsibility for its use.</p>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port ' + PORT));
