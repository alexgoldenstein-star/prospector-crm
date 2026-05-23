// api/webhook.js — WhatsApp Business API webhook
// Con deduplicación de mensajes, rate limiting y Firebase para historial

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const WA_API = 'https://graph.facebook.com/v18.0';

const PERSONAS = {
  niviko: `Sos Lucía, asesora comercial de NIVIKO Argentina. Somos importadores y distribuidores mayoristas con más de 40 años en el mercado. Trabajamos con comercios, mueblerías, bazares, supermercados y revendedores de todo el país. Catálogo: muebles, sillas de oficina, artículos del hogar, electrónica y accesorios.

PERSONALIDAD: Directa, cálida y profesional. Hablás como una persona real. MÁXIMO 1 MENSAJE POR RESPUESTA. Sin asteriscos ni markdown.

REGLAS ESTRICTAS:
- Solo mayorista. Si consulta para uso personal: explicá y cerrá amablemente.
- Nunca des precios. Ofrecé pasar lista mayorista o derivar al vendedor.
- Stock: "Tenemos stock en principales y algunos bajo pedido. ¿Qué necesitás?"
- Envíos: "Enviamos a todo el país, el flete se cotiza por destino y volumen."
- Pago: "Transferencia, efectivo, cheques y financiado según cliente y operación."
- Máximo 3 intercambios sin avanzar → escalás al vendedor.
- Si da nombre/teléfono o dice quiero comprar → escalás inmediatamente.
- Para escalar: "Perfecto, te paso con un asesor ahora. ¿Tu nombre y el negocio?"
- CRÍTICO: Enviás UN SOLO MENSAJE por respuesta. Nunca mandes 2 o más.

OBJETIVO: Calificar al cliente y pasarlo al vendedor con contexto.`,
  broker: `Sos Martín, asesor de materiales de construcción y terminaciones premium para desarrollos inmobiliarios. Porcelanato, microcemento, madera, piedra.

PERSONALIDAD: Profesional pero cercano. Sabés de obra. MÁXIMO 1 MENSAJE POR RESPUESTA. Sin asteriscos ni markdown.

REGLAS:
- No des precios: ofrecé visita técnica o cotización formal.
- Desarrolladora grande → escalás al equipo senior inmediatamente.
- Siempre cerrás con próximo paso concreto.
- CRÍTICO: UN SOLO MENSAJE por respuesta.`
};

// Deduplicación: evita procesar el mismo mensaje dos veces
const processedMessages = new Set();
// Rate limiting por número: evita responder múltiples veces seguidas
const lastResponseTime = new Map();
const RATE_LIMIT_MS = 3000; // 3 segundos entre respuestas por número

