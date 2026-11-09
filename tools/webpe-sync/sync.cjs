// Usage: node tools/webpe-sync/sync.cjs [--apply]   (needs playwright; see README.md "Sync tool")
// Sync every unit's serial number in DCIM with webpe SN analysis, through the owner's signed-in Edge window (CDP :9333):
// a DCIM tab (owner's DCIM session) and a webpe tab (owner's NVIDIA SSO). Dry run by default; --apply saves.
// Saved per found serial: part_number = PN, model = PRODUCT_LINE, type = switch (webpe SWITCH description), and the
// Name = the product (first part of PN_DESCRIPTION) when the unit's current name is generic (its code/serial, a bare
// type label like "Unit", or "<type> <code>"). A name someone typed is kept. One whole-list save with If-Match.
const { chromium } = require('playwright');
const fs = require('fs');
const APPLY = process.argv.includes('--apply');
const path = require('path');
// The DCIM address: DCIM_URL, else vm_site in the local (git-ignored) .team/ops/release.local.json.
const localOps = path.join(__dirname, '..', '..', '.team', 'ops', 'release.local.json');
const site = (process.env.DCIM_URL || (fs.existsSync(localOps) ? JSON.parse(fs.readFileSync(localOps, 'utf8')).vm_site : '')).replace(/\/$/, '');
if (!site) { console.error('Set DCIM_URL to the DCIM site address'); process.exit(1); }
const outDir = process.env.SYNC_REPORT_DIR || process.cwd();
const csv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
// The product's short name: the first part of the description, without "NVIDIA", up to the first spec word, at most 4 words
// ("NVIDIA CHAMELEON SPC5 LIQUID COOLED ETH SWITCH ..." -> "CHAMELEON SPC5"; "CHAMELEON-6S, SPECTRUM-6 ..." -> "CHAMELEON-6S").
const SPEC_WORD = /^(LIQUID|AIR|COOLED|ETH|ETHERNET|SWITCH|W\/|WITH|\d+X?|\d+GBE|\d+VDC|OCP|DC|AC|BUSBAR|NVILINK\d*|NVLINK\d*|MNG|IB|INFINIBAND)$/i;
function productName(d) {
  const words = String(d || '').split(',')[0].trim().split(/\s+/).filter(w => !/^NVIDIA$/i.test(w));
  const kept = [];
  for (const w of words) { if (kept.length && SPEC_WORD.test(w)) break; kept.push(w); if (kept.length === 4) break; }
  return kept.join(' ');
}
const webpeType = d => /SWITCH/i.test(d || '') ? 'switch' : null;
const TYPE_WORDS = /^(unit|switch|nic|cable|pdu|kvm|ups|computer|patch panel|other|transceiver)$/i;
function genericName(item) {
  const name = String(item.name || '').trim(), codes = [item.serial_number, item.barcode, item.id].filter(Boolean).map(c => String(c).trim().toLowerCase());
  if (!name || codes.includes(name.toLowerCase()) || TYPE_WORDS.test(name)) return true;
  const m = /^(\S+(?:\s+panel)?)\s+(.+)$/i.exec(name);
  return !!(m && TYPE_WORDS.test(m[1]) && codes.includes(m[2].toLowerCase()));
}
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const pages = b.contexts()[0].pages();
  const dcim = pages.find(x => x.url().startsWith(site)), webpe = pages.find(x => x.url().includes('webpe.nvidia.com'));
  if (!dcim || !webpe) throw new Error('Need both tabs open in the signed-in Edge window: DCIM and webpe');
  const got = await dcim.evaluate(async () => { const r = await fetch('/api/rack-items'); return { status: r.status, etag: r.headers.get('etag'), data: r.status === 200 ? await r.json() : null }; });
  if (got.status !== 200) throw new Error(`DCIM answered ${got.status}: sign in to DCIM in that Edge window`);
  const units = Object.entries(got.data).flatMap(([rack, list]) => list.map(item => ({ rack, item })));
  const withSn = units.filter(u => (u.item.serial_number || u.item.barcode));
  console.log(`DCIM: ${units.length} units, ${withSn.length} with a serial number or barcode`);
  const report = [['rack', 'unit id', 'serial', 'found', 'name before', 'name after', 'P/N before', 'P/N after', 'model after', 'type before', 'type after', 'description']];
  let changed = 0;
  for (const { rack, item } of withSn) {
    const sn = String(item.serial_number || item.barcode).trim();
    const recs = await webpe.evaluate(async sn => { const r = await fetch('/rest/rawdata/history/getSnData/v2?SN=' + encodeURIComponent(sn)); if (r.status !== 200) return { error: r.status }; try { return await r.json(); } catch { return { error: 'signed out of webpe?' }; } }, sn);
    if (recs.error) throw new Error(`webpe: ${recs.error}`);
    const rec = (recs || []).find(r => r.PN);
    if (!rec) { report.push([rack, item.id, sn, 'no', item.name, '', item.part_number || '', '', '', item.type || '', '', '']); continue; }
    const before = { name: item.name, pn: item.part_number || '', type: item.type || '' };
    if (genericName(item) && productName(rec.PN_DESCRIPTION)) item.name = productName(rec.PN_DESCRIPTION);
    item.part_number = rec.PN;
    if (rec.PRODUCT_LINE) item.model = rec.PRODUCT_LINE;
    if (webpeType(rec.PN_DESCRIPTION)) item.type = 'switch';
    if (!item.serial_number && item.barcode) item.serial_number = item.barcode;
    if (item.name !== before.name || item.part_number !== before.pn || item.type !== before.type) changed++;
    report.push([rack, item.id, sn, 'yes', before.name, item.name, before.pn, item.part_number, item.model || '', before.type, item.type, rec.PN_DESCRIPTION || '']);
    console.log(`${sn}: ${before.name} -> ${item.name} | ${item.part_number} | ${item.type}`);
  }
  const file = path.join(outDir, `sync-${APPLY ? 'applied' : 'dry-run'}.csv`);
  fs.writeFileSync(file, '\ufeff' + report.map(r => r.map(csv).join(',')).join('\r\n') + '\r\n');
  console.log(`found in webpe: ${report.filter(r => r[3] === 'yes').length}/${withSn.length}, units to change: ${changed}; report ${file}`);
  if (APPLY && changed) {
    const put = await dcim.evaluate(async ({ data, etag }) => { const r = await fetch('/api/rack-items', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(data) }); return { status: r.status, text: (await r.text()).slice(0, 300) }; }, { data: got.data, etag: got.etag });
    console.log('saved:', put.status, put.status === 200 ? 'OK' : put.text);
  }
  await b.close().catch(() => {});
})().catch(e => { console.error('STOPPED:', e.message); process.exit(1); });
