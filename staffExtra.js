module.exports = function (router, ctx) {
  const { requireTechApiAuth, db, customerDevice, mikrotikService } = ctx;
  const express = require('express');
  const odpSvc = require('../services/odpService');
  const have = new Set(db.prepare('PRAGMA table_info(customers)').all().map(c => c.name));
  [['odp_port', 'INTEGER'], ['onu_serial', 'TEXT']].forEach(([n, t]) => {
    if (!have.has(n)) { try { db.exec('ALTER TABLE customers ADD COLUMN ' + n + ' ' + t); have.add(n); } catch (e) {} }
  });

  let cache = { t: 0, byTag: new Map(), byPppoe: new Map() };
  async function statuses() {
    if (Date.now() - cache.t < 60000) return cache;
    const byTag = new Map(), byPppoe = new Map();
    try {
      const r = await customerDevice.listAllDevices(999999);
      const act = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());
      if (r && r.ok) for (const d of r.devices) {
        let pu = '';
        try { pu = String(customerDevice.extractPppoeUser(d) || '').trim().toLowerCase(); } catch (e) {}
        const has = pu && pu !== 'n/a' && pu !== '-';
        let st = 'unknown';
        try { st = String(customerDevice.mapDeviceData(d, (d._tags && d._tags[0]) || d._id, !!(has && act.has(pu))).status || 'unknown').toLowerCase(); } catch (e) {}
        (d._tags || []).forEach(t => byTag.set(String(t).trim(), st));
        byTag.set(String(d._id), st);
        if (has) byPppoe.set(pu, st);
      }
    } catch (e) {}
    cache = { t: Date.now(), byTag, byPppoe };
    return cache;
  }

  router.get('/app/tech/map/overview', requireTechApiAuth, async (req, res) => {
    try {
      const st = await statuses();
      const cs = db.prepare("SELECT id, name, phone, address, status, lat, lng, odp_id, pppoe_username, genieacs_tag, cable_path FROM customers WHERE lat IS NOT NULL AND lng IS NOT NULL AND lat != '' AND lng != '' LIMIT 3000").all();
      cs.forEach(c => {
        const tag = String(c.genieacs_tag || '').trim(), pu = String(c.pppoe_username || '').trim().toLowerCase();
        c.onu = (tag && st.byTag.get(tag)) || (pu && st.byPppoe.get(pu)) || 'unknown';
      });
      const used = {};
      db.prepare('SELECT odp_id, COUNT(*) n FROM customers WHERE odp_id IS NOT NULL GROUP BY odp_id').all().forEach(r => { used[r.odp_id] = r.n; });
      const odps = (odpSvc.getAllOdps() || []).map(o => ({ id: o.id, name: o.name, lat: o.lat, lng: o.lng, port_capacity: o.port_capacity, description: o.description, used: used[o.id] || 0 }));
      res.json({ success: true, customers: cs, odps });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  router.get('/app/tech/customers/search', requireTechApiAuth, (req, res) => {
    try {
      const q = '%' + String(req.query.q || '').trim() + '%';
      const rows = db.prepare('SELECT id, name, phone, address, pppoe_username, genieacs_tag, odp_id FROM customers WHERE name LIKE ? OR pppoe_username LIKE ? OR phone LIKE ? ORDER BY name LIMIT 30').all(q, q, q);
      res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  router.post('/app/tech/odps/create', requireTechApiAuth, express.json(), (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.name || '').trim()) return res.status(400).json({ success: false, message: 'Nama ODP wajib diisi' });
      odpSvc.createOdp({ name: String(b.name).trim(), olt_id: b.olt_id || '', pon_port: b.pon_port || '', port_capacity: Number(b.port_capacity) || 16, lat: b.lat, lng: b.lng, description: b.description || '' });
      cache.t = 0;
      res.json({ success: true, message: 'ODP berhasil ditambahkan' });
    } catch (e) { res.status(500).json({ success: false, message: 'Gagal: ' + e.message }); }
  });

  router.post('/app/tech/customers/ont', requireTechApiAuth, express.json(), (req, res) => {
    try {
      const b = req.body || {};
      const id = Number(b.customerId);
      if (!id) return res.status(400).json({ success: false, message: 'Pelanggan belum dipilih' });
      const map = { genieacs_tag: b.tag, onu_serial: b.serial, odp_id: b.odp_id, odp_port: b.odp_port, lat: b.lat, lng: b.lng };
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(map)) {
        if (have.has(k) && v !== undefined && v !== null && v !== '') { sets.push(k + ' = ?'); vals.push(v); }
      }
      if (!sets.length) return res.status(400).json({ success: false, message: 'Tidak ada data yang diisi' });
      vals.push(id);
      const r = db.prepare('UPDATE customers SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
      if (!r.changes) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
      cache.t = 0;
      res.json({ success: true, message: 'ONT pelanggan tersimpan (' + sets.map(s => s.split(' ')[0]).join(', ') + ')' });
    } catch (e) { res.status(500).json({ success: false, message: 'Gagal: ' + e.message }); }
  });
};
