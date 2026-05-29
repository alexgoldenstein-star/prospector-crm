// api/validate-phone.js — Valida números y verifica si tienen WhatsApp
// Usa WhatsApp Business API para verificar existencia

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phones, wa_token, phone_id } = req.body;
  if (!phones || !Array.isArray(phones)) return res.status(400).json({ error: 'phones array required' });

  const token = wa_token || process.env.WA_ACCESS_TOKEN;
  const phoneId = phone_id || process.env.WA_PHONE_ID_NIVIKO;

  const results = [];

  for (const rawPhone of phones) {
    const normalized = normalizePhone(rawPhone);
    if (!normalized) {
      results.push({ original: rawPhone, normalized: null, valid: false, hasWhatsApp: false, error: 'Formato inválido' });
      continue;
    }

    // Check if number exists on WhatsApp via Contacts API
    try {
      const r = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/contacts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocking: 'wait', contacts: ['+' + normalized], force_check: true })
      });
      const data = await r.json();
      const contact = data.contacts?.[0];
      const hasWA = contact?.status === 'valid';
      const waId = contact?.wa_id || normalized;

      results.push({ original: rawPhone, normalized, waId, valid: true, hasWhatsApp: hasWA });
    } catch(e) {
      results.push({ original: rawPhone, normalized, valid: true, hasWhatsApp: false, error: e.message });
    }

    // Rate limit: 10 per second
    await new Promise(r => setTimeout(r, 100));
  }

  return res.status(200).json({ results, total: results.length, withWhatsApp: results.filter(r => r.hasWhatsApp).length });
}

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');
  if (!p) return null;

  // Argentina formats
  if (p.startsWith('0')) p = p.slice(1);
  if (p.startsWith('15')) p = p.slice(2);

  // Add country code if missing
  if (p.length === 10) p = '54' + p; // Argentina mobile
  if (p.length === 8 || p.length === 7) return null; // Too short

  // Fix Argentina mobile: 549 + area + number
  if (p.startsWith('54') && p.length === 12) {
    // Already correct: 54 + 9 + area(2-4) + number
  } else if (p.startsWith('54') && p.length === 11) {
    // Missing the 9: 54 + area + number → 54 + 9 + area + number
    p = '549' + p.slice(2);
  }

  if (p.length < 10 || p.length > 15) return null;
  return p;
}
