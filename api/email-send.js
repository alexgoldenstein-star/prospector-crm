// api/email-send.js — Envío via SendGrid

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { to, subject, body, from_email, sg_key } = req.body;
  const apiKey = sg_key || process.env.SENDGRID_API_KEY;
  const fromEmail = from_email || process.env.FROM_EMAIL || 'ventas@niviko.com';

  if (!apiKey) return res.status(400).json({ error: 'SendGrid API key no configurada' });
  if (!to || !subject || !body) return res.status(400).json({ error: 'Faltan campos' });

  const recipients = Array.isArray(to) ? to : [to];
  const results = { sent: [], failed: [] };

  for (const recipient of recipients) {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipient.email || recipient, name: recipient.name || '' }] }],
          from: { email: fromEmail, name: 'NIVIKO Argentina' },
          subject,
          content: [{ type: 'text/html', value: body }]
        })
      });
      if (r.status === 202) results.sent.push(recipient.email || recipient);
      else { const e = await r.json(); results.failed.push({ email: recipient.email || recipient, error: e.errors?.[0]?.message }); }
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      results.failed.push({ email: recipient.email || recipient, error: e.message });
    }
  }
  return res.status(200).json({ success: results.sent.length, failed: results.failed.length, results });
}
