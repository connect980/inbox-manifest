require("dotenv").config();
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const webpush = require("web-push");

let VAPID_KEYS;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  VAPID_KEYS = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  VAPID_KEYS = webpush.generateVAPIDKeys();
  console.log("No VAPID keys set in environment. Generated temporary ones for this run:");
  console.log("VAPID_PUBLIC_KEY=" + VAPID_KEYS.publicKey);
  console.log("VAPID_PRIVATE_KEY=" + VAPID_KEYS.privateKey);
  console.log("Add these to your environment variables so they stay stable across restarts.");
}
webpush.setVapidDetails("mailto:admin@globaloils.us", VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
  })
);

// ---------- tiny file-based store for "marked replied / marked fake" ----------
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- Google OAuth ----------
function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email"
];

app.get("/auth/google", (req, res) => {
  const client = oauthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ auth: client, version: "v2" });
    const me = await oauth2.userinfo.get();

    req.session.tokens = tokens;
    req.session.email = me.data.email;

    const db = loadDb();
    db[me.data.email] = db[me.data.email] || {};
    db[me.data.email].tokens = tokens;
    saveDb(db);

    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.status(500).send("Login failed. Close this tab and try again.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.tokens) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, email: req.session.email });
});

// ---------- middleware: require login ----------
function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: "not_logged_in" });
  next();
}

function gmailClient(req) {
  const client = oauthClient();
  client.setCredentials(req.session.tokens);
  return google.gmail({ version: "v1", auth: client });
}

// ---------- categorization (simple keyword rules — swap in an AI call here later) ----------
function categorize(text) {
  const t = text.toLowerCase();
  const has = (...words) => words.some(w => t.includes(w));

  if (has("invoice", "payment", "credit card", "credit application", "net 15", "net 30", "net15", "net30", "billing", "account setup"))
    return "payment";
  if (has("shipping", "delivery", "freight", "logistics", "drayage", "co-pack", "co-packing", "pickup", "transport", "truckload", "ex works", "fob"))
    return "logistics";
  if (has("quote", "quotation", "price", "pricing", "sourcing", "interested in purchasing", "order", "catalogue", "catalog", "moq"))
    return "queries";
  return "other";
}

function suggestReply(subject, body) {
  const category = categorize(subject + " " + body);
  const openers = {
    payment: "Thank you for your message regarding payment and account setup.",
    logistics: "Thank you for the details on shipping and logistics.",
    queries: "Thank you for your interest and for reaching out with your request.",
    other: "Thank you for getting in touch."
  };
  return (
    `${openers[category]}\n\n` +
    `We're reviewing the details you've shared and will follow up with specifics ` +
    `(pricing, availability, and next steps) within 1–2 business days.\n\n` +
    `Please let us know if there's anything additional we should factor in.\n\n` +
    `Best regards`
  );
}

