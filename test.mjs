import fs from 'fs';
const mod = new Function('AsyncStorage', fs.readFileSync(new URL('./modules/web.js', import.meta.url), 'utf8'))({});
const s = await mod.applePage('us/search?term=kanye%20west');
console.log('search', s && s.length, s && s.includes('serialized-server-data'));
const a = await mod.applePage('us/artist/x/2715720?uo=4');
console.log('artist', a && a.length);
console.log('reject', await mod.applePage('https://evil.example/x'));
