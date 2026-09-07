# Inbox Manifest — setup guide

This is a real web app that signs in with your Gmail account and shows which
business inquiries still need a reply. Follow these steps in order.

## Part 1 — Create your Google login (10 minutes, no coding)

1. Go to https://console.cloud.google.com and sign in with the Gmail account
   you want the app to read.
2. Click the project dropdown at the top, then **New Project**. Name it
   anything (e.g. "Inbox Manifest") and click **Create**.
3. In the search bar, type **Gmail API** and open it. Click **Enable**.
4. In the left sidebar, go to **APIs & Services > OAuth consent screen**.
   - User type: **External**. Click Create.
   - Fill in the app name, your email as support contact, and your email
     again under developer contact. Save and continue through the remaining
     screens (you can skip scopes here — leave defaults — and skip test
     users for now, or add your own email as a test user).
5. Go to **APIs & Services > Credentials**. Click **Create Credentials >
   OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized redirect URIs**, add:
     `http://localhost:3000/auth/google/callback`
     (you'll add your live web address here too, once deployed — see Part 3)
   - Click **Create**. Copy the **Client ID** and **Client Secret** shown.

## Part 2 — Run it on your own computer first

1. Install Node.js if you don't have it: https://nodejs.org (choose the LTS version).
2. Open a terminal in this folder and run:
   ```
   npm install
   ```
3. Copy `.env.example` to a new file named `.env`, and paste in the
   Client ID and Client Secret from Part 1.
4. Run:
   ```
   npm start
   ```
5. Open http://localhost:3000 in your browser and click **Sign in with
   Google**. You should see your real inbox, categorized.

If step 5 works, the app itself is working correctly — what's left is putting
it on the internet so your phone (and your boss's) can reach it.

## Part 3 — Put it on the internet (so it works from your phone)

You need a place to run this continuously. A free option that works well for
small tools like this:

1. Create a free account at https://render.com
2. Click **New > Web Service**, and connect this project (Render will ask
   you to upload it or connect a GitHub repo — if you don't use GitHub, ask
   me and I'll walk you through the simplest upload path).
3. Set the **Build Command** to `npm install` and the **Start Command** to
   `npm start`.
4. Under **Environment**, add the same variables from your `.env` file
   (Client ID, Client Secret, a Session Secret, and set
   `GOOGLE_REDIRECT_URI` to `https://YOUR-RENDER-URL/auth/google/callback`).
5. Once deployed, go back to Google Cloud Console > Credentials, and add
   that same `https://YOUR-RENDER-URL/auth/google/callback` address to your
   Authorized redirect URIs.
6. Visit your Render URL on your phone, sign in, and add it to your home
   screen exactly as before (Share menu > Add to Home Screen).

## What this app does right now

- Signs in with real Google login (not through me/Claude — directly with Google)
- Pulls your last 21 days of inbox
- Categorizes each into Queries, Logistics, Payment, or Other
- Suggests a reply based on the category (simple template for now)
- Lets you mark an email as replied or fake — stored on the server, so it's
  remembered next time you open the app on any device

## Reasonable next upgrades (ask Claude Code to build these when ready)

- Smarter, personalized reply suggestions (would call the Anthropic API
  with your own API key from console.anthropic.com)
- A "sent-reply" check so items disappear automatically once you actually
  reply from Gmail
- Multi-user support so your boss gets his own login and his own view