// ---------- main inbox endpoint ----------
app.get("/api/emails", requireAuth, async (req, res) => {
  try {
    const gmail = gmailClient(req);
    const db = loadDb();
    const userDb = db[req.session.email] || {};

    const list = await gmail.users.threads.list({
      userId: "me",
      q: "in:inbox newer_than:21d",
      maxResults: 40
    });

    const threads = list.data.threads || [];
    const results = [];

    for (const t of threads) {
      const full = await gmail.users.threads.get({
        userId: "me",
        id: t.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"]
      });
      const msg = full.data.messages[0];
      const headers = {};
      (msg.payload.headers || []).forEach(h => (headers[h.name] = h.value));
      const isUnread = (msg.labelIds || []).includes("UNREAD");
      const hasSentReply = full.data.messages.length > 1 &&
        full.data.messages.some(m => (m.labelIds || []).includes("SENT"));

      if (hasSentReply && full.data.messages.length <= 2) continue;

      results.push({
        id: t.id,
        from: headers.From || "Unknown",
        subject: headers.Subject || "(no subject)",
        date: headers.Date,
        snippet: msg.snippet,
        status: isUnread ? "unopened" : "opened_no_reply",
        category: categorize((headers.Subject || "") + " " + (msg.snippet || "")),
        state: userDb[t.id] || null
      });
    }

    res.json({ emails: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.get("/api/emails/:id", requireAuth, async (req, res) => {
  try {
    const gmail = gmailClient(req);
    const full = await gmail.users.threads.get({
      userId: "me",
      id: req.params.id,
      format: "full"
    });
    const msg = full.data.messages[0];
    const headers = {};
    (msg.payload.headers || []).forEach(h => (headers[h.name] = h.value));

    function extractBody(payload) {
      if (payload.body && payload.body.data) {
        return Buffer.from(payload.body.data, "base64").toString("utf8");
      }
      if (payload.parts) {
        const plain = payload.parts.find(p => p.mimeType === "text/plain");
        if (plain && plain.body && plain.body.data) {
          return Buffer.from(plain.body.data, "base64").toString("utf8");
        }
      }
      return msg.snippet || "";
    }

    const body = extractBody(msg.payload);
    res.json({
      id: req.params.id,
      from: headers.From,
      subject: headers.Subject,
      date: headers.Date,
      body,
      suggestedReply: suggestReply(headers.Subject || "", body)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/emails/:id/state", requireAuth, (req, res) => {
  const { state } = req.body;
  const db = loadDb();
  db[req.session.email] = db[req.session.email] || {};
  if (state) {
    db[req.session.email][req.params.id] = state;
  } else {
    delete db[req.session.email][req.params.id];
  }
  saveDb(db);
  res.json({ ok: true });
});

app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ key: VAPID_KEYS.publicKey });
});

app.post("/api/push/subscribe", requireAuth, (req, res) => {
  const db = loadDb();
  db[req.session.email] = db[req.session.email] || {};
  db[req.session.email].pushSubscription = req.body.subscription;
  db[req.session.email].lastNotifiedOverdueCount = 0;
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", requireAuth, (req, res) => {
  const db = loadDb();
  if (db[req.session.email]) delete db[req.session.email].pushSubscription;
  saveDb(db);
  res.json({ ok: true });
});

async function checkAllUsersAndNotify() {
  const db = loadDb();
  for (const email of Object.keys(db)) {
    const user = db[email];
    if (!user.tokens || !user.pushSubscription) continue;

    try {
      const client = oauthClient();
      client.setCredentials(user.tokens);
      const gmail = google.gmail({ version: "v1", auth: client });

      const list = await gmail.users.threads.list({
        userId: "me",
        q: "in:inbox newer_than:21d",
        maxResults: 40
      });
      const threads = list.data.threads || [];
      let overdueCount = 0;
      const sevenDaysMs = 1000 * 60 * 60 * 24 * 3;

      for (const t of threads) {
        if (user[t.id] === "done" || user[t.id] === "fake") continue;
        const full = await gmail.users.threads.get({
          userId: "me", id: t.id, format: "metadata", metadataHeaders: ["Date"]
        });
        if (full.data.messages.length > 2) continue;
        const dateHeader = (full.data.messages[0].payload.headers || []).find(h => h.name === "Date");
        if (!dateHeader) continue;
        const age = Date.now() - new Date(dateHeader.value).getTime();
        if (age > sevenDaysMs) overdueCount++;
      }

      if (overdueCount > 0 && overdueCount !== user.lastNotifiedOverdueCount) {
        await webpush.sendNotification(
          user.pushSubscription,
          JSON.stringify({
            title: "Inbox Manifest",
            body: `${overdueCount} ${overdueCount === 1 ? "reply is" : "replies are"} overdue`
          })
        );
        user.lastNotifiedOverdueCount = overdueCount;
        saveDb(db);
      } else if (overdueCount === 0) {
        user.lastNotifiedOverdueCount = 0;
        saveDb(db);
      }
    } catch (err) {
      console.error(`Background check failed for ${email}:`, err.message);
    }
  }
}

setInterval(checkAllUsersAndNotify, 30 * 60 * 1000);

app.get("/api/cron/keepalive", async (req, res) => {
  checkAllUsersAndNotify().catch(err => console.error(err));
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Inbox Manifest running at http://localhost:${PORT}`);
});
