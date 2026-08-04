const express = require('express');
const app = express();
app.use(express.json());

const TOKEN = process.env.TOURVISOR_TOKEN;
const BASE = 'https://api.tourvisor.ru';

const headers = () => ({
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
});

async function waitForSearch(searchId, maxWait = 25000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const r = await fetch(`${BASE}/tours/search/${searchId}/status`, { headers: headers() });
    const data = await r.json();
    const progress = data?.data?.progress ?? data?.progress ?? 0;
    if (progress >= 100) return true;
    await new Promise(res => setTimeout(res, 2000));
  }
  return false;
}

app.post('/search', async (req, res) => {
  try {
    const { country, departure, dateFrom, dateTo, nightsFrom, nightsTo, adults, children, budget } = req.body;
    if (!country || !departure || !dateFrom) {
      return res.status(400).json({ error: 'country, departure, dateFrom required' });
    }
    const searchBody = {
      countryId: country, departureId: departure,
      dateFrom, dateTo: dateTo || dateFrom,
      nightsFrom: nightsFrom || 7, nightsTo: nightsTo || 10,
      adults: adults || 2, childs: children || [], currency: 'KZT'
    };
    const startRes = await fetch(`${BASE}/tours/search`, {
      method: 'POST', headers: headers(), body: JSON.stringify(searchBody)
    });
    const startData = await startRes.json();
    const searchId = startData?.data?.searchId || startData?.searchId;
    if (!searchId) return res.status(500).json({ error: 'Search failed', detail: startData });
    await waitForSearch(searchId);
    const resultRes = await fetch(`${BASE}/tours/search/${searchId}`, { headers: headers() });
    const resultData = await resultRes.json();
    const tours = resultData?.data?.tours || resultData?.tours || [];
    let filtered = budget ? tours.filter(t => (t.price || t.cost || 0) <= budget) : tours;
    const top5 = filtered.sort((a,b) => (a.price||a.cost||0)-(b.price||b.cost||0)).slice(0,5).map(t => ({
      hotel: t.hotelName||t.hotel||'Unknown', stars: t.hotelStars||t.stars||'',
      resort: t.resortName||t.resort||'', dateFrom: t.flyDateFrom||t.dateFrom||'',
      nights: t.nights||'', meal: t.mealName||t.meal||'',
      price: t.price||t.cost||0, currency:'KZT',
      operator: t.operatorName||t.operator||'', roomType: t.roomName||t.room||''
    }));
    res.json({ searchId, found: top5.length, tours: top5 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/departures', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/departures`, { headers: headers() });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/countries', async (req, res) => {
  try {
    const dep = req.query.departureId || '';
    const url = dep ? `${BASE}/countries?departureId=${dep}` : `${BASE}/countries`;
    const r = await fetch(url, { headers: headers() });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy on port ${PORT}`));
