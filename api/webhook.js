// api/webhook.js — WhatsApp Business API webhook

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const WA_API = 'https://graph.facebook.com/v18.0';

const PERSONAS = {
  niviko: `Sos Lucía, asesora comercial de NIVIKO, importadora y distribuidora de muebles, sillas, artículos del hogar y electrónica en Argentina. MercadoLíder con 8+ años de experiencia.
PERSONALIDAD: Directa, simpática, sin vueltas. Nunca "estimado cliente". Máximo 3 oraciones por mensaje. Sin asteriscos ni markdown.
REGLAS: Si no sabés algo: "te consulto y confirmo". Después de 3 intercambios con interés: escalás al equipo. Si piden precio: ofrecés lista mayorista. Cierre amable si no hay interés.`,
  broker: `Sos Martín, asesor de materiales de construcción y terminaciones premium para desarrollos inmobiliarios.
PERSONALIDAD: Profesional pero cercano. Sabés de obra y planos. Máximo 3 oraciones. Sin asteriscos ni markdown.
REGLAS: No des precios por WhatsApp: ofrecés visita técnica. Si es desarrolladora grande: escalás al equipo senior. Siempre cerrás con próximo paso concreto.`
};

const conversations = new Map();

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      console.log('✅ Webhook verificado');
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Token inválido' });
  }

  if (req.method === 'POST') {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.status(200).json({ status: 'ok' });

    try {
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const phoneNumberId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
      if (!message || message.type !== 'text') return res.status(200).json({ status: 'ok' });

      const from = message.from;
      const userText = message.text.body;
      if (!conversations.has(from)) conversations.set(from, []);
      const history = conversations.get(from);
      history.push({ role: 'user', content: userText });

      const company = phoneNumberId === process.env.WA_PHONE_ID_BROKER ? 'broker' : 'niviko';
      const sysPrompt = PERSONAS[company];
      const claudeKey = process.env.CLAUDE_API_KEY;
      if (!claudeKey) return res.status(200).json({ status: 'no_claude_key' });

      const delay = 800 + Math.random() * 1200;
      await new Promise(r => setTimeout(r, delay));

      const claudeRes = await fetch(CLAUDE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, system: sysPrompt, messages: history.slice(-10) })
      });
      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error(claudeData.error.message);

      const botReply = claudeData.content[0].text;
      history.push({ role: 'assistant', content: botReply });

      await sendWAMessage(phoneNumberId, from, botReply);

      const shouldEscalate = history.length >= 6 || ['equipo','vendedor','precio','visita','reunión'].some(t => botReply.toLowerCase().includes(t));
      if (shouldEscalate && process.env.VENDEDOR_WA_PHONE) {
        const lastMsgs = history.slice(-4).map(m => (m.role === 'user' ? 'Cliente: ' : 'Bot: ') + m.content).join('\n');
        await sendWAMessage(phoneNumberId, process.env.VENDEDOR_WA_PHONE, `⚡ ESCALADO\nCliente: +${from}\n\n${lastMsgs}`);
      }

      if (history.length > 20) conversations.set(from, history.slice(-10));
      return res.status(200).json({ status: 'ok' });
    } catch (e) {
      console.error('Error:', e);
      return res.status(500).json({ error: e.message });
    }
  }
  return res.status(405).json({ error: 'Método no permitido' });
}

async function sendWAMessage(phoneNumberId, to, text) {
  const r = await fetch(`${WA_API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: false } })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}
