// J.J. Barber v2 - Node >= 22.13, sin dependencias
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const PORT = process.env.PORT || 3000, HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PUB = path.join(import.meta.dirname, 'public');
const db = new DatabaseSync(path.join(import.meta.dirname, 'jonard.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, name TEXT, category TEXT, price REAL, minutes INT, active INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, start_h INT DEFAULT 9, end_h INT DEFAULT 20, active INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS staff_services(staff_id INT, service_id INT, PRIMARY KEY(staff_id, service_id));
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, first TEXT, last TEXT, address TEXT, email TEXT, phone TEXT, gender TEXT, birthday TEXT, last_visit INT, last_bday_msg TEXT);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, customer_id INT, service_id INT, staff_id INT, start_ts INT, end_ts INT, status TEXT, price REAL, created_ts INT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, phone TEXT, body TEXT, ts INT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);`);
for (const q of ['ALTER TABLE staff ADD COLUMN username TEXT', 'ALTER TABLE staff ADD COLUMN pass TEXT', 'ALTER TABLE staff ADD COLUMN kids INT DEFAULT 0', 'ALTER TABLE tickets ADD COLUMN minor INT DEFAULT 0', "ALTER TABLE tickets ADD COLUMN source TEXT DEFAULT 'kiosco'"]) try { db.exec(q); } catch {}
// Limpieza de duplicados existentes + índice único
db.exec(`UPDATE tickets SET customer_id=(SELECT MIN(c2.id) FROM customers c2 WHERE c2.phone=(SELECT phone FROM customers WHERE id=tickets.customer_id)) WHERE customer_id IN (SELECT id FROM customers);
DELETE FROM customers WHERE id NOT IN (SELECT MIN(id) FROM customers GROUP BY phone);
UPDATE tickets SET status='cancelled' WHERE status IN('pending_payment','paid') AND id NOT IN (SELECT MIN(id) FROM tickets WHERE status IN('pending_payment','paid') GROUP BY customer_id,service_id,staff_id,start_ts);
UPDATE tickets SET status='cancelled' WHERE status='pending_payment' AND id NOT IN (SELECT MIN(id) FROM tickets WHERE status='pending_payment' GROUP BY customer_id,service_id);`);
db.exec("UPDATE services SET active=0 WHERE IFNULL(name,'')='' OR IFNULL(minutes,0)<=0");
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_phone ON customers(phone)'); } catch (e) { console.log('Aviso índice:', e.message); }
if (!db.prepare('SELECT COUNT(*) c FROM services').get().c) {
  const s = db.prepare('INSERT INTO services(name,category,price,minutes) VALUES(?,?,?,?)');
  [['Corte clásico','corte',8000,30],['Corte + barba','corte',11000,45],['Lavado','lavado',4000,15],['Colorimetría','color',25000,90]].forEach(x => s.run(...x));
  const st = db.prepare('INSERT INTO staff(name,phone,kids) VALUES(?,?,?)'), l = db.prepare('INSERT INTO staff_services VALUES(?,?)');
  st.run('Jonard','',0); st.run('Marcos','',1); st.run('Lucía','',0);
  [[1,1],[1,2],[1,3],[2,1],[2,2],[3,3],[3,4],[3,1]].forEach(x => l.run(...x));
}
// ---------- Seguridad ----------
const hash = (p, s = crypto.randomBytes(8).toString('hex')) => s + ':' + crypto.scryptSync(String(p), s, 32).toString('hex');
const check = (p, h) => { try { const [s, x] = (h || '').split(':'); return crypto.timingSafeEqual(Buffer.from(hash(p, s).split(':')[1]), Buffer.from(x)); } catch { return false; } };
const getS = k => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v, setS = (k, v) => db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, v);
if (process.env.ADMIN_PASS) setS('admin', hash(process.env.ADMIN_PASS));
else if (!getS('admin')) { const pw = crypto.randomBytes(5).toString('hex'); setS('admin', hash(pw)); console.log(`\n*** CONTRASEÑA ADMIN (usuario: admin): ${pw}  ← anotala. Para cambiarla: ADMIN_PASS=nueva ***\n`); }
const sessions = new Map(), tries = new Map(), hits = new Map(), DEMO = process.env.DEMO_PAY === '1';
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
const rl = req => { const k = ipOf(req), n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < 6e5); a.push(n); hits.set(k, a); return a.length > 12; };
const auth = (req, role) => { const s = sessions.get((req.headers.authorization || '').slice(7)); return s && s.exp > Date.now() && s.role === role ? s : null; };
// ---------- Mensajería (reemplazar por WhatsApp Cloud API / Twilio) ----------
function send(phone, body) {
  db.prepare('INSERT INTO messages(phone,body,ts) VALUES(?,?,?)').run(phone, body, Date.now()); console.log(`[MSG → ${phone}] ${body}`);
  if (process.env.WA_WEBHOOK) fetch(process.env.WA_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, body }) }).catch(() => {});
}
const hhmm = t => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
// Aviso al dueño por WhatsApp (CallMeBot: OWNER_PHONE=54911XXXXXXXX CALLMEBOT_KEY=xxxx)
function notifyOwner(text) {
  db.prepare('INSERT INTO messages(phone,body,ts) VALUES(?,?,?)').run('DUEÑO', text, Date.now()); console.log('[AVISO DUEÑO]', text);
  const ph = process.env.OWNER_PHONE, key = process.env.CALLMEBOT_KEY;
  if (ph && key) fetch(`https://api.callmebot.com/whatsapp.php?phone=${ph}&text=${encodeURIComponent(text)}&apikey=${key}`).catch(e => console.log('CallMeBot error:', e.message));
}
const ymd = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = ts => new Date(ts).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
// Horarios libres de un día (cada 30 min) y profesional menos cargado para cada uno
function slotsFor(svcId, minor, dateStr) {
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(svcId); if (!svc) return null;
  const cands = db.prepare('SELECT s.* FROM staff s JOIN staff_services ss ON ss.staff_id=s.id WHERE ss.service_id=? AND s.active=1 AND (?=0 OR s.kids=1)').all(svcId, minor ? 1 : 0);
  const [y, mo, d] = dateStr.split('-').map(Number), now = Date.now(), out = new Map();
  for (const p of cands) {
    const open = new Date(y, mo - 1, d, p.start_h).getTime(), close = new Date(y, mo - 1, d, p.end_h).getTime();
    const busy = db.prepare("SELECT start_ts,end_ts FROM tickets WHERE staff_id=? AND status IN('pending_payment','paid') AND end_ts>? AND start_ts<?").all(p.id, open, close);
    for (let t = open; t + svc.minutes * 6e4 <= close; t += 18e5) {
      if (t < now) continue; const e = t + svc.minutes * 6e4; if (busy.some(b => b.start_ts < e && b.end_ts > t)) continue;
      const o = out.get(t) || []; o.push({ id: p.id, load: busy.length }); out.set(t, o);
    }
  }
  return { svc, slots: [...out.entries()].sort((a, b) => a[0] - b[0]).map(([ts, o]) => ({ ts, label: hhmm(ts), staff: o.sort((a, b) => a.load - b.load)[0].id })) };
}
// ---------- AGENTE ENRUTADOR ----------
function route(serviceId, minor) {
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(serviceId); if (!svc) return null;
  const now = Date.now(), cands = db.prepare('SELECT s.* FROM staff s JOIN staff_services ss ON ss.staff_id=s.id WHERE ss.service_id=? AND s.active=1 AND (?=0 OR s.kids=1)').all(serviceId, minor ? 1 : 0);
  let best = null;
  for (const p of cands) {
    const d = new Date(), open = new Date(d).setHours(p.start_h, 0, 0, 0), close = new Date(d).setHours(p.end_h, 0, 0, 0);
    const B = db.prepare("SELECT start_ts s,end_ts e FROM tickets WHERE staff_id=? AND status IN('pending_payment','paid') AND end_ts>? ORDER BY start_ts").all(p.id, now);
    let start = Math.max(now, open); for (const b of B) if (b.s < start + svc.minutes * 60000 && b.e > start) start = b.e;
    const end = start + svc.minutes * 60000;
    if (end > close) continue;
    if (!best || start < best.start) best = { staff: p, start, end, svc };
  }
  return best;
}
const cleanup = () => db.prepare("UPDATE tickets SET status='cancelled' WHERE status='pending_payment' AND created_ts<?").run(Date.now() - 10 * 60000);
function markPaid(id) {
  const t = db.prepare("SELECT t.*,c.first,c.last,c.phone,s.name sname,p.name pname FROM tickets t JOIN customers c ON c.id=t.customer_id JOIN services s ON s.id=t.service_id JOIN staff p ON p.id=t.staff_id WHERE t.id=?").get(id);
  if (!t || t.status === 'paid') return t; if (t.status !== 'pending_payment') return null;
  db.prepare("UPDATE tickets SET status='paid' WHERE id=?").run(id); db.prepare('UPDATE customers SET last_visit=? WHERE id=?').run(Date.now(), t.customer_id);
  send(t.phone, `✂️ J.J. Barber\nComprobante #${id}\nHola ${t.first}, recibimos tu pago de $${t.price}.\nServicio: ${t.sname}\nProfesional: ${t.pname}\nHorario: ${dayLabel(t.start_ts)} ${hhmm(t.start_ts)} hs\n¡Te esperamos!`);
  notifyOwner(`💈 ${t.source === 'online' ? '🌐 Reserva ONLINE' : '🖥 Kiosco'} pagada\nCliente: ${t.first} ${t.last} (${t.phone})${t.minor ? ' 🧒 menor' : ''}\nServicio: ${t.sname} $${t.price}\nProfesional: ${t.pname}\nCuándo: ${dayLabel(t.start_ts)} ${hhmm(t.start_ts)} hs`);
  return { ...t, status: 'paid' };
}
function reminders() {
  const today = new Date().toISOString().slice(5, 10), year = String(new Date().getFullYear());
  for (const c of db.prepare("SELECT * FROM customers WHERE substr(birthday,6,5)=? AND IFNULL(last_bday_msg,'')<>?").all(today, year)) { send(c.phone, `🎂 ¡Feliz cumpleaños ${c.first}! De parte de J.J. Barber.`); db.prepare('UPDATE customers SET last_bday_msg=? WHERE id=?').run(year, c.id); }
}
setInterval(() => { cleanup(); reminders(); }, 3600000); reminders();
// ---------- Agenda del profesional ----------
function agenda(id) {
  const p = db.prepare('SELECT * FROM staff WHERE id=?').get(id), now = Date.now(), d = new Date();
  const day0 = new Date(d).setHours(0, 0, 0, 0), open = new Date(d).setHours(p.start_h, 0, 0, 0), close = new Date(d).setHours(p.end_h, 0, 0, 0);
  const T = db.prepare("SELECT t.start_ts,t.end_ts,t.status,t.minor,s.name service,c.first,c.last FROM tickets t JOIN services s ON s.id=t.service_id JOIN customers c ON c.id=t.customer_id WHERE t.staff_id=? AND t.status IN('paid','pending_payment') AND t.start_ts>=? AND t.start_ts<? ORDER BY t.start_ts").all(id, day0, day0 + 864e5);
  const gaps = []; let cur = Math.max(now, open);
  for (const t of T) { if (t.end_ts <= cur) continue; if (t.start_ts > cur + 9e5) gaps.push(`${hhmm(cur)} a ${hhmm(t.start_ts)}`); cur = Math.max(cur, t.end_ts); }
  if (close > cur + 9e5) gaps.push(`${hhmm(cur)} a ${hhmm(close)}`);
  const act = T.find(t => t.status === 'paid' && t.start_ts <= now && now < t.end_ts);
  return { name: p.name, shift: `${p.start_h}:00 a ${p.end_h}:00`, state: act ? `Atendiendo a ${act.first} hasta ${hhmm(act.end_ts)}` : 'Libre ahora', gaps,
    tickets: T.map(t => ({ time: `${hhmm(t.start_ts)}–${hhmm(t.end_ts)}`, customer: `${t.first} ${(t.last || '')[0] || ''}.`, service: t.service, minor: !!t.minor, status: t.status, past: t.end_ts < now })) };
}
// ---------- HTTP ----------
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const J = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, PUBLIC_URL), p = u.pathname, m = req.method; let mm;
  try {
    if (p === '/api/login' && m === 'POST') {
      const b = await body(req), ip = ipOf(req), L = tries.get(ip) || { n: 0, t: 0 };
      if (L.n >= 5 && Date.now() < L.t) return J(res, { error: 'Demasiados intentos. Esperá 1 minuto.' }, 429); if (Date.now() >= L.t) L.n = 0;
      let s = null;
      if (b.user === 'admin') { if (check(b.pass, getS('admin'))) s = { role: 'admin' }; }
      else { const r = db.prepare('SELECT id,pass FROM staff WHERE username=? AND active=1').get(String(b.user || '')); if (r && check(b.pass, r.pass)) s = { role: 'staff', id: r.id }; }
      if (!s) { tries.set(ip, { n: L.n + 1, t: Date.now() + 60000 }); return J(res, { error: 'Usuario o contraseña incorrectos' }, 401); }
      tries.delete(ip); const tk = crypto.randomBytes(24).toString('hex'); sessions.set(tk, { ...s, exp: Date.now() + 12 * 36e5 }); return J(res, { token: tk, role: s.role });
    }
    if (p === '/api/services' && m === 'GET') return J(res, db.prepare('SELECT * FROM services WHERE active=1').all());
    if (p === '/api/checkin' && m === 'POST') {
      if (rl(req)) return J(res, { error: 'Demasiados pedidos, esperá unos minutos' }, 429);
      const b = await body(req), c = b.customer || {}; c.phone = String(c.phone || '').replace(/\D/g, '');
      if (!c.first || !c.last || c.phone.length < 8 || !['M', 'F'].includes(c.gender) || !c.birthday) return J(res, { error: 'Faltan datos obligatorios' }, 400);
      cleanup(); const minor = b.minor ? 1 : 0;
      let cu = db.prepare('SELECT * FROM customers WHERE phone=?').get(c.phone);
      if (cu) db.prepare('UPDATE customers SET first=?,last=?,address=?,email=?,gender=?,birthday=? WHERE id=?').run(c.first, c.last, c.address || null, c.email || null, c.gender, c.birthday, cu.id);
      else cu = { id: db.prepare('INSERT INTO customers(first,last,address,email,phone,gender,birthday) VALUES(?,?,?,?,?,?,?)').run(c.first, c.last, c.address || null, c.email || null, c.phone, c.gender, c.birthday).lastInsertRowid };
      // Anti-duplicado: si ya hay un turno pendiente igual, se reutiliza
      const ex = db.prepare("SELECT t.*,p.name pn FROM tickets t JOIN staff p ON p.id=t.staff_id WHERE t.customer_id=? AND t.service_id=? AND t.minor=? AND t.status='pending_payment'").get(cu.id, b.serviceId, minor);
      if (ex) return J(res, { ticketId: ex.id, amount: ex.price, qr: `${PUBLIC_URL}/pay/${ex.id}`, professional: ex.pn, time: hhmm(ex.start_ts) });
      const r = route(b.serviceId, minor);
      if (!r) return J(res, { error: minor ? 'Hoy no hay especialista infantil disponible para este servicio' : 'Sin disponibilidad hoy para este servicio' }, 409);
      const id = db.prepare("INSERT INTO tickets(customer_id,service_id,staff_id,start_ts,end_ts,status,price,created_ts,minor) VALUES(?,?,?,?,?,'pending_payment',?,?,?)").run(cu.id, r.svc.id, r.staff.id, r.start, r.end, r.svc.price, Date.now(), minor).lastInsertRowid;
      return J(res, { ticketId: Number(id), amount: r.svc.price, qr: `${PUBLIC_URL}/pay/${id}`, professional: r.staff.name, time: hhmm(r.start) });
    }
    if (p === '/api/slots' && m === 'GET') { const d = u.searchParams.get('date') || ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return J(res, { error: 'Fecha inválida' }, 400); cleanup();
      const r = slotsFor(+u.searchParams.get('serviceId'), u.searchParams.get('minor') === '1', d);
      return r ? J(res, { slots: r.slots.map(({ ts, label }) => ({ ts, label })), price: r.svc.price, minutes: r.svc.minutes }) : J(res, { error: 'Servicio inexistente' }, 404); }
    if (p === '/api/book' && m === 'POST') {   // reserva online desde casa
      if (rl(req)) return J(res, { error: 'Demasiados pedidos, esperá unos minutos' }, 429);
      const b = await body(req), c = b.customer || {}; c.phone = String(c.phone || '').replace(/\D/g, '');
      if (!c.first || !c.last || c.phone.length < 8 || !['M', 'F'].includes(c.gender) || !c.birthday) return J(res, { error: 'Faltan datos obligatorios' }, 400);
      cleanup(); const minor = b.minor ? 1 : 0, ts = Number(b.ts);
      if (!(ts > Date.now() && ts < Date.now() + 15 * 864e5)) return J(res, { error: 'Fecha fuera de rango' }, 400);
      let cu = db.prepare('SELECT * FROM customers WHERE phone=?').get(c.phone);
      if (cu) db.prepare('UPDATE customers SET first=?,last=?,address=?,email=?,gender=?,birthday=? WHERE id=?').run(c.first, c.last, c.address || null, c.email || null, c.gender, c.birthday, cu.id);
      else cu = { id: db.prepare('INSERT INTO customers(first,last,address,email,phone,gender,birthday) VALUES(?,?,?,?,?,?,?)').run(c.first, c.last, c.address || null, c.email || null, c.phone, c.gender, c.birthday).lastInsertRowid };
      db.prepare("UPDATE tickets SET status='cancelled' WHERE customer_id=? AND status='pending_payment' AND source='online'").run(cu.id);
      const r = slotsFor(b.serviceId, minor, ymd(ts)), sl = r && r.slots.find(x => x.ts === ts);
      if (!sl) return J(res, { error: 'Ese horario ya no está disponible, elegí otro' }, 409);
      const id = db.prepare("INSERT INTO tickets(customer_id,service_id,staff_id,start_ts,end_ts,status,price,created_ts,minor,source) VALUES(?,?,?,?,?,'pending_payment',?,?,?,'online')").run(cu.id, r.svc.id, sl.staff, ts, ts + r.svc.minutes * 6e4, r.svc.price, Date.now(), minor).lastInsertRowid;
      return J(res, { ticketId: Number(id), amount: r.svc.price, payUrl: `${PUBLIC_URL}/pay/${id}`, professional: db.prepare('SELECT name FROM staff WHERE id=?').get(sl.staff).name, when: `${dayLabel(ts)} ${hhmm(ts)} hs` });
    }
    if (p === '/api/cancel' && m === 'POST') { const b = await body(req); db.prepare("UPDATE tickets SET status='cancelled' WHERE id=? AND status='pending_payment'").run(b.ticketId || 0); return J(res, { ok: true }); }
    if ((mm = p.match(/^\/api\/ticket\/(\d+)$/))) { const t = db.prepare('SELECT t.id,t.status,t.price,t.start_ts,p.name professional FROM tickets t JOIN staff p ON p.id=t.staff_id WHERE t.id=?').get(mm[1]); return t ? J(res, { ...t, time: hhmm(t.start_ts) }) : J(res, {}, 404); }
    if ((mm = p.match(/^\/pay\/(\d+)$/))) { if (!DEMO) return J(res, { error: 'Pasarela de pago no configurada' }, 503); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>J.J. Barber</h2><p>Pago de turno #${mm[1]}</p><button style="font-size:22px;padding:16px 32px" onclick="fetch('/api/webhook/payment',{method:'POST',body:JSON.stringify({ticketId:${mm[1]}})}).then(()=>document.body.innerHTML='<h2>✅ Pago acreditado</h2>')">Pagar ahora</button>`); }
    if (p === '/api/webhook/payment' && m === 'POST') { if (!DEMO) return J(res, { error: 'Pasarela de pago no configurada' }, 503); const b = await body(req); return J(res, { ok: !!markPaid(b.ticketId) }); }
    if (p === '/api/me/agenda') { const s = auth(req, 'staff'); return s ? J(res, agenda(s.id)) : J(res, { error: 'Sesión vencida' }, 401); }
    if (p.startsWith('/api/admin/')) {
      if (!auth(req, 'admin')) return J(res, { error: 'No autorizado' }, 401);
      if (p === '/api/admin/queue') return J(res, db.prepare("SELECT p.name professional, s.name service, c.first||' '||c.last customer, t.minor, t.status, t.start_ts, t.end_ts FROM tickets t JOIN staff p ON p.id=t.staff_id JOIN services s ON s.id=t.service_id JOIN customers c ON c.id=t.customer_id WHERE t.status='paid' AND t.end_ts>? ORDER BY p.name, t.start_ts").all(Date.now()).map(r => ({ ...r, start: hhmm(r.start_ts), end: hhmm(r.end_ts) })));
      if (p === '/api/admin/staff' && m === 'GET') return J(res, db.prepare('SELECT id,name,phone,start_h,end_h,active,username,kids FROM staff').all().map(s => ({ ...s, services: db.prepare('SELECT service_id FROM staff_services WHERE staff_id=?').all(s.id).map(x => x.service_id) })));
      if (p === '/api/admin/staff' && m === 'POST') { const b = await body(req); if (!b.name) return J(res, { error: 'Falta nombre' }, 400);
        const user = (b.username || '').trim().toLowerCase() || null; if (user === 'admin') return J(res, { error: 'Usuario reservado' }, 400);
        if (b.password && String(b.password).length < 6) return J(res, { error: 'La contraseña debe tener 6+ caracteres' }, 400);
        try { const id = b.id || Number(db.prepare('INSERT INTO staff(name) VALUES(?)').run(b.name).lastInsertRowid);
          db.prepare('UPDATE staff SET name=?,phone=?,start_h=?,end_h=?,active=?,username=?,kids=? WHERE id=?').run(b.name, b.phone || '', b.start_h ?? 9, b.end_h ?? 20, b.active ?? 1, user, b.kids ? 1 : 0, id);
          if (b.password) db.prepare('UPDATE staff SET pass=? WHERE id=?').run(hash(b.password), id);
          db.prepare('DELETE FROM staff_services WHERE staff_id=?').run(id); (b.services || []).forEach(sid => db.prepare('INSERT INTO staff_services VALUES(?,?)').run(id, sid)); return J(res, { id });
        } catch { return J(res, { error: 'Ese usuario ya existe' }, 409); } }
      if (p === '/api/admin/services' && m === 'POST') { const b = await body(req);
        if (b.del) { db.prepare('UPDATE services SET active=0 WHERE id=?').run(b.id); return J(res, { ok: true }); }
        if (!b.name || !(b.price > 0) || !(b.minutes > 0)) return J(res, { error: 'Completá nombre, precio y minutos' }, 400);
        if (b.id) db.prepare('UPDATE services SET name=?,category=?,price=?,minutes=?,active=? WHERE id=?').run(b.name, b.category, b.price, b.minutes, b.active ?? 1, b.id);
        else db.prepare('INSERT INTO services(name,category,price,minutes) VALUES(?,?,?,?)').run(b.name, b.category, b.price, b.minutes); return J(res, { ok: true }); }
      if (p === '/api/admin/messages') return J(res, db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 30').all());
      return J(res, { error: 'No encontrado' }, 404);
    }
    const f = path.join(PUB, p === '/' ? 'index.html' : p === '/admin' ? 'admin.html' : p === '/staff' ? 'staff.html' : p === '/reservar' ? 'reservar.html' : p);
    if (f.startsWith(PUB) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    J(res, { error: 'No encontrado' }, 404);
  } catch (e) { console.error(e); J(res, { error: 'Error interno' }, 500); }
}).listen(PORT, HOST, () => console.log(`J.J. Barber → Kiosco ${PUBLIC_URL} | Admin ${PUBLIC_URL}/admin | Profesionales ${PUBLIC_URL}/staff | Clientes ${PUBLIC_URL}/reservar${DEMO ? ' | PAGO DE PRUEBA ACTIVO' : ''}`));