module.exports = async function handler(req, res) {
  // ── GET: Verificación webhook ──
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Token inválido' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Responder a Meta inmediatamente para evitar reintentos
  res.status(200).json({ status: 'ok' });

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    const message = messages[0];
    const messageId = message.id;
    const from = message.from;
    const phoneNumberId = value.metadata?.phone_number_id;

    // ── Deduplicación: ignorar mensajes ya procesados ──
    if (processedMessages.has(messageId)) {
      console.log(`⏭ Mensaje duplicado ignorado: ${messageId}`);
      return;
    }
    processedMessages.add(messageId);
    // Limpiar después de 5 minutos
    setTimeout(() => processedMessages.delete(messageId), 300000);

    // ── Rate limiting: no responder si ya respondimos hace menos de 3s ──
    const now = Date.now();
    const lastTime = lastResponseTime.get(from) || 0;
    if (now - lastTime < RATE_LIMIT_MS) {
      console.log(`⏱ Rate limit para ${from}, ignorando`);
      return;
    }
    lastResponseTime.set(from, now);

    // Solo texto por ahora
    if (message.type !== 'text') {
      await sendWAMessage(phoneNumberId, from, '¡Hola! Por el momento solo proceso mensajes de texto. ¿En qué te puedo ayudar?');
      return;
    }

    const userText = message.text.body;
    console.log(`📨 Mensaje de ${from}: ${userText}`);

    // ── Historial desde Firebase o memoria ──
    let history = await getHistory(from);
    history.push({ role: 'user', content: userText });

    // ── Detectar empresa ──
    const company = phoneNumberId === process.env.WA_PHONE_ID_BROKER ? 'broker' : 'niviko';
    
    // ── Obtener prompt personalizado si existe ──
    let sysPrompt = await getCustomPrompt(company) || PERSONAS[company];

    // ── Claude API ──
    const claudeKey = process.env.CLAUDE_API_KEY;
    if (!claudeKey) {
      console.error('❌ CLAUDE_API_KEY no configurada');
      return;
    }

    // Delay humano
    const delay = 1000 + Math.random() * 1500;
    await new Promise(r => setTimeout(r, delay));

    const claudeRes = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 150, // Corto para forzar respuestas concisas
        system: sysPrompt,
        messages: history.slice(-8) // Últimos 8 mensajes
      })
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    const botReply = claudeData.content[0].text.trim();
    history.push({ role: 'assistant', content: botReply });

    // ── Guardar historial ──
    await saveHistory(from, history);

    // ── Enviar UNA sola respuesta ──
    await sendWAMessage(phoneNumberId, from, botReply);
    console.log(`✅ Respuesta enviada a ${from}: ${botReply.slice(0, 50)}...`);

    // ── Detectar escalado ──
    const escalateTriggers = ['equipo','asesor','vendedor','te paso','nombre y','nombre del'];
    const shouldEscalate = escalateTriggers.some(t => botReply.toLowerCase().includes(t));
    if (shouldEscalate && process.env.VENDEDOR_WA_PHONE) {
      const lastMsgs = history.slice(-4).map(m =>
        (m.role === 'user' ? '👤 ' : '🤖 ') + m.content
      ).join('\n');
      const notif = `⚡ ESCALADO NIVIKO\n\nCliente: +${from}\n\n${lastMsgs}\n\n→ Retomá vos la conversación`;
      // Pequeño delay para no solapar mensajes
      setTimeout(() => {
        sendWAMessage(phoneNumberId, process.env.VENDEDOR_WA_PHONE, notif).catch(console.error);
      }, 2000);
    }

  } catch (error) {
    console.error('❌ Error webhook:', error.message);
  }
}

// ── Enviar mensaje WA ──
async function sendWAMessage(phoneNumberId, to, text) {
  const r = await fetch(`${WA_API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
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
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

// ── Historial en Firebase (si está configurado) o en memoria ──
const memoryHistory = new Map();

async function getHistory(phone) {
  try {
    const fbConfig = process.env.FIREBASE_CONFIG;
    if (!fbConfig) return memoryHistory.get(phone) || [];
    // Firebase REST API para leer historial
    const config = JSON.parse(fbConfig);
    const url = `https://${config.projectId}-default-rtdb.firebaseio.com/conversations/${phone.replace('+','')}.json`;
    const r = await fetch(url + `?auth=${process.env.FIREBASE_SECRET}`);
    if (!r.ok) return memoryHistory.get(phone) || [];
    const data = await r.json();
    return data?.history || [];
  } catch(e) {
    return memoryHistory.get(phone) || [];
  }
}

async function saveHistory(phone, history) {
  try {
    // Mantener últimos 20 mensajes
    const trimmed = history.slice(-20);
    memoryHistory.set(phone, trimmed);
    const fbConfig = process.env.FIREBASE_CONFIG;
    if (!fbConfig) return;
    const config = JSON.parse(fbConfig);
    const url = `https://${config.projectId}-default-rtdb.firebaseio.com/conversations/${phone.replace('+','')}.json`;
    await fetch(url + `?auth=${process.env.FIREBASE_SECRET}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: trimmed, updatedAt: Date.now() })
    });
  } catch(e) {
    console.error('Error saving history:', e.message);
  }
}

async function getCustomPrompt(company) {
  try {
    const fbConfig = process.env.FIREBASE_CONFIG;
    if (!fbConfig) return null;
    const config = JSON.parse(fbConfig);
    const url = `https://${config.projectId}-default-rtdb.firebaseio.com/personas/${company}.json`;
    const r = await fetch(url + `?auth=${process.env.FIREBASE_SECRET}`);
    if (!r.ok) return null;
    const data = await r.json();
    return data?.prompt || null;
  } catch(e) {
    return null;
  }
}
