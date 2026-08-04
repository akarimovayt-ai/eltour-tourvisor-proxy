const express = require('express');
const app = express();
app.use(express.json());

const LOGIN = process.env.TOURVISOR_LOGIN;
const PASS = process.env.TOURVISOR_PASS;
const BASE = 'https://tourvisor.ru/xml';

// Polling статуса поиска
async function waitForSearch(requestId, maxWait) {
  maxWait = maxWait || 40000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=status';
    const r = await fetch(url);
    const data = await r.json();
    // Tourvisor может вернуть процент в разных местах
    const pct = (data && data.data && data.data.percentage != null) ? data.data.percentage
      : (data && data.result && data.result.percentage != null) ? data.result.percentage
      : (data && data.percentage != null) ? data.percentage : 0;
    if (pct >= 100) return true;
    await new Promise(function(res) { setTimeout(res, 2000); });
  }
  return false;
}

// Основной поиск
app.post('/search', async function(req, res) {
  try {
    var body = req.body;
    var country = body.country;
    var departure = body.departure;
    var dateFrom = body.dateFrom;
    var dateTo = body.dateTo;
    var nightsFrom = body.nightsFrom;
    var nightsTo = body.nightsTo;
    var adults = body.adults;
    var children = body.children;
    var budget = body.budget;

    if (!country || !departure || !dateFrom) {
      return res.status(400).json({ error: 'Нужны: country, departure, dateFrom' });
    }

    var params = new URLSearchParams({
      format: 'json',
      authlogin: LOGIN,
      authpass: PASS,
      country: country,
      departure: departure,
      datefrom: dateFrom,
      dateto: dateTo || dateFrom,
      nights: nightsFrom || 7,
      nightsto: nightsTo || 10,
      adults: adults || 2,
      currency: 'kzt'
    });

    if (children && children.length > 0) {
      params.set('child', children.length);
      children.forEach(function(age, i) { params.set('childage' + (i + 1), age); });
    }

    // Запуск поиска
    var startRes = await fetch(BASE + '/search.php?' + params);
    var startData = await startRes.json();

    // Tourvisor возвращает requestid в разных местах
    var requestId = (startData.data && startData.data.requestid)
      || (startData.result && startData.result.requestid)
      || startData.requestid;

    if (!requestId) {
      return res.status(500).json({ error: 'Не удалось запустить поиск', detail: startData });
    }

    // Ждём завершения поиска
    await waitForSearch(requestId);

    // Получаем результаты
    var resultUrl = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=result&onpage=20';
    var resultRes = await fetch(resultUrl);
    var resultData = await resultRes.json();

    // Tourvisor может вернуть отели в разных местах
    var rd = (resultData.data && resultData.data.result) || resultData.result || {};
    var hotels = rd.hotel || [];
    if (!Array.isArray(hotels)) hotels = [hotels];

    var tours = [];
    for (var i = 0; i < hotels.length; i++) {
      var hotel = hotels[i];
      var variants = hotel.tourvariant || [];
      var toursArr = Array.isArray(variants) ? variants : [variants];
      for (var j = 0; j < toursArr.length; j++) {
        var t = toursArr[j];
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

    if (budget) {
      tours = tours.filter(function(t) { return t.price <= budget; });
    }

    var top5 = tours.sort(function(a, b) { return a.price - b.price; }).slice(0, 5);

    res.json({ requestId: requestId, found: top5.length, tours: top5 });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: сырой ответ Tourvisor по requestId
app.get('/debug-result', async function(req, res) {
  try {
    var rid = req.query.requestId;
    if (!rid) return res.status(400).json({ error: 'Нужен ?requestId=...' });
    var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + rid + '&type=result&onpage=3';
    var r = await fetch(url);
    var data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message }); }
});

// Debug: сырой запуск поиска
app.post('/debug-search', async function(req, res) {
  try {
    var body = req.body;
    var params = new URLSearchParams({
      format: 'json', authlogin: LOGIN, authpass: PASS,
      country: body.country || 45,
      departure: body.departure || 3,
      datefrom: body.dateFrom || '01.09.2026',
      dateto: body.dateTo || '10.09.2026',
      nights: body.nightsFrom || 7,
      nightsto: body.nightsTo || 10,
      adults: body.adults || 2,
      currency: 'kzt'
    });
    var r = await fetch(BASE + '/search.php?' + params);
    var data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Справочник городов вылета
app.get('/departures', async function(req, res) {
  try {
    var url = BASE + '/listdev.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&type=departure';
    var r = await fetch(url);
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Справочник стран
app.get('/countries', async function(req, res) {
  try {
    var dep = req.query.departureId || '';
    var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: 'allcountry' });
    if (dep) params.set('departure', dep);
    var r = await fetch(BASE + '/listdev.php?' + params);
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Healthcheck
app.get('/', function(req, res) { res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy v3' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Proxy запущен на порту ' + PORT); });
