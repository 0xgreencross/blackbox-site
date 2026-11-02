// Run: node tools/selftest.mjs   (needs playwright + chromium)
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails.push(msg); };

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => { console.log('pageerror', e.message); fails.push('pageerror ' + e.message); });
await page.route('**/*', route => {
  const u = route.request().url();
  if (u.includes('ethers@6.13.4')) return route.fulfill({ path: path.join(root, 'tools/vendor/ethers.umd.min.js'), contentType: 'text/javascript' });
  if (u.includes('gifenc@1.0.3')) return route.fulfill({ path: path.join(root, 'tools/vendor/gifenc.esm.js'), contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
  if (u.startsWith(base)) return route.continue();
  return route.abort();
});
await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });

try {
  await page.goto(base + '/selftest.html?rec=2');
  await page.waitForSelector('[data-rec="2"] .info .lbl');
  check((await page.textContent('[data-rec="2"] .st')).trim() === 'IN FLIGHT', 'rec 2 state IN FLIGHT');
  check((await page.textContent('[data-rec="1"] .st')).trim() === 'LANDED', 'rec 1 state LANDED');
  const order = await page.$$eval('.card', els => els.map(e => e.dataset.rec));
  check(order.join(',') === '2,1', 'newest first: ' + order);
  const info1 = await page.textContent('[data-rec="1"] .info');
  check(/LHR > JFK/.test(info1) && /2026-11-04/.test(info1) && /3\/5/.test(info1), 'landed card shows route, date, minted/cap');
  check(/etherscan\.io\/nft\/0x0+c0\/101/.test(await page.$eval('[data-rec="1"] .toks a', a => a.href)), 'explorer token link');
  const os = await page.$$eval('[data-rec="1"] .toks a', as => as.map(a => a.href).filter(h => h.includes('opensea')));
  check(os.length === 3 && os[0] === 'https://opensea.io/assets/ethereum/0x00000000000000000000000000000000000000c0/101', 'opensea links');
  await page.waitForFunction(() => /^\d\d:\d\d:\d\d$/.test(document.querySelector('[data-rec="2"] [data-t]').textContent));
  check(true, 'live countdown ' + await page.textContent('[data-rec="2"] [data-t]'));
  check(await page.$eval('[data-rec="2"]', e => e.classList.contains('hl')), 'deep link highlight');
  check(await page.isVisible('#auction .sec'), 'auction section visible');
  check(Number(await page.inputValue('#bidin')) === 0.66, 'bid prefilled 10% above high bid: ' + await page.inputValue('#bidin'));
  check(/4\/10/.test(await page.textContent('[data-rec="2"] .info')) && /0\.012300 ETH/.test(await page.textContent('[data-rec="2"] .info')), 'minted/cap and price 6 decimals');
  // render: iframe canvas appears
  await page.waitForFunction(() => { const f = document.querySelector('[data-rec="2"] iframe'); try { return f && f.contentDocument.querySelector('canvas'); } catch (e) { return false; } }, null, { timeout: 15000 });
  check(true, 'card piece rendered in iframe canvas');
  await page.waitForFunction(() => !!document.querySelector('#auction iframe'), null, { timeout: 15000 });

  // wallet + mint
  await page.click('#wbtn');
  await page.waitForFunction(() => document.querySelector('#wbtn').textContent.includes('..'));
  await page.waitForSelector('[data-rec="1"] button[data-act="share"]');
  check(true, 'owned piece shows SHARE after connect');
  await page.click('[data-rec="2"] button[data-act="mint"]');
  await page.waitForSelector('#dlg.on', { timeout: 20000 });
  const sent = await page.evaluate(() => window.MOCKSTATE.sent);
  check(sent.length === 1 && sent[0].name === 'mint' && sent[0].rec === 2, 'mint tx sent for rec 2');
  check(/CONFIRMED TOKEN 205/.test(await page.textContent('[data-rec="2"] .msg')), 'confirmed with token id 205 from Minted event');
  check(/BLACKBOX REC 002 \/\/ 05/.test(await page.textContent('#dlgin')), 'share dialog opened for 205');
  check(await page.isDisabled('#shx2'), 'step 2 locked before GIF');

  // GIF
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#shdl')]);
  check(dl.suggestedFilename() === 'blackbox_rec002_05.gif', 'gif filename ' + dl.suggestedFilename());
  const buf = fs.readFileSync(await dl.path());
  check(buf.subarray(0, 6).toString('latin1') === 'GIF89a', 'GIF89a header, ' + buf.length + ' bytes');
  const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
  check(w === 480 && h === 480, `size ${w}x${h}`);
  let gce = 0; for (let i = 0; i < buf.length - 7; i++) if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 4 && buf[i + 7] === 0) gce++;
  check(gce === 36, 'frame count ' + gce);
  check(buf.includes(Buffer.from('NETSCAPE2.0')), 'looping extension present');
  await page.waitForFunction(() => !document.querySelector('#shx2').disabled);
  check(true, 'step 2 unlocked after save');

  // X
  await page.click('#shx2');
  const opened = await page.evaluate(() => window.__opened);
  check(opened.length === 1 && opened[0].startsWith('https://x.com/intent/post?text='), 'X intent url opened');
  const xt = decodeURIComponent(opened[0].split('text=')[1]);
  check(xt.includes('BLACKBOX REC 002 // 05') && xt.includes('by @greencrosslive') && xt.includes('currently minting at:') && xt.endsWith('https://0xgreencross.github.io/blackbox-site/?rec=2'), 'tweet content (open window): ' + xt);
  const fc = await page.getAttribute('#shfc', 'href'), tg = await page.getAttribute('#shtg', 'href');
  check(fc.startsWith('https://farcaster.xyz/~/compose?text=') && fc.includes('&embeds[]=' + encodeURIComponent('https://0xgreencross.github.io/blackbox-site/?rec=2')), 'farcaster url');
  check(tg.startsWith('https://t.me/share/url?url=') && tg.includes('&text='), 'telegram url');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => { });
  await page.click('#shcl');
  await page.waitForFunction(() => /COPIED|FAILED/.test(document.querySelector('#shcl').textContent));
  check((await page.textContent('#shcl')).trim() === 'COPIED', 'COPY LINK shows COPIED');
  await page.click('#shx');
  check(!(await page.isVisible('#dlg')), 'dialog closes');
  // SHARE button on owned piece
  await page.click('[data-rec="1"] button[data-act="share"]');
  await page.waitForSelector('#dlg.on');
  check(/BLACKBOX REC 001 \/\/ 02/.test(await page.textContent('#dlgin')), 'SHARE from owned piece (landed)');
  check(/recorded at:/.test(await page.textContent('#shtw')), 'landed record uses "recorded at:"');
  await page.click('#shx');

  // 20 tweets
  const tw = await page.evaluate(() => {
    const seen = new Set(), out = [];
    for (let i = 0; i < 20; i++) out.push(BB.tweet({ rec: 1, index: 3, open: i % 2 === 0 }, seen));
    return out;
  });
  const shown = await page.textContent('#tweets');
  const link = 'https://0xgreencross.github.io/blackbox-site/?rec=1';
  let okAll = true;
  tw.forEach((t, i) => {
    const counted = t.text.split(link).join('x'.repeat(23)).length;
    const phrase = i % 2 === 0 ? 'currently minting at:' : 'recorded at:';
    const good = counted <= 280 && counted === t.len && t.text.includes('BLACKBOX REC 001 // 03') && t.text.includes('by @greencrosslive') && t.text.includes(phrase) && t.text.endsWith(link) && !/[\u2014\u2013]/.test(t.text) && (t.text.match(/#/g) || []).length <= 1;
    if (!good) okAll = false;
    console.log(`  ${String(i + 1).padStart(2)} [${counted}] ${t.text}`);
  });
  check(okAll, '20 tweets: <=280 counted, required parts, no em dash, <=1 hashtag');
  check(new Set(tw.map(t => t.text)).size === 20, '20 tweets all different');
  check(shown.split('\n').filter(l => /^\d+ \[\d+\]/.test(l)).length === 20, 'selftest.html lists 20 tweets with lengths');
  check(!/[\u2014\u2013]/.test(await page.content()), 'no em or en dashes in page');
} catch (e) {
  console.log('error', e);
  fails.push('exception ' + e.message);
}
await browser.close(); srv.close();
console.log(fails.length ? 'FAIL' : 'PASS');
process.exit(fails.length ? 1 : 0);
