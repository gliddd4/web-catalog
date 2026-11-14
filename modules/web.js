/* @8spine-meta
 * type: WEB
 * category: modules
 */

// One module: catalog web pages + catalog API, lyrics + meanings, community trackers.

const web = (function () {

    // Fetches public music.apple.com web pages for apps that parse them.
    // applePage(path) -> HTML of https://music.apple.com/<path>, or null.

    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

    async function applePage(path) {
        path = String(path || '').replace(/^\/+/, '');
        if (!path || path.indexOf('://') !== -1) return null;
        try {
            const res = await Promise.race([
                fetch('https://music.apple.com/' + path, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } }),
                new Promise(function (r) { setTimeout(function () { r(null); }, 12000); }),
            ]);
            if (!res || res.status < 200 || res.status > 299) return null;
            return await res.text();
        } catch (e) {
            return null;
        }
    }

    // ---- catalog API: uses the developer token the website's own player ships in its JS bundle ----

    let token = null;      // { value, exp }
    let tokenTask = null;

    function expiry(jwt) {
        try {
            let p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            while (p.length % 4) p += '=';
            const c = JSON.parse(atob(p));
            return typeof c.exp === 'number' ? c.exp : null;
        } catch (e) { return null; }
    }

    function usable(t) { return t && t.exp && (t.exp - Date.now() / 1000) > 60; }

    async function get(url, headers, ms) {
        try {
            const res = await Promise.race([fetch(url, { headers: headers }),
                new Promise(function (r) { setTimeout(function () { r(null); }, ms || 10000); })]);
            return res ? { status: res.status, text: await res.text() } : null;
        } catch (e) { return null; }
    }

    function ampRaw(pathAndQuery, value) {
        return get('https://amp-api.music.apple.com/v1/catalog/' + pathAndQuery, {
            'Authorization': 'Bearer ' + value, 'Origin': 'https://music.apple.com',
            'Accept': 'application/json', 'User-Agent': UA,
        });
    }

    async function readToken() {
        const page = await applePage('us/search?term=music');
        if (!page) return null;
        const re = /<script[^>]*src="(\/assets\/index[^"]*\.js)"/g;
        const paths = []; let m;
        while ((m = re.exec(page))) paths.push(m[1]);
        const bundle = paths.find(function (x) { return x.indexOf('-legacy') === -1; }) || paths[0];
        if (!bundle) return null;
        const js = await get('https://music.apple.com' + bundle, { 'User-Agent': UA }, 30000);
        if (!js || js.status !== 200) return null;
        const seen = {}, found = [];
        function add(v) { if (v.length > 100 && v.indexOf('eyJ') === 0 && !seen[v]) { seen[v] = 1; found.push(v); } }
        const decl = /developerToken:\s*(\w+)/.exec(js.text);
        if (decl) {
            const r = new RegExp('\\b' + decl[1] + '\\s*=\\s*"(eyJ[A-Za-z0-9_\\-\\.]+)"', 'g'); let n = 0;
            while ((m = r.exec(js.text)) && n++ < 2) add(m[1]);
        }
        const scan = /"(eyJ[A-Za-z0-9_\-\.]{150,})"/g; let k = 0;
        while ((m = scan.exec(js.text)) && k++ < 6) add(m[1]);
        for (const v of found) {
            const probe = await ampRaw('us/search/suggestions?term=music&kinds=terms&l=en-US&platform=web', v);
            if (probe && probe.status !== 401 && probe.status !== 403) return { value: v, exp: expiry(v) };
        }
        return null;
    }

    async function bearer(force) {
        if (!force && usable(token)) return token;
        if (!force && !token) {
            try { const saved = JSON.parse((await AsyncStorage.getItem('token')) || 'null'); if (usable(saved)) return (token = saved); } catch (e) {}
        }
        if (!tokenTask) {
            tokenTask = readToken().then(function (t) {
                token = t; tokenTask = null;
                if (t) AsyncStorage.setItem('token', JSON.stringify(t)).catch(function () {});
                return t;
            });
        }
        return tokenTask;
    }

    // JSON text of https://amp-api.music.apple.com/v1/catalog/<pathAndQuery>, or null.
    async function ampGet(pathAndQuery) {
        const p = String(pathAndQuery || '').replace(/^\/+/, '');
        if (!p || p.indexOf('://') !== -1) return null;
        let t = await bearer(false);
        if (!t) return null;
        let res = await ampRaw(p, t.value);
        if (res && (res.status === 401 || res.status === 403)) {
            t = await bearer(true);
            if (!t) return null;
            res = await ampRaw(p, t.value);
        }
        return res && res.status >= 200 && res.status <= 299 ? res.text : null;
    }

    // An album's motion cover: { video } (HLS master URL), or null. type: 'square' | 'tall'.
    async function getAnimatedArtwork(albumID, storefront, type) {
        const sf = /^[a-z]{2}$/.test(String(storefront || '')) ? storefront : 'us';
        const json = await ampGet(sf + '/albums/' + encodeURIComponent(String(albumID)) + '?extend=editorialVideo&l=en-US&platform=web');
        if (!json) return null;
        let ev;
        try { ev = JSON.parse(json).data[0].attributes.editorialVideo; } catch (e) { return null; }
        if (!ev) return null;
        const keys = type === 'tall' ? ['motionDetailTall', 'motionTallVideo3x4', 'motionDetailSquare'] : ['motionDetailSquare', 'motionSquareVideo1x1', 'motionDetailTall'];
        for (const k of keys) if (ev[k] && ev[k].video) return { video: ev[k].video };
        return null;
    }
    return {
        id: 'web-catalog',
        name: 'Web Catalog',
        version: '1.2.0',
        type: 'WEB',
        description: 'Catalog web pages and catalog API: search ranking, suggestions, playlists, album notes, artist pages, animated covers.',
        applePage: applePage,
        ampGet: ampGet,
        getAnimatedArtwork: getAnimatedArtwork,
    };
})();

