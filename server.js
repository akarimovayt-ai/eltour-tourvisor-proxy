// Eltour Tourvisor Proxy v5 - deploy trigger
const express = require('express');
const app = express();
app.use(express.json());

const LOGIN = process.env.TOURVISOR_LOGIN;
const PASS = process.env.TOURVISOR_PASS;
const BASE = 'https://tourvisor.ru/xml';

// Читаем ответ Tourvisor (может быть windows-1251)
async function fetchTourvisorJSON(url) {
  var r = await fetch(url);
  var buf = await r.arrayBuffer();
  try {
    var text = new TextDecoder('utf-8').decode(buf);
    return JSON.parse(text);
  } catch(e) {
    var text2 = new TextDecoder('windows-1251').decode(buf);
    return JSON.parse(text2);
  }
}

// Polling статуса поиска
async function waitForSearch(requestId, maxWait) {
  maxWait = maxWait || 50000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=status';
    var data = await fetchTourvisorJSON(url);
    var pct = (data && data.data && data.data.percentage != null) ? data.data.percentage
      : (data && data.data && data.data.status && data.data.status.progress != null) ? data.data.status.progress
      : (data && data.result && data.result.percentage != null) ? data.result.percentage
      : (data && data.percentage != null) ? data.percentage : 0;
    if (pct >= 100) return true;
    await new Promise(function(res) { setTimeout(res, 2000); });
  }
  return false;
}

// Основной поиск туров
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
      format: 'json', authlogin: LOGIN, authpass: PASS,
      country: country, departure: departure,
      datefrom: dateFrom, dateto: dateTo || dateFrom,
      nights: nightsFrom || 7, nightsto: nightsTo || 10,
      adults: adults || 2, currency: 'kzt'
    });

    if (children && children.length > 0) {
      params.set('child', children.length);
      children.forEach(function(age, i) { params.set('childage' + (i + 1), age); });
    }

    var startData = await fetchTourvisorJSON(BASE + '/search.php?' + params);
    // FIX: requestid живёт в result.requestid
    var requestId = (startData.result && startData.result.requestid)
      || (startData.data && startData.data.requestid)
      || startData.requestid;

    if (!requestId) {
      return res.status(500).json({ error: 'Не удалось запустить поиск', detail: startData });
    }

    await waitForSearch(requestId);

    var resultUrl = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=result&onpage=20';
    var resultData = await fetchTourvisorJSON(resultUrl);

    var rd = (resultData.data && resultData.data.result)
      || resultData.result
      || {};
    var hotels = rd.hotel || [];
    if (!Array.isArray(hotels)) hotels = [hotels];

    var tours = [];
    for (var i = 0; i < hotels.length; i++) {
      var hotel = hotels[i];
      // FIX: туры в hotel.tours.tour[], а не hotel.tourvariant[]
      var toursData = hotel.tours || {};
      var toursArr = toursData.tour || [];
      if (!Array.isArray(toursArr)) toursArr = [toursArr];

      for (var j = 0; j < toursArr.length; j++) {
        var t = toursArr[j];
        tours.push({
          hotel: hotel.hotelname || hotel.name || 'Неизвестно',
          stars: hotel.hotelstars || '',
          resort: hotel.regionname || hotel.subregionname || '',
          dateFrom: t.flydate || '',
          nights: t.nights || '',
          meal: t.mealrussian || t.meal || '',
          price: parseFloat(t.price || 0),
          currency: t.currency || 'RUB',
          operator: t.operatorname || '',
          roomType: t.room || t.placement || ''
        });
      }
    }

    if (budget) tours = tours.filter(function(t) { return t.price <= budget; });
    var top5 = tours.sort(function(a, b) { return a.price - b.price; }).slice(0, 5);

    res.json({ requestId: requestId, found: top5.length, tours: top5 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: сырой ответ по requestId
app.get('/debug-result', async function(req, res) {
  try {
    var rid = req.query.requestId;
    if (!rid) return res.status(400).json({ error: 'Нужен ?requestId=...' });
    var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + rid + '&type=result&onpage=3';
    var data = await fetchTourvisorJSON(url);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Debug: запуск поиска
// country=4 (Турция), departure=8 (уточнить код Астаны)
app.post('/debug-search', async function(req, res) {
  try {
    var body = req.body;
    var params = new URLSearchParams({
      format: 'json', authlogin: LOGIN, authpass: PASS,
      country: body.country || 4, departure: body.departure || 8,
      datefrom: body.dateFrom || '01.09.2026', dateto: body.dateTo || '10.09.2026',
      nights: body.nightsFrom || 7, nightsto: body.nightsTo || 10,
      adults: body.adults || 2, currency: 'kzt'
    });
    var data = await fetchTourvisorJSON(BASE + '/search.php?' + params);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Debug: статус поиска
app.get('/debug-status', async function(req, res) {
  try {
    var rid = req.query.requestId;
    if (!rid) return res.status(400).json({ error: 'Нужен ?requestId=...' });
    var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + rid + '&type=status';
    var data = await fetchTourvisorJSON(url);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Найти правильный код города вылета
app.get('/find-departure', async function(req, res) {
    try {
          var name = (req.query.name || '').toLowerCase();
          var url = BASE + '/listdev.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&type=departure';
          var data = await fetchTourvisorJSON(url);
          var deps = (data && data.data && data.data.departures && data.data.departures.departure)
            || (data && data.departures && data.departures.departure) || [];
          if (!Array.isArray(deps)) deps = [deps];
          if (name) deps = deps.filter(function(d) { return d.name && d.name.toLowerCase().indexOf(name) >= 0; });
          res.json(deps.slice(0, 30));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Найти правильный код страны
app.get('/find-country', async function(req, res) {
    try {
          var name = (req.query.name || '').toLowerCase();
          var dep = req.query.departureId || '';
          var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: 'allcountry' });
          if (dep) params.set('departure', dep);
          var data = await fetchTourvisorJSON(BASE + '/listdev.php?' + params);
          var countries = (data && data.data && data.data.countries && data.data.countries.country)
            || (data && data.countries && data.countries.country) || [];
          if (!Array.isArray(countries)) countries = [countries];
          if (name) countries = countries.filter(function(c) { return c.name && c.name.toLowerCase().indexOf(name) >= 0; });
          res.json(countries.slice(0, 30));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Healthcheck
app.get('/', function(req, res) { res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy v5' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Proxy запущен на порту ' + PORT); });
