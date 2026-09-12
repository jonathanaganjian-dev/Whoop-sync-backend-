# ImmuniTrack WHOOP Sync Server

This is a small always-on server that connects to your WHOOP account once,
then automatically pulls your latest data every 3 hours in the background —
no manual exports, no re-uploading files. The ImmuniTrack dashboard then
reads from this server instead of a local file.

Total setup time: roughly 20-30 minutes, mostly waiting for accounts to
verify and the first deploy to finish.

---

## Step 1 — Register an app with WHOOP

1. Go to https://developer.whoop.com and sign in with your WHOOP account.
2. Create a new app (any name, e.g. "ImmuniTrack Sync").
3. You'll get a **Client ID** and **Client Secret** — save these somewhere safe.
4. WHOOP's form will also ask for a **Privacy Policy URL** and **Terms of
   Service URL**. This server already includes simple pages for both — once
   deployed (Step 2), they'll live at:
   - `https://YOUR-RENDER-URL.onrender.com/privacy`
   - `https://YOUR-RENDER-URL.onrender.com/terms`

   You can come back and fill these fields in after Step 2, once you know
   your real URL. Feel free to open `server.js` and edit the wording in the
   `/privacy` and `/terms` routes if you want it to sound more like you.
5. Leave the "Redirect URI" field for now — you'll fill it in after Step 2,
   once you know your server's real web address.
6. Under scopes, make sure these are enabled: `read:recovery`, `read:cycles`,
   `read:sleep`, `read:workout`, `read:profile`, `read:body_measurement`,
   `offline` (the last one lets the server refresh its access automatically
   without you logging in again).

## Step 2 — Deploy the server (using Render, free tier)

Render is used here because its free tier requires no credit card for a
small personal project like this. Railway or Fly.io work too, with similar steps.

1. Create a free account at https://render.com
2. Put this folder's code into a GitHub repository (create a new repo,
   upload these files: `server.js`, `package.json`, `.env.example`).
3. In Render, click **New → Web Service**, connect your GitHub repo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Under **Environment Variables**, add these (values from Step 1, plus your own secret):
   - `WHOOP_CLIENT_ID` → your Client ID
   - `WHOOP_CLIENT_SECRET` → your Client Secret
   - `WHOOP_REDIRECT_URI` → `https://YOUR-RENDER-URL.onrender.com/auth/callback`
     (Render shows you your app's URL before or right after the first deploy)
   - `DASHBOARD_SECRET` → make up any long random string, e.g. `x7k2m9p1q4z8`
6. Click **Deploy**. Wait for it to finish (a few minutes).
7. Copy your live URL (something like `https://immunitrack-sync.onrender.com`).

## Step 3 — Finish connecting WHOOP

1. Go back to your WHOOP developer app settings and paste in the real
   Redirect URI: `https://YOUR-RENDER-URL.onrender.com/auth/callback`
2. In your browser, visit: `https://YOUR-RENDER-URL.onrender.com/auth/whoop`
3. Log into WHOOP and approve access when prompted.
4. You should see "Connected to WHOOP" — that's it. The server now has
   permission to read your data and will keep it refreshed automatically.

## Step 4 — Point the dashboard at your server

In the ImmuniTrack dashboard, open the **Live Sync** tab and enter:
- **Server URL:** your Render URL from Step 2
- **Secret key:** the `DASHBOARD_SECRET` value you chose

The dashboard will pull your data from the server from then on — including
automatically refreshing itself periodically while it's open. The important
part: your data keeps updating on the server every 3 hours whether or not
the dashboard is even open. Open it whenever you want and it's current.

---

## Notes and honest caveats

- **Free tier sleep:** Render's free tier can "spin down" a server after
  periods of no traffic and take ~30-60 seconds to wake up on the next
  request. The scheduled sync should keep it warm most of the time, but if
  you notice gaps, a paid tier (a few dollars/month) removes this entirely.
- **API field names may drift:** WHOOP's API can change field names over
  time. If `npm start` runs fine but `/api/data` stays empty, check your
  Render logs for `[sync error]` messages — the fix is usually just updating
  a field name in `syncRecentData()` inside `server.js` to match whatever
  WHOOP's docs currently say.
- **This is now real infrastructure you're responsible for**, not a chat
  file. If you stop paying attention to it, it'll likely keep running quietly
  on the free tier, but it's still a live service with your login credentials
  behind it — treat the `DASHBOARD_SECRET` and WHOOP tokens with the same
  care as a password.
