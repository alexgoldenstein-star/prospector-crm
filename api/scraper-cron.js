// api/scraper-cron.js
// Corre automáticamente todos los lunes a las 9am (configurado en vercel.json)
// Busca nuevos prospectos en Google Maps y los agrega a Firestore

export default async function handler(req, res) {
  // Solo permitir llamadas del cron de Vercel
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const mapsKey = process.env.GOOGLE_MAPS_KEY;
  if (!mapsKey) return res.status(500).json({ error: 'No Maps key' });

  const searches = [
    // NIVIKO
    { query: 'casa de articulos del hogar Buenos Aires', company: 'niviko', rubro: 'Art. del Hogar' },
    { query: 'muebleria mayorista CABA', company: 'niviko', rubro: 'Mueblería' },
    { query: 'bazar mayorista GBA', company: 'niviko', rubro: 'Retail / Bazar' },
    // Broker
    { query: 'constructora inmobiliaria CABA', company: 'broker', rubro: 'Constructora' },
    { query: 'estudio de arquitectura Buenos Aires', company: 'broker', rubro: 'Estudio de arquitectura' },
  ];

  const results = [];
  for (const s of searches) {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(s.query)}&key=${mapsKey}&language=es`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.results) {
        data.results.slice(0, 10).forEach(p => {
          results.push({
            nombre: p.name,
            zona: p.formatted_address,
            rating: p.rating || 0,
            company: s.company,
            rubro: s.rubro,
            source: 'maps_cron',
            created: Date.now()
          });
        });
      }
    } catch (e) {
      console.error('Error buscando:', s.query, e);
    }
  }

  console.log(`✅ Cron scraper: ${results.length} resultados encontrados`);
  return res.status(200).json({ results: results.length, data: results });
}
