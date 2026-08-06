// Eltour Tourvisor Proxy v9 - static fallback for countries/departures
const express = require('express');
const app = express();
app.use(express.json());

const LOGIN = process.env.TOURVISOR_LOGIN;
const PASS = process.env.TOURVISOR_PASS;
const BASE = 'https://tourvisor.ru/xml';
const RUB_TO_KZT = 5.5; // Курс RUB/KZT, обновлять при необходимости

// Статический список стран (Tourvisor IDs) — используется если API возвращает пустой ответ
var STATIC_COUNTRIES = [
    { id: '3',   name: 'Египет' },
    { id: '4',   name: 'Турция' },
    { id: '2',   name: 'Болгария' },
    { id: '5',   name: 'Доминикана' },
    { id: '8',   name: 'Португалия' },
    { id: '12',  name: 'Испания' },
    { id: '15',  name: 'Греция' },
    { id: '17',  name: 'Кипр' },
    { id: '18',  name: 'Тунис' },
    { id: '29',  name: 'Израиль' },
    { id: '30',  name: 'Италия' },
    { id: '31',  name: 'ОАЭ' },
    { id: '37',  name: 'Черногория' },
    { id: '43',  name: 'Хорватия' },
    { id: '47',  name: 'Иордания' },
    { id: '50',  name: 'Китай' },
    { id: '52',  name: 'Куба' },
    { id: '63',  name: 'Мексика' },
    { id: '85',  name: 'Марокко' },
    { id: '95',  name: 'Мальдивы' },
    { id: '105', name: 'Вьетнам' },
    { id: '119', name: 'Индонезия (Бали)' },
    { id: '120', name: 'Таиланд' },
    { id: '122', name: 'Шри-Ланка' }
];

// Статический список городов вылета — используется если API возвращает пустой ответ
var STATIC_DEPARTURES = [
    { id: '58', name: 'Алматы' },
    { id: '59', name: 'Астана' }
];

async function fetchTourvisorJSON(url) {
    var r = await fetch(url);
    var buf = await r.arrayBuffer();
    var text = '';
    try {
          text = new TextDecoder('utf-8').decode(buf);
          if (!text || !text.trim()) throw new Error('Empty response from Tourvisor');
          return JSON.parse(text);
    } catch(e) {
          // If utf-8 parse failed, try windows-1251
          try {
                var text2 = new TextDecoder('windows-1251').decode(buf);
                if (!text2 || !text2.trim()) throw new Error('Empty response from Tourvisor');
                return JSON.parse(text2);
          } catch(e2) {
                console.error('fetchTourvisorJSON error for', url.split('?')[0], '| response preview:', (text || '').substring(0, 200));
                throw e2;
          }
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

function toTourvisorDate(dateStr) {
        if (!dateStr) return '';
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) return dateStr;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                    var p = dateStr.split('-');
                    return p[2] + '.' + p[1] + '.' + p[0];
        }
        return dateStr;
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
                  datefrom: toTourvisorDate(dateFrom), dateto: toTourvisorDate(dateTo || dateFrom),
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
          if (deps.length === 0) {
                  console.log('/departures: API returned empty, using static fallback');
                  return res.json({ departures: STATIC_DEPARTURES, static: true });
          }
          res.json({ departures: deps });
    } catch (err) {
          console.log('/departures: API error (' + err.message + '), using static fallback');
          res.json({ departures: STATIC_DEPARTURES, static: true });
    }
});

app.get('/countries', async function(req, res) {
    try {
          var dep = req.query.departureId;
          var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: 'allcountry' });
          if (dep) params.set('departure', dep);
          var data = await fetchTourvisorJSON(BASE + '/listdev.php?' + params);
          var countries = (data && data.data && data.data.countries && data.data.countries.country)
                  || (data && data.countries && data.countries.country) || [];
          if (!Array.isArray(countries)) countries = [countries];
          if (countries.length === 0) {
                  console.log('/countries: API returned empty, using static fallback');
                  return res.json({ countries: STATIC_COUNTRIES, static: true });
          }
          res.json({ countries: countries });
    } catch (err) {
          console.log('/countries: API error (' + err.message + '), using static fallback');
          res.json({ countries: STATIC_COUNTRIES, static: true });
    }
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
          if (countries.length === 0) countries = STATIC_COUNTRIES;
          if (name) countries = countries.filter(function(c) { return c.name && c.name.toLowerCase().indexOf(name) >= 0; });
          res.json(countries.slice(0, 30));
    } catch (err) {
          var name2 = (req.query.name || '').toLowerCase();
          var fallback = name2 ? STATIC_COUNTRIES.filter(function(c) { return c.name.toLowerCase().indexOf(name2) >= 0; }) : STATIC_COUNTRIES;
          res.json(fallback.slice(0, 30));
    }
});

app.get('/find-departure', async function(req, res) {
    try {
          var name = (req.query.name || '').toLowerCase();
          var url = BASE + '/listdev.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&type=departure';
          var data = await fetchTourvisorJSON(url);
          var deps = (data && data.data && data.data.departures && data.data.departures.departure)
                  || (data && data.departures && data.departures.departure) || [];
          if (!Array.isArray(deps)) deps = [deps];
          if (deps.length === 0) deps = STATIC_DEPARTURES;
          if (name) deps = deps.filter(function(d) { return d.name && d.name.toLowerCase().indexOf(name) >= 0; });
          res.json(deps.slice(0, 30));
    } catch (err) {
          var name2 = (req.query.name || '').toLowerCase();
          var fallback = name2 ? STATIC_DEPARTURES.filter(function(d) { return d.name.toLowerCase().indexOf(name2) >= 0; }) : STATIC_DEPARTURES;
          res.json(fallback.slice(0, 30));
    }
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

// Debug: see raw Tourvisor response for any listdev endpoint
app.get('/debug-raw', async function(req, res) {
    try {
          var type = req.query.type || 'allcountry';
          var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: type });
          var dep = req.query.departure;
          if (dep) params.set('departure', dep);
          var r = await fetch(BASE + '/listdev.php?' + params);
          var buf = await r.arrayBuffer();
          var text = new TextDecoder('utf-8').decode(buf);
          res.json({ status: r.status, length: buf.byteLength, preview: text.substring(0, 500) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', function(req, res) { res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy v9 - KZT + static fallback' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Proxy v9 KZT запущен на порту ' + PORT); });
