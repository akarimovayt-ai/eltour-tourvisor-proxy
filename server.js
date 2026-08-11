// Eltour Tourvisor Proxy v10 - full results, hotel grouping, all KZ cities
const express = require('express');
const app = express();
app.use(express.json());

const LOGIN = process.env.TOURVISOR_LOGIN;
const PASS = process.env.TOURVISOR_PASS;
const BASE = 'https://tourvisor.ru/xml';
const RUB_TO_KZT = 5.5;

// Реальные Tourvisor ID стран (верифицированы через API listdev)
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
    { id: '50',  name: 'Китай (Хайнань)' },
    { id: '52',  name: 'Куба' },
    { id: '63',  name: 'Мексика' },
    { id: '85',  name: 'Марокко' },
    { id: '95',  name: 'Мальдивы' },
    { id: '105', name: 'Вьетнам' },
    { id: '119', name: 'Индонезия (Бали)' },
    { id: '120', name: 'Таиланд' },
    { id: '122', name: 'Шри-Ланка' }
];

// Все города вылета из Казахстана
var STATIC_DEPARTURES = [
    { id: '58',  name: 'Алматы' },
    { id: '59',  name: 'Астана' },
    { id: '64',  name: 'Шымкент' },
    { id: '379', name: 'Актау' },
    { id: '380', name: 'Атырау' },
    { id: '381', name: 'Актобе' },
    { id: '382', name: 'Уральск' },
    { id: '383', name: 'Павлодар' },
    { id: '384', name: 'Усть-Каменогорск' },
    { id: '385', name: 'Семей' },
    { id: '386', name: 'Тараз' },
    { id: '387', name: 'Кызылорда' },
    { id: '388', name: 'Костанай' },
    { id: '389', name: 'Петропавловск' },
    { id: '390', name: 'Туркестан' }
];

// Регионы Турции (статический fallback)
var STATIC_REGIONS_TURKEY = [
    { id: '1009', name: 'Кемер' },
    { id: '1010', name: 'Анталья' },
    { id: '1011', name: 'Белек' },
    { id: '1014', name: 'Сиде' },
    { id: '1015', name: 'Аланья' },
    { id: '1016', name: 'Мармарис' },
    { id: '1017', name: 'Бодрум' },
    { id: '1018', name: 'Фетхие' },
    { id: '1020', name: 'Стамбул' },
    { id: '1021', name: 'Кушадасы' }
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
        try {
            var text2 = new TextDecoder('windows-1251').decode(buf);
            if (!text2 || !text2.trim()) throw new Error('Empty response from Tourvisor');
            return JSON.parse(text2);
        } catch(e2) {
            console.error('fetchTourvisorJSON error for', url.split('?')[0], '| preview:', (text || '').substring(0, 200));
            throw e2;
        }
    }
}

async function waitForSearch(requestId, maxWait) {
    maxWait = maxWait || 25000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        var url = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS + '&requestid=' + requestId + '&type=status';
        var data = await fetchTourvisorJSON(url);
        var status = (data && data.data && data.data.status) || {};
        var pct = (status.progress != null) ? status.progress
                : (data && data.data && data.data.percentage != null) ? data.data.percentage
                : (data && data.result && data.result.percentage != null) ? data.result.percentage
                : (data && data.percentage != null) ? data.percentage : 0;
        var state = status.state || '';
        if (pct >= 100 || state === 'finished') return true;
        await new Promise(function(res) { setTimeout(res, 2000); });
    }
    return false; // timeout — partial results OK
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

// Группировка туров по отелю: один лучший тур на отель
function groupByHotel(hotels) {
    var hotelMap = {};
    for (var i = 0; i < hotels.length; i++) {
        var hotel = hotels[i];
        var name = hotel.hotelname || hotel.name || 'Неизвестно';
        var toursData = hotel.tours || {};
        var toursArr = toursData.tour || [];
        if (!Array.isArray(toursArr)) toursArr = [toursArr];

        // Берём самый дешёвый тур для этого отеля
        var bestTour = null;
        var bestPrice = Infinity;
        for (var j = 0; j < toursArr.length; j++) {
            var t = toursArr[j];
            var price = toKZT(t.price, t.currency || 'RUB');
            if (price < bestPrice) {
                bestPrice = price;
                bestTour = t;
            }
        }
        if (!bestTour) continue;

        // Если отель уже есть — оставляем более дешёвый вариант
        if (hotelMap[name] && hotelMap[name].price <= bestPrice) continue;

        hotelMap[name] = {
            hotel: name,
stars: hotel.hotelstars || '',
                        resort: hotel.regionname || hotel.subregionname || '',
            hotelId: hotel.hotelcode || hotel.id || '',
            link: hotel.hotelcode ? 'https://tourvisor.ru/hotel/?hotelcode=' + hotel.hotelcode : '',
            dateFrom: bestTour.flydate || '',
            nights: bestTour.nights || '',
            meal: bestTour.mealrussian || bestTour.meal || '',
            price: bestPrice,
            currency: 'KZT',
            operator: bestTour.operatorname || '',
            roomType: bestTour.room || bestTour.placement || ''
        };
    }
    return Object.values(hotelMap);
}

