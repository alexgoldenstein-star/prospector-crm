// api/webhook.js — Versión sincrónica para Vercel Hobby

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const WA_API = 'https://graph.facebook.com/v18.0';

const PERSONA = `Sos Lucía, asesora comercial de NIVIKO Argentina. Importadores y distribuidores mayoristas de muebles, sillas, hogar y electrónica.

REGLAS:
- UN SOLO MENSAJE por respuesta. Máximo 2 oraciones cortas.
- Solo mayorista. Si es uso personal: explicá y cerrá amablemente.
- Nunca des precios. Ofrecé pasar lista mayorista.
- Después de 3 intercambios sin avanzar: escalás al vendedor.
- Si da nombre/teléfono o quiere comprar: escalás inmediatamente.
- Para escalar: "Perfecto, te paso con un asesor. ¿Tu nombre y el negocio?"
- Sin asteriscos, sin markdown, sin emojis excesivos.`;

const processed = new Set();
const lastSent = new Map();
const memHistory = new Map();

module.exports = async function handler(req, res) {
  // Verificación GET
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      console.log('✅ Webhook verificado');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Token inválido');
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') {
      return res.status(200).json({ status: 'ok' });
    }

    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const meta = body?.entry?.[0]?.changes?.[0]?.value?.metadata;
    
    if (!msg || !meta) {
      return res.status(200).json({ status: 'ok' });
    }

    const msgId = msg.id;
    const from = msg.from;
    const phoneNumberId = meta.phone_number_id;

    // Deduplicar
    if (processed.has(msgId)) {
      console.log('⏭ Duplicado:', msgId);
      return res.status(200).json({ status: 'ok' });
    }
    processed.add(msgId);
    setTimeout(() => processed.delete(msgId), 300000);

    // Rate limit 5s
    const now = Date.now();
    if (now - (lastSent.get(from) || 0) < 5000) {
      console.log('⏱ Rate limit:', from);
      return res.status(200).json({ status: 'ok' });
    }

    if (msg.type !== 'text') {
      lastSent.set(from, Date.now());
      await sendMsg(phoneNumberId, from, 'Solo proceso mensajes de texto. ¿En qué te ayudo?');
      return res.status(200).json({ status: 'ok' });
    }

    const userText = msg.text.body;
    console.log(`📨 De +${from}: ${userText}`);

    const claudeKey = process.env.CLAUDE_API_KEY;
    if (!claudeKey) {
      console.error('❌ Sin CLAUDE_API_KEY');
      return res.status(200).json({ status: 'ok' });
    }

    // Historial en memoria
    let history = memHistory.get(from) || [];
    history.push({ role: 'user', content: userText });
    if (history.length > 10) history = history.slice(-10);

    // Llamar a Claude ANTES de responder 200
    console.log('🤖 Llamando a Claude...');
    const claudeRes = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        system: PERSONA,
        messages: history
      })
    });

    const claudeData = await claudeRes.json();
    console.log('Claude status:', claudeRes.status, claudeData.error || 'OK');

    if (claudeData.error) {
      console.error('❌ Claude error:', JSON.stringify(claudeData.error));
      return res.status(200).json({ status: 'ok' });
    }

    const reply = claudeData.content?.[0]?.text?.trim();
    if (!reply) {
      console.error('❌ Sin reply de Claude');
      return res.status(200).json({ status: 'ok' });
    }

    // Guardar historial
    history.push({ role: 'assistant', content: reply });
    memHistory.set(from, history);

    // Enviar respuesta a WhatsApp
    lastSent.set(from, Date.now());
    console.log(`✅ Respondiendo a +${from}: ${reply.slice(0, 60)}`);
    await sendMsg(phoneNumberId, from, reply);

    // Responder 200 a Meta
    res.status(200).json({ status: 'ok' });

    // Escalado (después de responder)
    if (['asesor', 'te paso', 'tu nombre'].some(t => reply.toLowerCase().includes(t))) {
      const vendedor = process.env.VENDEDOR_WA_PHONE;
      if (vendedor) {
        const ctx = history.slice(-4).map(m => (m.role === 'user' ? '👤 ' : '🤖 ') + m.content).join('\n');
        setTimeout(async () => {
          try { await sendMsg(phoneNumberId, vendedor, `⚡ ESCALADO\n+${from}\n\n${ctx}`); }
          catch(e) { console.error('Error notif:', e.message); }
        }, 1000);
      }
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).json({ status: 'ok' });
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
      to: to.replace(/\D/g, ''),
      type: 'text',
      text: { body: text, preview_url: false }
    })
  });

  const data = await r.json();
  if (data.error) {
    console.error('❌ WA error:', JSON.stringify(data.error));
    throw new Error(data.error.message);
  }
  console.log('📤 WA enviado OK');
  return data;
}
