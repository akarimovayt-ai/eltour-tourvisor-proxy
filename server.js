const express = require('express');
const app = express();
app.use(express.json());

const LOGIN = process.env.TOURVISOR_LOGIN;
const PASS = process.env.TOURVISOR_PASS;
const BASE = 'https://tourvisor.ru/xml';

async function waitForSearch(requestId, maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=status';
    const r = await fetch(url);
    const data = await r.json();
    const pct = data && data.data && data.data.percentage !== undefined ? data.data.percentage : (data && data.percentage !== undefined ? data.percentage : 0);
    if (pct >= 100) return true;
    await new Promise(res => setTimeout(res, 2000));
  }
  return false;
}

app.post('/search', async (req, res) => {
  try {
    const { country, departure, dateFrom, dateTo, nightsFrom, nightsTo, adults, children, budget } = req.body;
    if (!country || !departure || !dateFrom) {
      return res.status(400).json({ error: 'Нужны: country, departure, dateFrom' });
    }
    const params = new URLSearchParams({
      format: 'json', authlogin: LOGIN, authpass: PASS,
      country, departure, datefrom: dateFrom, dateto: dateTo || dateFrom,
      nights: nightsFrom || 7, nightsto: nightsTo || 10, adults: adults || 2, currency: 'kzt'
    });
    if (children && children.length > 0) {
      params.set('child', children.length);
      children.forEach(function(age, i) { params.set('childage' + (i + 1), age); });
    }
    const startRes = await fetch(BASE + '/search.php?' + params);
    const startData = await startRes.json();
    const requestId = (startData.data && startData.data.requestid) || startData.requestid;
    if (!requestId) return res.status(500).json({ error: 'Не удалось запустить поиск', detail: startData });
    await waitForSearch(requestId);
    const resultUrl = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=result&onpage=20';
    const resultRes = await fetch(resultUrl);
    const resultData = await resultRes.json();
    const hotels = (resultData.data && resultData.data.result && resultData.data.result.hotel) || [];
    let tours = [];
    for (const hotel of hotels) {
      const variants = hotel.tourvariant || [];
      const toursArr = Array.isArray(variants) ? variants : [variants];
      for (const t of toursArr) {
        tours.push({
          hotel: hotel.hotelname || hotel.name || 'Неизвестно',
          stars: hotel.hotelstars || '',
          resort: hotel.regionname || '',
          dateFrom: t.flydate || t.checkin || '',
          nights: t.nights || '',
          meal: t.mealname || t.meal || '',
          price: parseFloat(t.price || t.cost || 0),
          currency: 'KZT',
          operator: t.touroperatorname || t.operatorname || '',
          roomType: t.roomname || t.room || ''
        });
      }
    }
    if (budget) tours = tours.filter(function(t) { return t.price <= budget; });
    const top5 = tours.sort(function(a, b) { return a.price - b.price; }).slice(0, 5);
    res.json({ requestId, found: top5.length, tours: top5 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/departures', async (req, res) => {
  try {
    const url = BASE + '/listdev.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&type=departure';
    const r = await fetch(url);
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/countries', async (req, res) => {
  try {
    const dep = req.query.departureId || '';
    const params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: 'allcountry' });
    if (dep) params.set('departure', dep);
    const r = await fetch(BASE + '/listdev.php?' + params);
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', function(req, res) { res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy v2' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Proxy запущен на порту ' + PORT); });
