// api/maps.js — Google Maps Places API con enriquecimiento completo
// Paso 1: Text Search para encontrar negocios
// Paso 2: Place Details para teléfono, web, horarios
// Paso 3: Scraping del sitio web para WA, email, Instagram

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { query, key, pagetoken, lat, lng, radius, enrich, place_id } = req.query;
  const searchRadius = radius || '30000';

  if (!key) return res.status(400).json({ error: 'API key requerida' });

  // ── MODO: Enriquecer un lugar específico (Place Details) ──
  if (enrich === 'true' && place_id) {
    return await enrichPlace(place_id, key, res);
  }

  // ── MODO: Búsqueda principal ──
  if (!query && !pagetoken) return res.status(400).json({ error: 'Query requerida' });

  try {
    let url;
    if (pagetoken) {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${encodeURIComponent(pagetoken)}&key=${key}`;
    } else if (lat && lng) {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${lat},${lng}&radius=${searchRadius}&language=es&region=ar&key=${key}`;
    } else {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=es&region=ar&key=${key}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'REQUEST_DENIED') {
      return res.status(200).json({
        results: [],
        error: 'API key inválida o sin permisos. Verificá Places API en Google Cloud Console.',
        status: data.status,
        error_message: data.error_message
      });
    }

    // Para cada resultado, hacemos Place Details para obtener teléfono y web
    const basicResults = (data.results || []).slice(0, 20); // Limit to 20 to avoid rate limits
    const enriched = [];

    for (const place of basicResults) {
      try {
        const details = await getPlaceDetails(place.place_id, key);
        enriched.push({
          nombre: place.name,
          zona: place.formatted_address || '',
          tel: details.tel || '',
          whatsapp: details.whatsapp || '',
          email: details.email || '',
          website: details.website || '',
          instagram: details.instagram || '',
          rating: place.rating || 0,
          reviews: place.user_ratings_total || 0,
          place_id: place.place_id || '',
          lat: place.geometry?.location?.lat || 0,
          lng: place.geometry?.location?.lng || 0,
          horarios: details.horarios || '',
        });
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 50));
      } catch(e) {
        enriched.push({
          nombre: place.name,
          zona: place.formatted_address || '',
          tel: '', whatsapp: '', email: '', website: '',
          instagram: '', rating: place.rating || 0,
          reviews: place.user_ratings_total || 0,
          place_id: place.place_id || '',
          lat: place.geometry?.location?.lat || 0,
          lng: place.geometry?.location?.lng || 0,
        });
      }
    }

    return res.status(200).json({
      results: enriched,
      next_page_token: data.next_page_token || null,
      total: enriched.length,
      status: data.status
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Place Details: teléfono, web, horarios ──
async function getPlaceDetails(placeId, key) {
  const fields = 'formatted_phone_number,website,opening_hours,international_phone_number';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&language=es&key=${key}`;
  const r = await fetch(url);
  const data = await r.json();
  const result = data.result || {};

  const tel = result.formatted_phone_number || result.international_phone_number || '';
  const website = result.website || '';
  const horarios = result.opening_hours?.weekday_text?.join(' | ') || '';

  // Try to extract WA, email, Instagram from website
  let whatsapp = '', email = '', instagram = '';
  if (website) {
    try {
      const webData = await scrapeWebsite(website);
      whatsapp = webData.whatsapp || '';
      email = webData.email || '';
      instagram = webData.instagram || '';
    } catch(e) { /* silent */ }
  }

  // If phone looks like mobile (Argentina: 11, 15, 2xx, 3xx prefix), it might be WA
  if (!whatsapp && tel) {
    const digits = tel.replace(/\D/g, '');
    // Argentine mobile numbers
    if (digits.length >= 10) {
      whatsapp = '54' + digits.replace(/^0/, '').replace(/^54/, '');
    }
  }

  return { tel, website, horarios, whatsapp, email, instagram };
}

// ── Scrape website for contact info ──
async function scrapeWebsite(url) {
  const result = { whatsapp: '', email: '', instagram: '' };
  try {
    // Add timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; business-info-bot/1.0)' }
    });
    clearTimeout(timeout);
    
    if (!r.ok) return result;
    const html = await r.text();

    // WhatsApp patterns
    const waPatterns = [
      /wa\.me\/(\d{10,15})/g,
      /api\.whatsapp\.com\/send\?phone=(\d{10,15})/g,
      /whatsapp.*?(\+?54\s*9?\s*\d{2,4}\s*\d{3,4}\s*\d{4})/gi,
    ];
    for (const pat of waPatterns) {
      const match = pat.exec(html);
      if (match) {
        result.whatsapp = match[1].replace(/\D/g, '');
        if (!result.whatsapp.startsWith('54')) result.whatsapp = '54' + result.whatsapp;
        break;
      }
    }

    // Email patterns
    const emailMatch = html.match(/([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})/);
    if (emailMatch) {
      const em = emailMatch[1];
      // Filter out common false positives
      if (!em.includes('example') && !em.includes('sentry') && !em.includes('wix')) {
        result.email = em;
      }
    }

    // Instagram patterns
    const igMatch = html.match(/instagram\.com\/([a-zA-Z0-9._]{2,30})['"\/\s]/);
    if (igMatch && !['p', 'reel', 'stories', 'explore'].includes(igMatch[1])) {
      result.instagram = '@' + igMatch[1];
    }

  } catch(e) { /* timeout or network error - silent */ }
  return result;
}

// ── Enrich single place ──
async function enrichPlace(placeId, key, res) {
  try {
    const details = await getPlaceDetails(placeId, key);
    return res.status(200).json(details);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
