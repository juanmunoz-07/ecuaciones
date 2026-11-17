// Función de Vercel equivalente a chat.php (usa Groq).
// La clave se guarda en Vercel: Settings → Environment Variables → GROQ_API_KEY
const fs = require('fs');
const path = require('path');

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

function readPrompt() {
  const candidates = [
    path.join(process.cwd(), 'prompt.txt'),
    path.join(__dirname, '..', 'prompt.txt'),
    path.join(__dirname, 'prompt.txt')
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch (e) { /* probar la siguiente ruta */ }
  }
  return '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  const send = (code, obj) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(obj));
  };

  if (req.method !== 'POST') return send(405, { error: 'Usa POST' });

  const apiKey = process.env.GROQ_API_KEY || '';
  if (!apiKey || apiKey.startsWith('PEGA_AQUI')) {
    return send(500, { error: 'Falta configurar GROQ_API_KEY en Vercel (Settings → Environment Variables).' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const list = body && Array.isArray(body.messages) ? body.messages : [];

  const messages = list.slice(-10)
    .filter(m => m && typeof m === 'object')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? '').slice(0, 6000)
    }))
    .filter(m => m.content.trim() !== '');

  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return send(400, { error: 'Mensaje vacío.' });

  const systemPrompt = readPrompt();
  if (!systemPrompt) return send(500, { error: 'No se encontró prompt.txt o está vacío.' });

  const payload = {
    model: MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_completion_tokens: 3000
  };

  let response = null;
  let netError = '';

  for (let i = 1; i <= 3; i++) {
    try {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(50000)
      });
      netError = '';
    } catch (e) {
      response = null;
      netError = e && e.message ? e.message : 'sin conexión';
    }

    const retry = !response || [429, 500, 502, 503, 504].includes(response.status);
    if (!retry || i === 3) break;
    await sleep(1000 * i);
  }

  if (!response) return send(502, { error: 'No se pudo conectar con Groq: ' + netError });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return send(response.status, { error: (data.error && data.error.message) || 'Error de la API de Groq' });
  }

  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';

  if (typeof text !== 'string' || !text.trim()) {
    return send(502, { error: 'Groq no devolvió una respuesta de texto.' });
  }

  return send(200, { text });
};
