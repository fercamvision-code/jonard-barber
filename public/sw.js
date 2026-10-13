self.addEventListener('install',e=>e.waitUntil(caches.open('jb1').then(c=>c.addAll(['/staff','/icon.svg']))));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api'))return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)))});
