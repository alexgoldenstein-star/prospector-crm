// api/broadcast.js — Envío masivo de mensajes usando plantillas aprobadas de Meta

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contacts, template_name, template_params, phone_id, wa_token, delay_ms } = req.body;

  if (!contacts?.length) return res.status(400).json({ error: 'contacts requerido' });
  if (!template_name) return res.status(400).json({ error: 'template_name requerido' });

  const token = wa_token || process.env.WA_ACCESS_TOKEN;
  const phoneId = phone_id || process.env.WA_PHONE_ID_NIVIKO;
  const delayBetween = delay_ms || 1000; // 1 segundo entre mensajes por defecto

  const results = { sent: [], failed: [], total: contacts.length };

  for (const contact of contacts) {
    const phone = contact.waId || contact.tel || contact.phone;
    if (!phone) { results.failed.push({ contact, error: 'Sin número' }); continue; }

    try {
      // Build template components with variables
      const components = [];
      if (template_params && template_params.length > 0) {
        components.push({
          type: 'body',
          parameters: template_params.map(p => ({
            type: 'text',
            text: p.replace('{{nombre}}', contact.nombre || contact.name || 'estimado cliente')
                   .replace('{{negocio}}', contact.nombre || 'su negocio')
          }))
        });
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone.startsWith('+') ? phone : '+' + phone,
        type: 'template',
        template: {
          name: template_name,
          language: { code: 'es_AR' },
          ...(components.length ? { components } : {})
        }
      };

      const r = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await r.json();
      if (data.error) {
        results.failed.push({ contact: contact.nombre, phone, error: data.error.message });
      } else {
        results.sent.push({ contact: contact.nombre, phone, messageId: data.messages?.[0]?.id });
      }
    } catch(e) {
      results.failed.push({ contact: contact.nombre, phone, error: e.message });
    }

    // Delay between messages to avoid rate limiting
    await new Promise(r => setTimeout(r, delayBetween));
  }

  return res.status(200).json(results);
}
