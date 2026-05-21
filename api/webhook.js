// api/webhook.js
// Vercel Serverless Function — WhatsApp Business API webhook
// Recibe mensajes entrantes y responde con Claude IA

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const WA_API = 'https://graph.facebook.com/v18.0';

// Personalidades del bot por empresa
const PERSONAS = {
  niviko: `Sos Lucía, asesora comercial de NIVIKO, importadora y distribuidora líder de muebles, sillas de oficina, artículos del hogar y electrónica en Argentina. Somos MercadoLíder con más de 150 SKUs y 8 años en el mercado.

PERSONALIDAD: Directa, simpática, sin vueltas. Nunca decís "estimado cliente". Hablás como una persona real. Usás el nombre del negocio cuando lo sabés.

REGLAS ESTRICTAS:
- Nunca más de 3 oraciones por mensaje
- Si no sabés algo: "te consulto y te confirmo en un momento"
- Después de 3 intercambios con interés real: escalás al equipo
- Si preguntan precio: ofrecés lista de precios mayorista
- Si es frío o sin interés: cerrás amablemente, dejás la puerta abierta
- Nunca repetís el mismo texto dos veces
- Máximo 1 emoji por mensaje, solo si viene al caso
- No uses asteriscos ni formato markdown`,

  broker: `Sos Martín, asesor senior de materiales de construcción y terminaciones para desarrollos inmobiliarios. Representamos porcelanato, microcemento, madera, piedra y materiales premium.

PERSONALIDAD: Profesional pero cercano. Sabés de obra y de planos. Hablás con desarrolladores y arquitectos de igual a igual.

REGLAS ESTRICTAS:
- Nunca más de 3 oraciones por mensaje
- No des precios por WhatsApp: ofrecés visita técnica o cotización formal
- Si es una desarrolladora grande: escalás al equipo senior inmediatamente
- Siempre cerrás ofreciendo el próximo paso concreto
- No uses asteriscos ni formato markdown`
};

// Memoria de conversaciones en memoria (en producción usar Redis o Firestore)
const conversations = new Map();

export default async function handler(req, res) {
  // ─── GET: Verificación del webhook por Meta ───
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const verifyToken = process.env.WA_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('✅ Webhook verificado por Meta');
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Token inválido' });
  }

  // ─── POST: Mensaje entrante ───
  if (req.method === 'POST') {
    const body = req.body;

    // Verificar que es un mensaje real de WhatsApp
    if (body.object !== 'whatsapp_business_account') {
      return res.status(200).json({ status: 'not_whatsapp' });
    }

    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (!messages || messages.length === 0) {
        return res.status(200).json({ status: 'no_messages' });
      }

      const message = messages[0];
      const from = message.from; // número del cliente
      const msgType = message.type;
      const phoneNumberId = value.metadata?.phone_number_id;

      // Solo procesamos mensajes de texto por ahora
      if (msgType !== 'text') {
        await sendWAMessage(phoneNumberId, from, '¡Hola! Por el momento solo proceso mensajes de texto. ¿En qué te puedo ayudar? 😊');
        return res.status(200).json({ status: 'non_text_handled' });
      }

      const userText = message.text.body;
      console.log(`📨 Mensaje de ${from}: ${userText}`);

      // Recuperar historial de conversación
      if (!conversations.has(from)) {
        conversations.set(from, []);
      }
      const history = conversations.get(from);
      history.push({ role: 'user', content: userText });

      // Detectar empresa según número de teléfono configurado
      const company = detectCompany(phoneNumberId);
      const persona = PERSONAS[company] || PERSONAS.niviko;

      // Generar respuesta con Claude
      const claudeKey = process.env.CLAUDE_API_KEY;
      if (!claudeKey) {
        console.error('❌ CLAUDE_API_KEY no configurada');
        return res.status(200).json({ status: 'no_claude_key' });
      }

      const response = await fetch(CLAUDE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          system: persona,
          messages: history.slice(-10) // Últimos 10 mensajes para contexto
        })
      });

      const claudeData = await response.json();
      if (claudeData.error) throw new Error(claudeData.error.message);

      const botReply = claudeData.content[0].text;
      history.push({ role: 'assistant', content: botReply });

      // Simular delay humano (800ms - 2s)
      const delay = 800 + Math.random() * 1200;
      await new Promise(r => setTimeout(r, delay));

      // Enviar respuesta por WhatsApp
      await sendWAMessage(phoneNumberId, from, botReply);

      // Detectar si debe escalar a humano
      const shouldEscalate = detectEscalation(botReply, history);
      if (shouldEscalate) {
        await notifyVendedor(from, history, company);
        console.log(`⚡ Escalando conversación de ${from} al vendedor`);
      }

      // Limpiar historial si es muy largo (>20 mensajes)
      if (history.length > 20) {
        const summary = `[Conversación iniciada. Contexto: ${history.slice(0, 3).map(m => m.content).join(' | ')}]`;
        conversations.set(from, [{ role: 'user', content: summary }, ...history.slice(-10)]);
      }

      return res.status(200).json({ status: 'ok', escalated: shouldEscalate });

    } catch (error) {
      console.error('❌ Error procesando mensaje:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ─── Enviar mensaje por WhatsApp Business API ───
async function sendWAMessage(phoneNumberId, to, text) {
  const waToken = process.env.WA_ACCESS_TOKEN;
  const url = `${WA_API}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
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

  const data = await response.json();
  if (data.error) {
    console.error('❌ Error WA:', data.error);
    throw new Error(data.error.message);
  }
  console.log(`✅ Mensaje enviado a ${to}`);
  return data;
}

// ─── Detectar si hay que escalar a humano ───
function detectEscalation(botReply, history) {
  const escalationTriggers = [
    'equipo', 'vendedor', 'colega', 'contacto directo',
    'te paso', 'te comunico', 'precio', 'lista de precios',
    'visita', 'cotización formal', 'reunión'
  ];
  const replyLower = botReply.toLowerCase();
  const triggered = escalationTriggers.some(t => replyLower.includes(t));
  const longConv = history.length >= 6;
  return triggered || longConv;
}

// ─── Detectar empresa según Phone Number ID ───
function detectCompany(phoneNumberId) {
  const nivikoId = process.env.WA_PHONE_ID_NIVIKO;
  const brokerId = process.env.WA_PHONE_ID_BROKER;
  if (phoneNumberId === brokerId) return 'broker';
  return 'niviko'; // default
}

// ─── Notificar al vendedor cuando hay que escalar ───
async function notifyVendedor(clientPhone, history, company) {
  const vendedorWA = process.env.VENDEDOR_WA_PHONE;
  const vendedorPhoneId = process.env.WA_PHONE_ID_NIVIKO;
  if (!vendedorWA || !vendedorPhoneId) return;

  const lastMsgs = history.slice(-4).map(m =>
    `${m.role === 'user' ? '👤 Cliente' : '🤖 Bot'}: ${m.content}`
  ).join('\n');

  const notif = `⚡ ESCALADO — ${company.toUpperCase()}\n\nCliente: +${clientPhone}\n\nÚltimos mensajes:\n${lastMsgs}\n\n👆 Retomá la conversación directamente.`;

  try {
    await sendWAMessage(vendedorPhoneId, vendedorWA, notif);
  } catch (e) {
    console.error('Error notificando vendedor:', e);
  }
}
