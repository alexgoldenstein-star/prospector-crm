// api/webhook.js — Versión estable con Firebase para historial compartido

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const WA_API = 'https://graph.facebook.com/v18.0';

const PERSONA_DEFAULT = `Sos Lucía, asesora comercial de NIVIKO Argentina. Somos importadores y distribuidores mayoristas de muebles, sillas de oficina, artículos del hogar y electrónica. Trabajamos con comercios y revendedores de todo el país.

CÓMO HABLÁS:
Directa y cálida. Como una persona real, no un robot. Nunca usás asteriscos, negritas, viñetas ni emojis en exceso. Máximo 1 emoji por mensaje si corresponde. Oraciones cortas.

REGLAS ESTRICTAS:
1. UN SOLO MENSAJE por respuesta. Nunca dos mensajes seguidos.
2. Máximo 2 oraciones por mensaje.
3. Solo atendés mayorista. Si es para uso personal decís: "Trabajamos solo con comercios y revendedores, pero te recomiendo buscar en MercadoLibre donde también tenemos tienda."
4. Nunca des precios concretos. Si insisten: "Los precios te los paso por lista mayorista, necesito saber el rubro de tu negocio."
5. Si preguntan por catálogo: "Con gusto te lo mando. ¿De qué rubro es tu negocio?"
6. Después de 3 mensajes sin avanzar: escalás.
7. Si da nombre, teléfono o dice quiero comprar/pedir: escalás inmediatamente.
8. Para escalar: "Perfecto, te paso con uno de nuestros asesores ahora. ¿Me decís tu nombre y el nombre del negocio?"

OBJETIVO: Calificar (qué vende, dónde está, qué necesita) y pasar al vendedor con ese contexto.`;

const processed = new Set();
const lastSent = new Map();
const memHistory = new Map();

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      console.log('✅ Webhook verificado');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Token inválido');
  }

  res.status(200).json({ status: 'ok' });
  if (req.method !== 'POST') return;

  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    const meta = value?.metadata;
    if (!msg || !meta) return;

    const msgId = msg.id;
    const from = msg.from;
    const phoneNumberId = meta.phone_number_id;

    // Deduplicar
    if (processed.has(msgId)) { console.log('⏭ Dup:', msgId); return; }
    processed.add(msgId);
    setTimeout(() => processed.delete(msgId), 300000);

    // Rate limit 5s
    const now = Date.now();
    if (now - (lastSent.get(from) || 0) < 5000) { console.log('⏱ Rate:', from); return; }

    if (msg.type !== 'text') {
      lastSent.set(from, Date.now());
      await sendMsg(phoneNumberId, from, 'Solo proceso texto por ahora. ¿En qué te ayudo?');
      return;
    }

    const userText = msg.text.body;
    console.log(`📨 De +${from}: ${userText}`);

    const claudeKey = process.env.CLAUDE_API_KEY;
    if (!claudeKey) { console.error('❌ Sin CLAUDE_API_KEY'); return; }

    // Obtener historial (Firebase primero, memoria como fallback)
    let history = await fbGet(`conversations/${from}/messages`) || memHistory.get(from) || [];
    history.push({ role: 'user', content: userText, ts: Date.now() });
    if (history.length > 20) history = history.slice(-20);

    // Obtener prompt personalizado
    const company = phoneNumberId === process.env.WA_PHONE_ID_BROKER ? 'broker' : 'niviko';
    const customPrompt = await fbGet(`personas/${company}/prompt`);
    const sysPrompt = customPrompt || PERSONA_DEFAULT;

    // Delay humano
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

    // Claude
    const claudeRes = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        system: sysPrompt,
        messages: history.slice(-10).map(m => ({ role: m.role, content: m.content }))
      })
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) { console.error('❌ Claude:', claudeData.error); return; }

    const reply = claudeData.content?.[0]?.text?.trim();
    if (!reply) { console.error('❌ Sin reply'); return; }

    // Guardar historial con metadata completa
    history.push({ role: 'assistant', content: reply, ts: Date.now() });
    memHistory.set(from, history);

    // Guardar en Firebase (historial + metadata del chat)
    await fbSet(`conversations/${from}`, {
      phone: from,
      lastMessage: userText,
      lastReply: reply,
      lastTs: Date.now(),
      company,
      messages: history,
      status: 'active'
    });

    // Enviar
    lastSent.set(from, Date.now());
    await sendMsg(phoneNumberId, from, reply);
    console.log(`✅ → +${from}: ${reply.slice(0, 60)}`);

    // Escalado
    if (['asesor', 'equipo', 'te paso', 'tu nombre'].some(t => reply.toLowerCase().includes(t))) {
      await fbSet(`conversations/${from}/status`, 'escalated');
      const vendedor = process.env.VENDEDOR_WA_PHONE;
      if (vendedor) {
        const ctx = history.slice(-4).map(m => (m.role === 'user' ? '👤 ' : '🤖 ') + m.content).join('\n');
        setTimeout(async () => {
          try { await sendMsg(phoneNumberId, vendedor, `⚡ ESCALADO\n+${from}\n\n${ctx}`); }
          catch(e) { console.error('Error notif:', e.message); }
        }, 2000);
      }
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

async function sendMsg(phoneNumberId, to, text) {
  const r = await fetch(`${WA_API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'text', text: { body: text, preview_url: false }
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

// Firebase REST API helpers
function getFBConfig() {
  try {
    const cfg = process.env.FIREBASE_CONFIG;
    if (!cfg) return null;
    return JSON.parse(cfg);
  } catch(e) { return null; }
}

async function fbGet(path) {
  const cfg = getFBConfig();
  if (!cfg) return null;
  try {
    const r = await fetch(`https://${cfg.projectId}-default-rtdb.firebaseio.com/${path}.json`);
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

async function fbSet(path, data) {
  const cfg = getFBConfig();
  if (!cfg) return null;
  try {
    await fetch(`https://${cfg.projectId}-default-rtdb.firebaseio.com/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch(e) { console.error('FB write error:', e.message); }
}
