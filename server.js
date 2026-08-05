// Eltour Tourvisor Proxy v8 - fix waitForSearch progress parsing
const express = require('express');
const app = express();
app.use(express.json());

const LOGIN = process.env.TOURVISOR_LOGIN;
const PASS = process.env.TOURVISOR_PASS;
const BASE = 'https://tourvisor.ru/xml';
const RUB_TO_KZT = 5.5; // Курс RUB/KZT, обновлять при необходимости

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

async function waitForSearch(requestId, maxWait) {
    maxWait = maxWait || 50000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
          var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=status';
          var data = await fetchTourvisorJSON(url);
          // Tourvisor returns: {"data":{"status":{"state":"finished","progress":100,...}}}
          var status = (data && data.data && data.data.status) || {};
          var pct = (status.progress != null) ? status.progress
                  : (data && data.data && data.data.percentage != null) ? data.data.percentage
                  : (data && data.result && data.result.percentage != null) ? data.result.percentage
                  : (data && data.percentage != null) ? data.percentage : 0;
          var state = status.state || '';
          if (pct >= 100 || state === 'finished') return true;
          await new Promise(function(res) { setTimeout(res, 2000); });
    }
    return false;
}

function toKZT(price, currency) {
    var p = parseFloat(price || 0);
    if (currency === 'RUB') return Math.round(p * RUB_TO_KZT);
    return Math.round(p);
}

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
                  nightsfrom: nightsFrom || 7, nightsto: nightsTo || 10,
                  adults: adults || 2
          });
      
          if (children && children.length > 0) {
                  params.set('child', children.length);
                  children.forEach(function(age, i) { params.set('childage' + (i + 1), age); });
          }
      
          var startData = await fetchTourvisorJSON(BASE + '/search.php?' + params);
          var requestId = (startData.result && startData.result.requestid)
                  || (startData.data && startData.data.requestid)
                  || startData.requestid;
      
          if (!requestId) {
                  return res.status(500).json({ error: 'Не удалось запустить поиск', detail: startData });
          }
      
          await waitForSearch(requestId);
      
          var resultUrl = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=result&onpage=20';
          var resultData = await fetchTourvisorJSON(resultUrl);
      
          var rd = (resultData.data && resultData.data.result) || resultData.result || {};
          var hotels = rd.hotel || [];
          if (!Array.isArray(hotels)) hotels = [hotels];
      
          var tours = [];
          for (var i = 0; i < hotels.length; i++) {
                  var hotel = hotels[i];
                  var toursData = hotel.tours || {};
                  var toursArr = toursData.tour || [];
                  if (!Array.isArray(toursArr)) toursArr = [toursArr];
                  for (var j = 0; j < toursArr.length; j++) {
                            var t = toursArr[j];
                            var origCurrency = t.currency || 'RUB';
                            tours.push({
                                        hotel: hotel.hotelname || hotel.name || 'Неизвестно',
                                        stars: hotel.hotelstars || '',
                                        resort: hotel.regionname || hotel.subregionname || '',
                                        dateFrom: t.flydate || '',
                                        nights: t.nights || '',
                                        meal: t.mealrussian || t.meal || '',
                                        price: toKZT(t.price, origCurrency),
                                        currency: 'KZT',
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

app.get('/departures', async function(req, res) {
    try {
          var url = BASE + '/listdev.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&type=departure';
          var data = await fetchTourvisorJSON(url);
          var deps = (data && data.data && data.data.departures && data.data.departures.departure)
                  || (data && data.departures && data.departures.departure) || [];
          if (!Array.isArray(deps)) deps = [deps];
          res.json({ departures: deps });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/countries', async function(req, res) {
    try {
          var dep = req.query.departureId || 59;
          var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: 'allcountry' });
          if (dep) params.set('departure', dep);
          var data = await fetchTourvisorJSON(BASE + '/listdev.php?' + params);
          var countries = (data && data.data && data.data.countries && data.data.countries.country)
                  || (data && data.countries && data.countries.country) || [];
          if (!Array.isArray(countries)) countries = [countries];
          res.json({ countries: countries });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/debug-result', async function(req, res) {
    try {
          var rid = req.query.requestId;
          if (!rid) return res.status(400).json({ error: 'Нужен ?requestId=...' });
          var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + rid + '&type=result&onpage=3';
          var data = await fetchTourvisorJSON(url);
          res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/debug-search', async function(req, res) {
    try {
          var body = req.body;
          var params = new URLSearchParams({
                  format: 'json', authlogin: LOGIN, authpass: PASS,
                  country: body.country || 4, departure: body.departure || 59,
                  datefrom: body.dateFrom || '01.09.2026', dateto: body.dateTo || '10.09.2026',
                  nightsfrom: body.nightsFrom || 7, nightsto: body.nightsTo || 10,
                  adults: body.adults || 2
          });
          var data = await fetchTourvisorJSON(BASE + '/search.php?' + params);
          res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/debug-status', async function(req, res) {
    try {
          var rid = req.query.requestId;
          if (!rid) return res.status(400).json({ error: 'Нужен ?requestId=...' });
          var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + rid + '&type=status';
          var data = await fetchTourvisorJSON(url);
          res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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

app.get('/', function(req, res) { res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy v8 - KZT' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Proxy v8 KZT запущен на порту ' + PORT); });
