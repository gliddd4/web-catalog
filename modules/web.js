/* @8spine-meta
 * type: WEB
 * category: modules
 */

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
