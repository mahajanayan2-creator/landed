const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const usage = new Map();
const FREE_DAILY_LIMIT = 1;

function getUsage(ip) {
  const now = Date.now();
  const dayMs = 86400000;
  const u = usage.get(ip) || { count: 0, resetAt: now + dayMs };
  if (now > u.resetAt) { u.count = 0; u.resetAt = now + dayMs; }
  return u;
}

app.post('/api/generate', async (req, res) => {
  const { prompt, mode, company, isPro } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.length < 20) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!isPro && mode === 'cover') {
    const ip = req.ip;
    const u = getUsage(ip);
    if (u.count >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        error: 'free_limit',
        message: 'You have used your free cover letter preview. Purchase a pack to continue.',
        upgradeUrl: '/#pricing'
      });
    }
    u.count++;
    usage.set(ip, u);
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const useSearch = mode === 'cover' && company && company.length > 2;

    const requestConfig = {
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: 'You are an elite career writer. Produce genuinely exceptional, human-quality CVs and cover letters that are better than any competitor tool. Prioritise quality, specificity, and impact. Never produce generic filler. Every sentence must earn its place.',
      messages: [{ role: 'user', content: prompt }]
    };

    if (useSearch) {
      requestConfig.tools = [{
        type: 'web_search_20250305',
        name: 'web_search'
      }];
    }

    const message = await client.messages.create(requestConfig);

    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!text) throw new Error('Empty response');

    res.json({ text });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => console.log(`Landed running on http://localhost:${PORT}`));
