const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup — stores user credits
const db = new Database('landed.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    credits INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    email TEXT,
    pack TEXT,
    credits INTEGER,
    stripe_session_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const PACK_CREDITS = { 'single': 1, '5pack': 5, '10pack': 10 };

// Raw body needed for Stripe webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ─── CHECK CREDITS ────────────────────────────────────────────────────────────
app.post('/api/check-credits', (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ credits: 0 });
  const user = db.prepare('SELECT credits FROM users WHERE email = ?').get(email);
  res.json({ credits: user ? user.credits : 0 });
});

// ─── GENERATE ─────────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { prompt, mode, company, email } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.length < 20) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  // Cover letters require credits
  if (mode === 'cover') {
    if (!email) {
      return res.status(401).json({ error: 'no_email', message: 'Please enter your email to continue.' });
    }
    const user = db.prepare('SELECT credits FROM users WHERE email = ?').get(email);
    const credits = user ? user.credits : 0;
    if (credits <= 0) {
      return res.status(402).json({ error: 'no_credits', message: 'No credits remaining.' });
    }
    // Deduct credit before generating
    db.prepare('UPDATE users SET credits = credits - 1 WHERE email = ?').run(email);
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: 'You are an elite career writer. Produce genuinely exceptional, human-quality CVs and cover letters that are better than any competitor tool. Prioritise quality, specificity, and impact. Never produce generic filler. Every sentence must earn its place.',
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!text) throw new Error('Empty response');

    // Return remaining credits for cover letters
    if (mode === 'cover' && email) {
      const user = db.prepare('SELECT credits FROM users WHERE email = ?').get(email);
      return res.json({ text, creditsRemaining: user ? user.credits : 0 });
    }

    res.json({ text });

  } catch (err) {
    console.error('Generation error:', err.message);
    // Refund credit if generation failed
    if (mode === 'cover' && email) {
      db.prepare('UPDATE users SET credits = credits + 1 WHERE email = ?').run(email);
    }
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Stripe calls this automatically when someone completes a purchase
app.post('/api/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const pack = session.metadata?.pack;

    if (email && pack && PACK_CREDITS[pack]) {
      const credits = PACK_CREDITS[pack];
      const existing = db.prepare('SELECT email FROM users WHERE email = ?').get(email);
      if (existing) {
        db.prepare('UPDATE users SET credits = credits + ? WHERE email = ?').run(credits, email);
      } else {
        db.prepare('INSERT INTO users (email, credits) VALUES (?, ?)').run(email, credits);
      }
      db.prepare('INSERT INTO purchases (id, email, pack, credits, stripe_session_id) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), email, pack, credits, session.id);
      console.log(`Added ${credits} credits for ${email} (${pack})`);
    }
  }

  res.json({ received: true });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => console.log(`Landed running on http://localhost:${PORT}`));
