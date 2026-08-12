// Eltour Tourvisor Proxy v14 - dynamic region lookup, resort→regionID fix
const express = require('express');
const app = express();
app.use(express.json());

const LOGIN = process.env.TOURVISOR_LOGIN;
const PASS = process.env.TOURVISOR_PASS;
const BASE = 'https://tourvisor.ru/xml';

// Кеш регионов (countryId → [{id, name}])
var regionsCache = {};

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

async function fetchRegions(countryId, departureId) {
  var key = countryId + '_' + (departureId || '');
  if (regionsCache[key]) return regionsCache[key];
  var params = new URLSearchParams({
    format: 'json', authlogin: LOGIN, authpass: PASS,
    type: 'region', country: countryId
  });
  if (departureId) params.set('departure', departureId);
  var data = await fetchTourvisorJSON(BASE + '/listdev.php?' + params);
  var regions = (data && data.data && data.data.regions && data.data.regions.region)
    || (data && data.regions && data.regions.region) || [];
  if (!Array.isArray(regions)) regions = regions ? [regions] : [];
  regionsCache[key] = regions;
  return regions;
}

async function resolveResortId(resortName, countryId, departureId) {
  if (!resortName) return null;
  if (/^\d+$/.test(String(resortName))) return String(resortName);
  var regions = await fetchRegions(countryId, departureId);
  var name = resortName.toLowerCase().trim();
  var found = regions.find(function(r) {
    return r.name && r.name.toLowerCase().indexOf(name) >= 0;
  });
  return found ? String(found.id) : null;
}

async function waitForSearch(requestId, maxWait) {
  maxWait = maxWait || 45000;
  var start = Date.now();
  while (Date.now() - start < maxWait) {
    var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=status';
    var data = await fetchTourvisorJSON(url);
    var pct = (data && data.data && data.data.percentage != null) ? data.data.percentage
      : (data && data.result && data.result.percentage != null) ? data.result.percentage
      : (data && data.percentage != null) ? data.percentage : 0;
    if (pct >= 100) return true;
    await new Promise(function(res) { setTimeout(res, 2000); });
  }
  return false;
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
    var stars = body.stars;
    var budget = body.budget;
    var resortRaw = body.resort || body.region || '';

    if (!country || !departure || !dateFrom) {
      return res.status(400).json({ error: 'Нужны: country, departure, dateFrom' });
    }

    var resolvedRegionId = null;
    if (resortRaw) {
      resolvedRegionId = await resolveResortId(String(resortRaw), country, departure);
    }

    var params = new URLSearchParams({
      format: 'json', authlogin: LOGIN, authpass: PASS,
      country: country, departure: departure,
      datefrom: dateFrom, dateto: dateTo || dateFrom,
      nights: nightsFrom || 7, nightsto: nightsTo || (nightsFrom ? parseInt(nightsFrom)+3 : 10),
      adults: adults || 2, currency: 'kzt'
    });

    if (resolvedRegionId) params.set('region', resolvedRegionId);
    if (stars) params.set('stars', stars);
    if (children && children.length > 0) {
      params.set('child', children.length);
      children.forEach(function(age, i) { params.set('childage' + (i+1), age); });
    }

    var startData = await fetchTourvisorJSON(BASE + '/search.php?' + params);
    var requestId = (startData.data && startData.data.requestid)
      || (startData.result && startData.result.requestid)
      || startData.requestid;

    if (!requestId) {
      return res.status(500).json({ error: 'Не удалось запустить поиск', detail: startData });
    }

    await waitForSearch(requestId);

    var resultUrl = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS
      + '&requestid=' + requestId + '&type=result&onpage=20';
    var resultData = await fetchTourvisorJSON(resultUrl);

    var rd = (resultData.data && resultData.data.result) || resultData.result || {};
    var hotels = rd.hotel || [];
    if (!Array.isArray(hotels)) hotels = [hotels];

    var tours = [];
    for (var i = 0; i < hotels.length; i++) {
      var hotel = hotels[i];
      var variants = hotel.tourvariant || hotel.tours || [];
      var toursArr = Array.isArray(variants) ? variants
        : (variants.tour ? (Array.isArray(variants.tour) ? variants.tour : [variants.tour]) : [variants]);
      for (var j = 0; j < toursArr.length; j++) {
        var t = toursArr[j];
        tours.push({
          hotel: hotel.hotelname || hotel.name || 'Неизвестно',
          stars: hotel.hotelstars || '',
          resort: hotel.regionname || '',
          hotelId: hotel.hotelcode || '',
          link: hotel.hotelcode ? 'https://tourvisor.ru/hotel/?hotelcode=' + hotel.hotelcode : '',
          dateFrom: t.flydate || t.checkin || '',
          nights: t.nights || '',
          meal: t.mealname || t.mealrussian || t.meal || '',
          price: parseFloat(t.price || t.cost || 0),
          currency: 'KZT',
          operator: t.touroperatorname || t.operatorname || '',
          roomType: t.roomname || t.room || t.placement || ''
        });
      }
    }

    if (budget) tours = tours.filter(function(t) { return t.price <= budget; });
    var top = tours.sort(function(a, b) { return a.price - b.price; }).slice(0, 10);

    res.json({
      requestId: requestId,
      found: top.length,
      totalHotelsFound: hotels.length,
      resolvedRegionId: resolvedRegionId,
      tours: top
    });
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

app.get('/regions', async function(req, res) {
  try {
    var countryId = req.query.countryId;
    var departureId = req.query.departureId;
    if (!countryId) return res.status(400).json({ error: 'Нужен ?countryId=...' });
    var regions = await fetchRegions(countryId, departureId);
    res.json({ regions: regions, source: 'tourvisor-api' });
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

app.get('/find-region', async function(req, res) {
  try {
    var name = (req.query.name || '').toLowerCase();
    var countryId = req.query.countryId;
    var departureId = req.query.departureId;
    if (!countryId) return res.status(400).json({ error: 'Нужен ?countryId=...&name=...' });
    var regions = await fetchRegions(countryId, departureId);
    var filtered = name ? regions.filter(function(r) { return r.name && r.name.toLowerCase().indexOf(name) >= 0; }) : regions;
    res.json(filtered.slice(0, 30));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/debug-result', async function(req, res) {
  try {
    var rid = req.query.requestId;
    if (!rid) return res.status(400).json({ error: 'Нужен ?requestId=...' });
    var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + rid + '&type=result&onpage=5';
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
      nights: body.nightsFrom || 7, nightsto: body.nightsTo || 10,
      adults: body.adults || 2, currency: 'kzt'
    });
    if (body.region) params.set('region', body.region);
    if (body.stars) params.set('stars', body.stars);
    var data = await fetchTourvisorJSON(BASE + '/search.php?' + params);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/debug-raw', async function(req, res) {
  try {
    var type = req.query.type || 'departure';
    var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: type });
    if (req.query.country) params.set('country', req.query.country);
    if (req.query.departure) params.set('departure', req.query.departure);
    var url = BASE + '/listdev.php?' + params;
    var r = await fetch(url);
    var buf = await r.arrayBuffer();
    var textUtf = '', jsonUtf = null;
    try { textUtf = new TextDecoder('utf-8').decode(buf); jsonUtf = JSON.parse(textUtf); } catch(e) { textUtf = e.message; }
    res.json({ status: r.status, length: buf.byteLength, preview: textUtf.slice(0, 500), data: jsonUtf });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', function(req, res) {
  res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy v14 - dynamic region lookup' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Proxy v14 на порту ' + PORT); });