const lyrics = (function () {

    // Port of the lyrics fetchers from AppleMusicReplica's LyricsService.swift.
    // Returns raw sheets (LRC / TTML / plain text); parsing is left to the app.

    const LOG_PREFIX = '[Lyrics]';
    const UA = 'AppleMusicReplica/1.0 (lyrics)';
    const TIMEOUT_MS = 8000; // Swift: timeoutIntervalForRequest = 8

    const VARIANT_WORDS = new Set([
        'remix', 'feat', 'featuring', 'with', 'live', 'version', 'edit',
        'explicit', 'clean', 'radio', 'demo', 'acoustic', 'instrumental',
        'bonus', 'deluxe', 'extended', 'pt', 'part', 'mix', 'bootleg',
        'cover', 'karaoke', 'sped', 'slowed', 'reverb', 'interlude',
    ]);

    // ---------- helpers ----------

    function q(params) {
        return Object.keys(params)
            .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
            .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
            .join('&');
    }

    // Fetch with the Swift session's UA + 8s timeout. Resolves to a Response or null.
    async function http(url, headers, timeoutMs) {
        var h = Object.assign({ 'User-Agent': UA }, headers || {});
        var timer;
        var timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, timeoutMs || TIMEOUT_MS); });
        try {
            return await Promise.race([fetch(url, { headers: h }).catch(function () { return null; }), timeout]);
        } finally { clearTimeout(timer); }
    }

    async function getText(url, headers, requireOk, timeoutMs) {
        var res = await http(url, headers, timeoutMs);
        if (!res) return null;
        if (requireOk && !res.ok) return null;
        try { return await res.text(); } catch (e) { return null; }
    }

    // Swift `decode`: JSON, tolerating a JSONP wrapper.
    function parseJSON(text) {
        if (!text) return null;
        try { return JSON.parse(text); } catch (e) { /* try JSONP */ }
        var o = text.indexOf('('), c = text.lastIndexOf(')');
        if (o < 0 || c <= o) return null;
        try { return JSON.parse(text.slice(o + 1, c)); } catch (e) { return null; }
    }

    async function getJSON(url, headers, requireOk, timeoutMs) {
        return parseJSON(await getText(url, headers, requireOk, timeoutMs));
    }

    // Swift decodeBase64 (ignoreUnknownCharacters, UTF-8 safe).
    function decodeBase64(text) {
        try {
            var bin = atob(text.replace(/[^A-Za-z0-9+/]/g, ''));
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (e) { return null; }
    }

    // "[" means LRC; otherwise try base64, else keep as-is.
    function sniffLRC(raw) {
        if (raw.indexOf('[') >= 0) return raw;
        var d = decodeBase64(raw);
        return d === null ? raw : d;
    }

    // Swift parseLRC "has lines": some non-empty content after stripping time tags.
    function hasLRCLines(text) {
        var lines = String(text).split('\n');
        for (var i = 0; i < lines.length; i++) {
            var c = lines[i].replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').trim();
            if (c && c.charAt(0) !== '[') return true;
        }
        return false;
    }

    function isSyncedLRC(text) { return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text); }

    function lrcFormat(text) { return isSyncedLRC(text) ? 'lrc' : 'plain'; }

    function stripVersionTag(raw) {
        return raw.replace(/[(\[{]\s*v\s*\d+\s*[)\]}]/gi, '').replace(/\s+v\s*\d+\s*$/i, '').trim();
    }

    function stripEmoji(raw) {
        var out = '';
        for (var ch of raw) {
            var cp = ch.codePointAt(0);
            if (cp === 0xFE0F || cp === 0x200D) continue;
            if (/\p{Emoji_Presentation}/u.test(ch)) continue;
            if (cp >= 0x2600 && /\p{Emoji}/u.test(ch)) continue;
            out += ch;
        }
        return out.trim();
    }

    function sanitize(raw) {
        return stripEmoji(stripVersionTag(raw || '')).replace(/\s+/g, ' ').trim();
    }

    function normalized(t) {
        return String(t || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    }

    function isAlnum(ch) { return /[\p{L}\p{N}]/u.test(ch); }

    function prefixOK(remainder) {
        var t = remainder.trim();
        if (!t) return true;
        if (!/[\p{L}\p{N}]/u.test(t)) return true;
        if (t.charAt(0) === '(') return true;
        var m = /^[^\p{L}\p{N}]*([\p{L}\p{N}]*)/u.exec(t);
        return VARIANT_WORDS.has((m ? m[1] : '').toLowerCase());
    }

    function titleMatches(candidate, titles) {
        if (!candidate) return false;
        var name = normalized(candidate);
        if (!name) return false;
        return titles.some(function (title) {
            var want = normalized(title);
            if (!want) return false;
            if (name === want) return true;
            if (name.startsWith(want) && prefixOK(name.slice(want.length))) return true;
            if (want.startsWith(name) && prefixOK(want.slice(name.length))) return true;
            return false;
        });
    }

    function titleCandidates(title) {
        var t = (title || '').trim();
        var cut = t.search(/[(\[]/);
        if (cut < 0) return [t];
        var head = t.slice(0, cut).trim();
        return head ? [t, head] : [t];
    }

    function cleanedArtist(a) {
        var t = (a || '').trim();
        return t.toLowerCase().endsWith(' - topic') ? t.slice(0, -' - topic'.length).trim() : t;
    }

    function artistCandidates(artist) {
        var base = cleanedArtist(artist);
        var names = base.split(/[,\/&;.]/).map(function (s) { return s.trim(); })
            .filter(function (s) { return Array.from(s).length >= 2; });
        var split = [];
        names.forEach(function (n) {
            var i = n.indexOf(' x ');
            if (i < 0) split.push(n); else { split.push(n.slice(0, i)); split.push(n.slice(i + 3)); }
        });
        return [base].concat(split.filter(function (n) { return n !== base; }));
    }

    function nameMatches(names, artists) {
        return artists.some(function (a) {
            var want = normalized(a);
            if (!want) return false;
            return names.some(function (n) { return n === want || (want.length >= 5 && n.indexOf(want) >= 0); });
        });
    }

    function rankName(songname, want) {
        var s = 0;
        if (songname) {
            var n = normalized(songname);
            if (n === want) s += 60;
            else if (n.startsWith(want) || want.startsWith(n)) s += 30;
        }
        return s;
    }

    function bestBy(list, score) {
        var best = null, bs = -Infinity;
        list.forEach(function (e) { var s = score(e); if (s >= bs) { best = e; bs = s; } }); // max: last wins ties, like Swift
        return best;
    }

    function sheet(source, format, body, translation) {
        return { source: source, format: format, body: body, translation: translation || null };
    }

    // ---------- providers ----------

    async function lyricsOvh(t) {
        var artist = sanitize(t.artist), title = sanitize(t.title);
        if (!artist || !title) return null;
        var res = await getJSON('https://api.lyrics.ovh/v1/' + encodeURIComponent(artist) + '/' + encodeURIComponent(title), null, false);
        var text = res && typeof res.lyrics === 'string' ? res.lyrics.trim() : '';
        return text ? sheet('lyrics.ovh', 'plain', text) : null;
    }

    async function unison(t) {
        var id = t.youtubeId && String(t.youtubeId).trim();
        if (!id || id.length !== 11 || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
        var j = await getJSON('https://unison.boidu.dev/lyrics?' + q({ v: id }), null, true);
        var p = j && j.success === true && j.data;
        var body = p && p.lyrics;
        if (!body) return null;
        if ((p.format || '').toLowerCase() === 'ttml' || body.indexOf('<tt') >= 0) return sheet('Unison', 'ttml', body);
        return hasLRCLines(body) ? sheet('Unison', lrcFormat(body), body) : null;
    }

    async function searchISRC(t) {
        var artist = t.artist || '';
        var query = [t.title].concat(artist ? [artist] : []).join(' ');
        if (!query) return null;
        var j = await getJSON('https://api.deezer.com/search/track?' + q({ q: query, limit: '5' }), null, true);
        var tracks = j && j.data;
        if (!tracks || !tracks.length) return null;
        var wantArtist = artist.toLowerCase(), want = t.duration || 0;
        var close = tracks.find(function (x) {
            if (!x.isrc) return false;
            var an = ((x.artist && x.artist.name) || '').toLowerCase();
            if (!(an.indexOf(wantArtist) >= 0 || !wantArtist)) return false;
            if (typeof x.duration !== 'number' || !(want > 0)) return true;
            return Math.abs(x.duration - want) <= 4;
        });
        if (close) return close.isrc;
        var any = tracks.find(function (x) { return x.isrc; });
        return any ? any.isrc : null;
    }

    async function resolveISRC(t) {
        return t.isrc ? t.isrc : await searchISRC(t);
    }

    function hasTTML(s) { return /<p[\s>]/.test(s); }
    function isWordSynced(ttml) { return /<p[\s>][\s\S]*?<span[^>]*\sbegin=/.test(ttml); }

    async function biniByISRC(t, isrc) {
        if (!isrc) return null;
        var ttml = await getText('https://lrc.red/s/' + encodeURIComponent(isrc) + '.ttml', null, true);
        return ttml && hasTTML(ttml) ? sheet('Bini', 'ttml', ttml) : null;
    }

    async function biniSearch(t) {
        var title = sanitize(t.title), artist = sanitize(t.artist);
        if (!title) return null;
        var j = await getJSON('https://lyrics-api.binimum.org/getLyrics?' + q({ q: [title].concat(artist ? [artist] : []).join(' ') }), null, true);
        var results = j && j.results;
        if (!results || !results.length) return null;
        var want = t.duration || 0;
        var word = function (e) { return String(e.timing_type || '').toLowerCase() === 'word' ? 0 : 1; };
        var gap = function (e) { return typeof e.duration === 'number' ? Math.abs(e.duration - want) : Infinity; };
        var ranked = results.slice().sort(function (a, b) { return word(a) - word(b) || (gap(a) - gap(b) || 0); });
        for (var i = 0; i < Math.min(3, ranked.length); i++) {
            if (!ranked[i].lyricsUrl) continue;
            var ttml = await getText(ranked[i].lyricsUrl, null, true);
            if (ttml && hasTTML(ttml)) return sheet('Bini', 'ttml', ttml);
        }
        return null;
    }

    async function qqMatch(t) {
        var titles = titleCandidates(t.title), title = titles[0] || t.title;
        var artists = artistCandidates(t.artist);
        var want = normalized(titles[0] || t.title);
        for (var i = 0; i < artists.length; i++) {
            var url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' + q({
                w: (title + ' ' + artists[i]).trim(), format: 'json', n: '8', p: '1' });
            var j = await getJSON(url, { Referer: 'https://y.qq.com/' }, false);
            var list = j && j.data && j.data.song && j.data.song.list;
            if (!list || !list.length) continue;
            var cands = list.filter(function (e) {
                var names = (e.singer || []).map(function (s) { return normalized(s.name); }).filter(Boolean);
                return titleMatches(e.songname, titles) && names.length && nameMatches(names, artists);
            });
            var best = bestBy(cands, function (e) {
                var s = rankName(e.songname, want);
                s -= (t.duration != null && typeof e.interval === 'number') ? Math.abs(e.interval - t.duration) : 5;
                return s;
            });
            if (best && best.songmid) return best.songmid;
        }
        return null;
    }

    async function qq(t) {
        var mid = await qqMatch(t);
        if (!mid) return null;
        var j = await getJSON('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' + q({
            songmid: mid, format: 'json', nobase64: '1', g_tk: '5381' }), { Referer: 'https://y.qq.com/' }, false);
        if (!j || !j.lyric) return null;
        var text = sniffLRC(j.lyric);
        if (!hasLRCLines(text)) return null;
        var trans = null;
        if (j.trans) {
            var tt = sniffLRC(j.trans);
            if (hasLRCLines(tt)) trans = tt;
        }
        return sheet('QQ Music', lrcFormat(text), text, trans);
    }

    async function kugouMatch(t) {
        var titles = titleCandidates(t.title), title = titles[0] || t.title;
        var artists = artistCandidates(t.artist);
        var want = normalized(titles[0] || t.title);
        for (var i = 0; i < artists.length; i++) {
            var p = { ver: '1', man: 'yes', client: 'pc', keyword: (title + ' ' + artists[i]).trim(), hash: '' };
            if (t.duration != null) p.duration = String(Math.round(t.duration * 1000));
            var j = await getJSON('https://lyrics.kugou.com/search?' + q(p), null, false);
            var list = j && j.candidates;
            if (!list || !list.length) continue;
            var cands = list.filter(function (e) {
                return e.id != null && e.accesskey != null && titleMatches(e.song, titles)
                    && e.singer && normalized(e.singer) && nameMatches([normalized(e.singer)], artists);
            });
            var best = bestBy(cands, function (e) {
                var s = rankName(e.song, want);
                s -= (t.duration != null && typeof e.duration === 'number') ? Math.abs(e.duration / 1000 - t.duration) : 5;
                return s;
            });
            if (best) return best;
        }
        return null;
    }

    async function kugou(t) {
        var m = await kugouMatch(t);
        if (!m) return null;
        var j = await getJSON('https://lyrics.kugou.com/download?' + q({
            ver: '1', client: 'pc', id: m.id, accesskey: m.accesskey, fmt: 'lrc', charset: 'utf8' }), null, false);
        if (!j || !j.content) return null;
        var text = sniffLRC(j.content);
        return hasLRCLines(text) ? sheet('KuGou', lrcFormat(text), text) : null;
    }

    function lrclibSheet(r) {
        if (r.syncedLyrics && hasLRCLines(r.syncedLyrics)) return sheet('LRCLIB', 'lrc', r.syncedLyrics);
        if (r.plainLyrics) return sheet('LRCLIB', 'plain', r.plainLyrics);
        return null;
    }

    async function lrclibGet(t, title, artist) {
        var p = { artist_name: artist, track_name: title };
        if (t.album) p.album_name = t.album;
        if (t.duration != null) p.duration = String(Math.round(t.duration));
        var j = await getJSON('https://lrclib.net/api/get?' + q(p), null, true);
        var found = j && lrclibSheet(j);
        if (found) return found;
        if (t.album) {
            delete p.album_name;
            j = await getJSON('https://lrclib.net/api/get?' + q(p), null, true);
            return j ? lrclibSheet(j) : null;
        }
        return null;
    }

    async function lrclibSearch(t, title, artist) {
        var results = await getJSON('https://lrclib.net/api/search?' + q({ track_name: title, artist_name: artist }), null, true);
        if (!Array.isArray(results) || !results.length) return null;
        var titles = titleCandidates(t.title);
        var rank = function (r) {
            var s = r.syncedLyrics ? 100 : 0;
            s -= (t.duration != null && typeof r.duration === 'number') ? Math.abs(r.duration - t.duration) : 5;
            return s;
        };
        var sorted = results.slice().sort(function (a, b) { return rank(b) - rank(a); });
        for (var i = 0; i < sorted.length; i++) {
            if (!titleMatches(sorted[i].trackName, titles)) continue;
            var f = lrclibSheet(sorted[i]);
            if (f) return f;
        }
        return null;
    }

    async function lrclib(t) {
        var titles = titleCandidates(t.title), artists = artistCandidates(t.artist), a, k, r;
        for (a = 0; a < artists.length; a++) for (k = 0; k < titles.length; k++) {
            if (!titles[k]) continue;
            if ((r = await lrclibGet(t, titles[k], artists[a]))) return r;
        }
        for (a = 0; a < artists.length; a++) for (k = 0; k < titles.length; k++) {
            if (!titles[k]) continue;
            if ((r = await lrclibSearch(t, titles[k], artists[a]))) return r;
        }
        return null;
    }

    // A failing provider never fails the call.
    async function safe(name, fn) {
        try { return await fn(); } catch (e) { console.log(LOG_PREFIX, name, 'failed', e && e.message); return null; }
    }

    async function getLyrics(input) {
        var t = {
            title: String((input && input.title) || ''),
            artist: String((input && input.artist) || ''),
            album: (input && input.album) || null,
            duration: input && typeof input.duration === 'number' && input.duration > 0 ? input.duration : null,
            isrc: (input && input.isrc) || null,
            youtubeId: (input && input.youtubeId) || null,
        };
        var mode = (input && input.mode) || 'best';

        if (mode === 'manual') {
            // manualSearch sanitizes title/artist first.
            var m = Object.assign({}, t, { title: sanitize(t.title) || t.title, artist: sanitize(t.artist) || t.artist, album: null });
            var out = [];
            for (var f of [['QQ', qq], ['KuGou', kugou], ['LRCLIB', lrclib]]) {
                var r = await safe(f[0], function () { return f[1](m); });
                if (r) out.push(r);
            }
            return out;
        }

        var all = mode === 'all';
        var sheets = [];
        var hit = function (s) { if (s) sheets.push(s); return !!s; };

        if (hit(await safe('Unison', function () { return unison(t); })) && !all) return sheets;
        var isrc = await safe('ISRC', function () { return resolveISRC(t); });
        if (hit(await safe('BiniISRC', function () { return biniByISRC(t, isrc); })) && !all) return sheets;
        var biniFallback = null;
        var bini = await safe('Bini', function () { return biniSearch(t); });
        if (bini) {
            if (all) sheets.push(bini);
            else if (isWordSynced(bini.body)) return [bini];
            else biniFallback = bini;
        }
        if (hit(await safe('QQ', function () { return qq(t); })) && !all) return sheets;
        if (hit(await safe('KuGou', function () { return kugou(t); })) && !all) return sheets;
        if (hit(await safe('LRCLIB', function () { return lrclib(t); })) && !all) return sheets;
        if (hit(await safe('lyrics.ovh', function () { return lyricsOvh(t); })) && !all) return sheets;
        if (!all && biniFallback) return [biniFallback];
        return sheets;
    }

    // ---------- Genius meanings (network half only; fragment-to-line matching stays in the app) ----------

    const GENIUS_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'application/json',
    };

    async function geniusSongID(t) {
        var title = titleCandidates(t.title)[0] || t.title;
        var query = (title + ' ' + cleanedArtist(t.artist)).trim();
        if (!query) return null;
        var j = await getJSON('https://genius.com/api/search/multi?' + q({ q: query }), GENIUS_HEADERS, true, 10000);
        var sections = j && j.response && j.response.sections;
        if (!sections) return null;
        // First song-typed hit across sections, in the site's order.
        for (var s of sections) for (var h of (s.hits || [])) {
            if (h.type === 'song') return h.result && h.result.id != null ? h.result.id : null;
        }
        return null;
    }

    function annotationWeight(a) {
        var py = a.pyongs_count != null ? a.pyongs_count : (a.pyong_count || 0);
        return py * 100 + (a.votes_total || 0);
    }

    function bestAnnotation(list) {
        var best = null, bw = -Infinity;
        (list || []).forEach(function (a) {
            var plain = a && a.body && a.body.plain;
            if (a.deleted === true || !plain) return;
            var w = annotationWeight(a);
            if (w > bw) { best = plain; bw = w; } // strict >: first maximal wins, like Swift
        });
        return best;
    }

    async function getMeanings(input) {
        try {
            var t = { title: String((input && input.title) || ''), artist: String((input && input.artist) || '') };
            var id = await geniusSongID(t);
            if (id == null) return [];
            var j = await getJSON('https://genius.com/api/referents?' + q({ song_id: String(id), text_format: 'plain' }), GENIUS_HEADERS, true, 10000);
            var raw = j && j.response && j.response.referents;
            if (!Array.isArray(raw)) return [];
            var out = [];
            raw.forEach(function (r) {
                var fragment = typeof r.fragment === 'string' ? r.fragment.trim() : '';
                var body = bestAnnotation(r.annotations);
                body = body ? body.trim() : '';
                if (fragment && body) out.push({ fragment: fragment, meaning: body });
            });
            return out;
        } catch (e) { console.log(LOG_PREFIX, 'genius failed', e && e.message); return []; }
    }
    return {
        id: 'backroom-lyrics',
        name: 'Lyrics',
        version: '1.0.0',
        type: 'LYRICS',
        description: 'Synced lyrics from Unison, Bini, QQ Music, KuGou, LRCLIB and lyrics.ovh, plus Genius meanings.',
        getLyrics: getLyrics,
        getMeanings: getMeanings,
    };
})();

