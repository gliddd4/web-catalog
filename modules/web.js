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

return {
    id: 'web-catalog',
    name: 'Web Catalog',
    version: '1.0.0',
    type: 'WEB',
    description: 'Public catalog web pages: search ranking, playlists, album notes, artist pages.',
    applePage: applePage,
};