app.post('/search', async function(req, res) {
    try {
        var body = req.body;
        var country   = body.country;
        var departure = body.departure;
        var dateFrom  = body.dateFrom;
        var dateTo    = body.dateTo;
        var nightsFrom = body.nightsFrom;
        var nightsTo   = body.nightsTo;
        var adults    = body.adults;
        var children  = body.children;
        var budget    = body.budget;
        var stars     = body.stars;      // "3", "4", "5" или "4,5" — фильтр по звёздам
        var resort    = body.resort;     // текстовый фильтр по курорту (клиентский)
        var regions   = body.regions;    // ID регионов Tourvisor через запятую (точный)
        var maxResults = parseInt(body.maxResults) || 100; // сколько отелей вернуть

        if (!country || !departure || !dateFrom) {
            return res.status(400).json({ error: 'Нужны: country, departure, dateFrom' });
        }

        var params = new URLSearchParams({
            format: 'json', authlogin: LOGIN, authpass: PASS,
            country: country, departure: departure,
            datefrom: toTourvisorDate(dateFrom),
            dateto: toTourvisorDate(dateTo || dateFrom),
            nightsfrom: nightsFrom || 7,
            nightsto: nightsTo || 10,
            adults: adults || 2
        });

        if (children && children.length > 0) {
            params.set('child', children.length);
            children.forEach(function(age, i) { params.set('childage' + (i + 1), age); });
        }
        if (regions && country != 4) params.set('regions', regions);
        if (stars)   params.set('stars', stars);
    
        var startData = await fetchTourvisorJSON(BASE + '/search.php?' + params);
        var requestId = (startData.result && startData.result.requestid)
                     || (startData.data && startData.data.requestid)
                     || startData.requestid;

        if (!requestId) {
            return res.status(500).json({ error: 'Не удалось запустить поиск', detail: startData });
        }

        await waitForSearch(requestId);

        // Запрашиваем 100 результатов — чтобы охватить и бюджетные и премиум отели
        var resultUrl = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS
                      + '&requestid=' + requestId + '&type=result&onpage=100';
        var resultData = await fetchTourvisorJSON(resultUrl);

        var rd = (resultData.data && resultData.data.result) || resultData.result || {};
        var hotels = rd.hotel || [];
        if (!Array.isArray(hotels)) hotels = hotels ? [hotels] : [];

        // Группируем: один лучший тур на отель
        var grouped = groupByHotel(hotels);

        // Фильтр по бюджету (если передан)
        if (budget) grouped = grouped.filter(function(h) { return h.price <= budget; });
        // Если GPT передал regions для Турции — конвертируем в resort
                var TR = {'1009':'Кемер','1010':'Анталья','1011':'Белек','1014':'Сиде','1015':'Аланья','1016':'Мармарис','1017':'Бодрум','1018':'Фетхие','1020':'Стамбул','1021':'Кушадасы'};
                if (country == 4 && regions && !resort) { resort = TR[String(regions)] || null; }
        // Фильтр по курорту (текстовый, если regions не передан)
                if (resort) {
            var resortLower = resort.toLowerCase();
            var filtered = grouped.filter(function(h) {
                return h.resort && h.resort.toLowerCase().indexOf(resortLower) >= 0;
            });
            if (filtered.length > 0) {
                grouped = filtered;
            } else {
                console.log('Resort filter gave 0, returning all');
            }

        // Сортируем по цене — от дешёвых к дорогим
}
        grouped.sort(function(a, b) { return a.price - b.price; });

        // Возвращаем до maxResults отелей (по умолчанию 20)
        var result = grouped.slice(0, maxResults);

        res.json({
            requestId: requestId,
            found: result.length,
            totalHotelsFound: grouped.length,
            tours: result
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Эндпоинт для поиска лучшей цены по конкретному отелю
app.post('/search-hotel', async function(req, res) {
    try {
        var body = req.body;
        var country   = body.country;
        var departure = body.departure;
        var dateFrom  = body.dateFrom;
        var hotelId   = body.hotelId;   // ID отеля в Tourvisor
        var hotelName = body.hotelName; // или имя для поиска

        if (!country || !departure || !dateFrom) {
            return res.status(400).json({ error: 'Нужны: country, departure, dateFrom' });
        }

        var params = new URLSearchParams({
            format: 'json', authlogin: LOGIN, authpass: PASS,
            country: country, departure: departure,
            datefrom: toTourvisorDate(dateFrom),
            dateto: toTourvisorDate(body.dateTo || dateFrom),
            nightsfrom: body.nightsFrom || 7,
            nightsto: body.nightsTo || 14,
            adults: body.adults || 2
        });
        if (hotelId) params.set('hotel', hotelId);

        var startData = await fetchTourvisorJSON(BASE + '/search.php?' + params);
        var requestId = (startData.result && startData.result.requestid)
                     || (startData.data && startData.data.requestid)
                     || startData.requestid;
        if (!requestId) return res.status(500).json({ error: 'Поиск не запустился' });

        await waitForSearch(requestId);

        var resultUrl = BASE + '/result.php?format=json&authlogin=' + LOGIN + '&authpass=' + PASS
                      + '&requestid=' + requestId + '&type=result&onpage=50';
        var resultData = await fetchTourvisorJSON(resultUrl);
        var rd = (resultData.data && resultData.data.result) || resultData.result || {};
        var hotels = rd.hotel || [];
        if (!Array.isArray(hotels)) hotels = hotels ? [hotels] : [];

        var grouped = groupByHotel(hotels);

        // Фильтр по имени отеля если hotelId не дал результата
        if (hotelName && grouped.length > 1) {
            var nameLower = hotelName.toLowerCase();
            var filtered = grouped.filter(function(h) {
                return h.hotel && h.hotel.toLowerCase().indexOf(nameLower) >= 0;
            });
            if (filtered.length > 0) grouped = filtered;
        }

        grouped.sort(function(a, b) { return a.price - b.price; });
        res.json({ requestId: requestId, found: grouped.length, tours: grouped.slice(0, 10) });

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
            console.log('/departures: API empty, using static fallback');
            return res.json({ departures: STATIC_DEPARTURES, static: true });
        }
        res.json({ departures: deps });
    } catch (err) {
        console.log('/departures: API error, using static fallback');
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
            console.log('/countries: API empty, using static fallback');
            return res.json({ countries: STATIC_COUNTRIES, static: true });
        }
        res.json({ countries: countries });
    } catch (err) {
        console.log('/countries: API error, using static fallback');
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

app.get('/regions', async function(req, res) {
    try {
        var countryId = req.query.countryId || req.query.country;
        if (!countryId) return res.status(400).json({ error: 'Нужен ?countryId=...' });
        var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: 'region', country: countryId });
        var data = await fetchTourvisorJSON(BASE + '/listdev.php?' + params);
        var regions = (data && data.data && data.data.regions && data.data.regions.region)
                   || (data && data.regions && data.regions.region) || [];
        if (!Array.isArray(regions)) regions = [regions];
        if (regions.length === 0 && String(countryId) === '4') {
            return res.json({ regions: STATIC_REGIONS_TURKEY, static: true });
        }
        res.json({ regions: regions });
    } catch (err) {
        if (String(countryId) === '4') return res.json({ regions: STATIC_REGIONS_TURKEY, static: true });
        res.status(500).json({ error: err.message });
    }
});

// Debug endpoints
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

app.get('/debug-raw', async function(req, res) {
    try {
        var type = req.query.type || 'allcountry';
        var params = new URLSearchParams({ format: 'json', authlogin: LOGIN, authpass: PASS, type: type });
        var dep = req.query.departure;
        if (dep) params.set('departure', dep);
        var r = await fetch(BASE + '/listdev.php?' + params);
        var buf = await r.arrayBuffer();
        var text = new TextDecoder('utf-8').decode(buf);
        res.json({ status: r.status, length: buf.byteLength, preview: text.substring(0, 1000) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', function(req, res) {
    res.json({ status: 'ok', service: 'Eltour Tourvisor Proxy v10 - hotel grouping, 20 results, all KZ cities' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Proxy v10 запущен на порту ' + PORT); });