const trackers = (function () {

    // Community music trackers: where the artist list, tracker sheets and artist images live,
    // and how a tracker's file links turn into playable URLs.

    function match(s, re) { const m = re.exec(s); return m ? m[1] : null; }

    function normalize(url) { return String(url || '').replace('pillowcase.su', 'pillows.su'); }

    async function json(url) {
        try {
            const res = await Promise.race([fetch(url), new Promise(function (r) { setTimeout(function () { r(null); }, 8000); })]);
            return res && res.status >= 200 && res.status < 300 ? await res.json() : null;
        } catch (e) { return null; }
    }

    // One link -> playable URL string, or null. Most hosts are pure URL construction.
    async function resolveOne(raw) {
        const url = normalize(raw);
        let id;
        if (/https?:\/\/pillows\.su\/f\//.test(url)) {
            id = match(url, /pillows\.su\/f\/([a-f0-9]+)/);
            return id ? 'https://api.pillows.su/api/download/' + id : null;
        }
        if (/https?:\/\/(?:www\.|music\.)?youtube\.com\/|https?:\/\/youtu\.be\//.test(url)) return null;
        if (/https?:\/\/pixeldrain\.com\/[du]\//.test(url)) {
            id = match(url, /pixeldrain\.com\/[du]\/([a-zA-Z0-9]+)/);
            return id ? 'https://fuck-unvaulted.artistgrid.cx/' + id : null;
        }
        if (/https?:\/\/juicewrldapi\.com\/juicewrld/.test(url)) return url;
        if (/https?:\/\/.*imgur\.gg/.test(url)) {
            id = match(url, /\/f\/([a-zA-Z0-9]+)/) || match(url, /\/([a-zA-Z0-9]+)(?:\?|$)/);
            if (!id) return null;
            const f = await json('https://imgur.gg/api/file/' + id);
            if (!f) return null;
            const type = f.mediaType || f.mimeType || f.type || '';
            if (type.indexOf('image/') === 0) return null;
            return f.cdnUrl || f.url || null;
        }
        if (/https?:\/\/(www\.)?soundcloud\.com\//.test(url)) {
            const path = match(url, /soundcloud\.com\/([^/]+\/[^/?#]+)/);
            return path ? 'https://sc.monochrome.tf/_/restream/' + path : null;
        }
        if (/https?:\/\/drive\.google\.com\/file\/d\//.test(url)) {
            id = match(url, /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
            return id ? 'https://fuck-unvaulted.artistgrid.cx/gd/' + id : null;
        }
        if (/https?:\/\/(?:www\.)?exoshare\.org\/share\//.test(url)) {
            id = match(url, /exoshare\.org\/share\/([^/?#]+)/);
            if (!id) return null;
            const p = await json('https://fuck-unvaulted.artistgrid.cx/exo/' + id);
            const file = p && (p.files || []).map(function (x) { return x && x.id; }).find(function (x) { return x; });
            return file ? 'https://fuck-unvaulted.artistgrid.cx/exo/' + id + '/files/' + file : null;
        }
        return null;
    }

    function needsNetwork(url) { return /imgur\.gg|exoshare\.org\/share\//.test(normalize(url)); }

    // A track's links -> the first playable URL. Cheap hosts in order first, then the
    // network hosts race (first success wins).
    async function resolveLinks(urls) {
        urls = (urls || []).map(String);
        for (const u of urls) {
            if (!needsNetwork(u)) { const r = await resolveOne(u); if (r) return r; }
        }
        const net = urls.filter(needsNetwork);
        if (!net.length) return null;
        return new Promise(function (resolve) {
            let left = net.length;
            net.forEach(function (u) {
                resolveOne(u).then(function (r) {
                    if (r) resolve(r);
                    else if (--left === 0) resolve(null);
                }, function () { if (--left === 0) resolve(null); });
            });
        });
    }
    return {
        id: 'trackers',
        name: 'Trackers',
        version: '1.0.0',
        type: 'TRACKER',
        description: 'Community music trackers: artists, eras and playable links.',
        trackerBaseURL: 'https://trackerapi.artistgrid.cx',
        artistsCSVURL: 'https://artists.artistgrid.cx/artists.csv',
        assetsBaseURL: 'https://assets.artistgrid.cx',
        resolveLinks: resolveLinks,
    };
})();

const META = ['id', 'name', 'version', 'type', 'description'];
function strip(o) { const c = Object.assign({}, o); META.forEach(function (k) { delete c[k]; }); return c; }

return Object.assign(strip(web), strip(lyrics), strip(trackers), {
    id: 'web-catalog',
    name: 'Web Catalog',
    version: '2.0.0',
    type: 'WEB',
    description: 'Catalog pages and API (search, playlists, artist pages, animated covers), synced lyrics and meanings, and community trackers.',
});
