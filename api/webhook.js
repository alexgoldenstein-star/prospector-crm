// api/webhook.js — Versión estable con diagnóstico

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const WA_API = 'https://graph.facebook.com/v18.0';

const PERSONA_NIVIKO = `Sos Lucía, asesora comercial de NIVIKO Argentina. Importadores y distribuidores mayoristas con más de 40 años. Catálogo: muebles, sillas, hogar, electrónica.

REGLAS — leelas y seguílas al pie de la letra:
- Respondés UNA SOLA VEZ por mensaje. UN ÚNICO MENSAJE de respuesta.
- Máximo 2 oraciones por mensaje.
- Solo mayorista. Si es para uso personal: explicá y cerrá amablemente.
- Nunca des precios. Ofrecé pasar lista o derivar al vendedor.
- Después de 3 intercambios sin avanzar: escalás al vendedor.
- Si da nombre/teléfono o quiere comprar: escalás inmediatamente.
- Para escalar decís: "Perfecto, te paso con un asesor. ¿Tu nombre y el negocio?"
- Sin asteriscos, sin markdown, sin mayúsculas innecesarias.`;

// Deduplicación simple en memoria
const processed = new Set();
const lastSent = new Map();

module.exports = async function handler(req, res) {
  // ── Verificación webhook (GET) ──
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      console.log('✅ Webhook verificado OK');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Token inválido');
  }

  // ── Responder 200 a Meta inmediatamente ──
  res.status(200).json({ status: 'ok' });

  if (req.method !== 'POST') return;

  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;

    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const meta = body?.entry?.[0]?.changes?.[0]?.value?.metadata;
    if (!msg || !meta) return;

    const msgId = msg.id;
    const from = msg.from;
    const phoneNumberId = meta.phone_number_id;

    // Deduplicar
    if (processed.has(msgId)) { console.log('⏭ Duplicado:', msgId); return; }
    processed.add(msgId);
    setTimeout(() => processed.delete(msgId), 300000);

    // Rate limit: 5 segundos entre respuestas por número
    const now = Date.now();
    if (now - (lastSent.get(from) || 0) < 5000) { console.log('⏱ Rate limit:', from); return; }

    if (msg.type !== 'text') {
      lastSent.set(from, Date.now());
      await sendMsg(phoneNumberId, from, '¡Hola! Solo proceso texto por ahora. ¿En qué te ayudo?');
      return;
    }

    const userText = msg.text.body;
    console.log(`📨 De ${from}: ${userText}`);

    const claudeKey = process.env.CLAUDE_API_KEY;
    if (!claudeKey) { console.error('❌ Sin CLAUDE_API_KEY'); return; }

    // Historial simple en memoria (últimos 10 mensajes)
    const histKey = `hist_${from}`;
    const history = global[histKey] || [];
    history.push({ role: 'user', content: userText });
    if (history.length > 10) history.splice(0, history.length - 10);

    // Delay humano
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

    // Llamar a Claude
    const claudeRes = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 120,
        system: PERSONA_NIVIKO,
        messages: history
      })
    });

    const claudeData = await claudeRes.json();
    console.log('Claude status:', claudeRes.status);

    if (claudeData.error) {
      console.error('❌ Claude error:', JSON.stringify(claudeData.error));
      return;
    }

    const reply = claudeData.content?.[0]?.text?.trim();
    if (!reply) { console.error('❌ Sin reply de Claude'); return; }

    // Guardar historial
    history.push({ role: 'assistant', content: reply });
    global[histKey] = history;

    // Marcar tiempo de envío ANTES de enviar (previene duplicados)
    lastSent.set(from, Date.now());

    // Enviar respuesta
    await sendMsg(phoneNumberId, from, reply);
    console.log(`✅ Respondido a ${from}: ${reply.slice(0, 60)}`);

    // Detectar escalado
    if (['asesor','equipo','te paso','tu nombre'].some(t => reply.toLowerCase().includes(t))) {
      const vendedor = process.env.VENDEDOR_WA_PHONE;
      if (vendedor) {
        const ctx = history.slice(-4).map(m => (m.role==='user'?'👤 ':'🤖 ') + m.content).join('\n');
        setTimeout(async () => {
          try { await sendMsg(phoneNumberId, vendedor, `⚡ ESCALADO\n+${from}\n\n${ctx}`); }
          catch(e) { console.error('Error notif vendedor:', e.message); }
        }, 2000);
      }
    }

  } catch (err) {
    console.error('❌ Error handler:', err.message, err.stack?.slice(0,200));
  }
}

async function sendMsg(phoneNumberId, to, text) {
  const waToken = process.env.WA_ACCESS_TOKEN;
  if (!waToken) throw new Error('Sin WA_ACCESS_TOKEN');

  const r = await fetch(`${WA_API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${waToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false }
    })
  });

  const data = await r.json();
  if (data.error) {
    console.error('❌ WA API error:', JSON.stringify(data.error));
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data;
}
