/* DITHERVOID // BLACKBOX mint page. Static, no build step. */
(function () {
'use strict';

var CFG = window.BBCFG || {};
var QS = new URLSearchParams(location.search);
var NETKEY = QS.get('net') === 'sepolia' ? 'sepolia' : 'mainnet';
var NET = CFG[NETKEY] || {};
var SITE = 'https://0xgreencross.github.io/blackbox-site/';
var OS_BASE = NETKEY === 'sepolia' ? 'https://testnets.opensea.io/assets/sepolia/' : 'https://opensea.io/assets/ethereum/';
var GIFENC_URL = 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
var MOCK = window.BBMOCK || null;
var POLL_MS = 20000;

var ABI = [
  'function records(uint256) view returns (bytes32 passHash, uint64 windowOpen, uint64 deadline, uint64 landedAt, uint16 blockMinutes, uint16 cap, uint16 minted, uint128 price)',
  'function recordCount() view returns (uint256)',
  'function mint(uint256 rec) payable',
  'function tokenURI(uint256) view returns (string)',
  'function dossierOf(uint256) view returns (string)',
  'function auction() view returns (uint64 start, uint64 end, uint128 reserve, uint128 highBid, address highBidder, bool settled)',
  'function bid() payable',
  'function ownerOf(uint256) view returns (address)',
  'event Minted(uint256 indexed rec, uint256 tokenId, address to, uint16 index)'
];
var iface = new ethers.Interface(ABI);

/* ---------- helpers ---------- */
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function p2(n) { return String(n).padStart(2, '0'); }
function p3(n) { return String(n).padStart(3, '0'); }
function short(a) { return a ? a.slice(0, 6) + '..' + a.slice(-4) : ''; }
function isMobile() {
  var ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}
function fmtEth(wei) {
  var v = (BigInt(wei) + 500000000000n) / 1000000000000n;
  var s = v.toString().padStart(7, '0');
  return s.slice(0, -6) + '.' + s.slice(-6);
}
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (d ? d + 'D ' : '') + p2(h) + ':' + p2(m) + ':' + p2(s);
}
function fmtDate(ts) {
  var d = new Date(ts * 1000);
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}
function b64dec(s) {
  var bin = atob(s), u = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
}
function pieceName(rec, idx) { return 'BLACKBOX REC ' + p3(rec) + ' // ' + p2(idx); }
function deepLink(rec) { return SITE + '?rec=' + rec + (NETKEY === 'sepolia' ? '&net=sepolia' : ''); }
function pageUrl() { return location.href; }

/* ---------- rpc ---------- */
async function rpcBatch(reqs) {
  if (MOCK) {
    return Promise.all(reqs.map(function (r) {
      return MOCK.request({ method: r.method, params: r.params }).then(function (v) { return { ok: 1, v: v }; }, function (e) { return { ok: 0, e: e }; });
    }));
  }
  var out = [];
  for (var off = 0; off < reqs.length; off += 40) {
    var chunk = reqs.slice(off, off + 40);
    var part = await rpcChunk(chunk);
    out = out.concat(part);
  }
  return out;
}
async function rpcChunk(reqs) {
  var body = reqs.map(function (r, i) { return { jsonrpc: '2.0', id: i + 1, method: r.method, params: r.params }; });
  var res;
  try {
    var resp = await fetch(NET.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.length === 1 ? body[0] : body) });
    res = await resp.json();
  } catch (e) { return reqs.map(function () { return { ok: 0, e: e }; }); }
  if (!Array.isArray(res)) {
    if (reqs.length === 1) return [res.error ? { ok: 0, e: new Error(res.error.message) } : { ok: 1, v: res.result }];
    var seq = [];
    for (var k = 0; k < reqs.length; k++) seq.push((await rpcChunk([reqs[k]]))[0]);
    return seq;
  }
  var out = reqs.map(function () { return { ok: 0, e: new Error('missing') }; });
  res.forEach(function (x) { var i = x.id - 1; if (out[i]) out[i] = x.error ? { ok: 0, e: new Error(x.error.message) } : { ok: 1, v: x.result }; });
  return out;
}
function mk(fn, args, gas) {
  var o = { to: NET.contract, data: iface.encodeFunctionData(fn, args) };
  if (gas) o.gas = gas;
  return { method: 'eth_call', params: [o, 'latest'], fn: fn };
}
function dec(req, r) {
  if (!r.ok) throw r.e;
  return iface.decodeFunctionResult(req.fn, r.v);
}
async function read(fn, args, gas) {
  var q = mk(fn, args, gas);
  return dec(q, (await rpcBatch([q]))[0]);
}

/* ---------- state ---------- */
var S = {
  recs: new Map(), cards: new Map(), count: 0, offset: 0, dossiers: new Map(), auction: null,
  account: null, wp: null, owned: new Map(), notMine: new Set(), msgs: {}, hlDone: false, metaCache: new Map(), lastPoll: 0
};
function nowSec() { return Date.now() / 1000 + S.offset; }
function stateOf(r, now) {
  if (r.landedAt) return 'LANDED';
  if (now < r.windowOpen) return 'FILED SOON';
  if (now <= r.deadline) return 'IN FLIGHT';
  return 'LANDING';
}
function canMint(r, now) { return stateOf(r, now) === 'IN FLIGHT' && r.minted < r.cap; }

/* ---------- skeleton ---------- */
function build() {
  var app = $('#app');
  app.innerHTML =
    '<div class="wrap">' +
    '<header><div><h1>DITHERVOID // BLACKBOX</h1><div class="by">BY GREENCROSS <a href="https://x.com/greencrosslive" target="_blank" rel="noopener">@GREENCROSSLIVE</a></div>' +
    (NETKEY === 'sepolia' ? '<div class="net">SEPOLIA TESTNET</div>' : '') + '</div>' +
    '<button id="wbtn">CONNECT</button></header>' +
    '<div class="intro">' +
    '<p><b>EVERY FLIGHT WRITES A RECORD ON ETHEREUM.</b></p>' +
    '<p>A RECORD FILES AT BOARDING. EDITIONS CAN BE COLLECTED ONLY WHILE THE PLANE IS IN THE AIR. AT LANDING THE WINDOW CLOSES AND UNMINTED SUPPLY NEVER EXISTS.</p>' +
    '<p>IN FLIGHT A PIECE IS SEALED: LABEL AND HASH ONLY. AT LANDING IT DECLASSIFIES: ROUTE, DATE, SEAT.</p>' +
    '<p>THE ART IS RENDERED ENTIRELY FROM THE CHAIN.</p>' +
    '<p>ONE 1/1 COMPLETE JOURNEY PIECE IS AUCTIONED AFTER THE LAST FLIGHT.</p></div>' +
    '<div class="openin" id="openin"><div class="dim">NO WALLET DETECTED. OPEN THIS PAGE IN A WALLET BROWSER.</div><div class="bar" id="openbar"></div></div>' +
    '<div id="main"></div>' +
    '<footer>' + (NET.contract ? 'CONTRACT <a target="_blank" rel="noopener" href="' + esc(NET.explorer) + '/address/' + esc(NET.contract) + '">' + esc(short(NET.contract)) + '</a>' : '') + '</footer>' +
    '</div>' +
    '<div id="picker"><div class="box" id="pbox"></div></div>' +
    '<div id="dlg"><div class="in" id="dlgin"></div></div>';
  $('#wbtn').addEventListener('click', function () { connect().catch(function (e) { toast(e); }); });
}
function toast(e) { console.warn(e); }

function renderUnarmed() {
  $('#main').innerHTML = '<div class="unarmed"><h2>RECORDER NOT YET ARMED</h2><div class="dim">NO RECORD HAS BEEN FILED. THE NEXT BOARDING WRITES THE FIRST.</div></div>';
}

/* ---------- chain reads ---------- */
async function refresh() {
  if (!NET.contract) return;
  try {
    var cnt = Number((await read('recordCount', []))[0]);
    S.count = cnt;
    var reqs = [{ method: 'eth_getBlockByNumber', params: ['latest', false] }, mk('auction', [])];
    for (var i = 1; i <= cnt; i++) reqs.push(mk('records', [i]));
    var res = await rpcBatch(reqs);
    if (res[0].ok && res[0].v && res[0].v.timestamp) S.offset = parseInt(res[0].v.timestamp, 16) - Math.floor(Date.now() / 1000);
    try {
      var a = dec(reqs[1], res[1]);
      S.auction = { start: Number(a[0]), end: Number(a[1]), reserve: a[2], highBid: a[3], highBidder: a[4], settled: a[5] };
    } catch (e) { S.auction = null; }
    for (var j = 1; j <= cnt; j++) {
      var q = reqs[j + 1];
      try {
        var v = dec(q, res[j + 1]);
        S.recs.set(j, { rec: j, passHash: v[0], windowOpen: Number(v[1]), deadline: Number(v[2]), landedAt: Number(v[3]), blockMinutes: Number(v[4]), cap: Number(v[5]), minted: Number(v[6]), price: v[7] });
      } catch (e) { /* keep previous */ }
    }
    var need = [];
    S.recs.forEach(function (r) { if (r.landedAt && !S.dossiers.get(r.rec)) need.push(r.rec); });
    if (need.length) {
      var dq = need.map(function (n) { return mk('dossierOf', [n]); });
      var dr = await rpcBatch(dq);
      need.forEach(function (n, k) { try { var s = dec(dq[k], dr[k])[0]; if (s) S.dossiers.set(n, s); } catch (e) { } });
    }
    S.lastPoll = Date.now();
    await refreshOwned();
    renderRecords();
    renderAuction();
  } catch (e) { console.warn('refresh failed', e); }
}

async function refreshOwned() {
  if (!S.account) return;
  var want = [], me = S.account.toLowerCase();
  S.recs.forEach(function (r) {
    for (var i = 1; i <= r.minted && want.length < 600; i++) {
      var id = r.rec * 100 + i;
      if (!S.notMine.has(id) && !(S.owned.get(r.rec) || new Set()).has(i)) want.push(id);
    }
  });
  if (!want.length) return;
  var qs = want.map(function (id) { return mk('ownerOf', [id]); });
  var rs = await rpcBatch(qs);
  want.forEach(function (id, k) {
    try {
      var o = dec(qs[k], rs[k])[0];
      if (o.toLowerCase() === me) markOwned(id); else S.notMine.add(id);
    } catch (e) { }
  });
}
function markOwned(id) {
  var rec = Math.floor(id / 100), idx = id % 100;
  if (!S.owned.has(rec)) S.owned.set(rec, new Set());
  S.owned.get(rec).add(idx);
  S.notMine.delete(id);
}

/* ---------- piece metadata / render ---------- */
async function getMeta(tokenId, key) {
  if (S.metaCache.has(key)) return S.metaCache.get(key);
  var uri = (await read('tokenURI', [tokenId], '0x1c9c380'))[0];
  var j = null;
  var m = /^data:application\/json;base64,(.*)$/.exec(uri);
  if (m) j = JSON.parse(b64dec(m[1]));
  else if (/^data:application\/json/.test(uri)) j = JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)));
  else throw new Error('bad tokenURI');
  var html = '', au = j.animation_url || '';
  var m2 = /^data:text\/html;base64,(.*)$/.exec(au);
  if (m2) html = b64dec(m2[1]);
  else if (/^data:text\/html/.test(au)) html = decodeURIComponent(au.slice(au.indexOf(',') + 1));
  var meta = { name: j.name || '', image: j.image || '', html: html };
  S.metaCache.set(key, meta);
  return meta;
}
function mountPiece(art, meta, stale) {
  art.innerHTML = '';
  if (meta.image) { var im = document.createElement('img'); im.alt = ''; im.src = meta.image; art.appendChild(im); }
  if (!meta.html) return null;
  var f = document.createElement('iframe');
  f.setAttribute('scrolling', 'no');
  f.setAttribute('title', 'piece');
  f.srcdoc = meta.html;
  art.appendChild(f);
  var t0 = Date.now();
  (function poll() {
    if (stale && stale()) return;
    var c = null;
    try { c = f.contentDocument && f.contentDocument.querySelector('canvas'); } catch (e) { }
    if (c) { f.classList.add('on'); setTimeout(function () { var im2 = $('img', art); if (im2 && !(stale && stale())) im2.style.visibility = 'hidden'; }, 450); return; }
    if (Date.now() - t0 < 90000) setTimeout(poll, 250);
  })();
  return f;
}

var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (es) {
  es.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); var c = e.target._card; if (c) loadCardArt(c); } });
}, { rootMargin: '600px' }) : null;

async function loadCardArt(card) {
  var key = card._want;
  if (!key || card._key === key) return;
  card._key = key;
  var art = $('.art', card);
  var tokenId = card._tokenId;
  try {
    var meta = await getMeta(tokenId, key);
    if (card._key !== key) return;
    mountPiece(art, meta, function () { return card._key !== key; });
  } catch (e) {
    if (card._key === key) { card._key = null; art.innerHTML = '<div class="empty">PIECE UNAVAILABLE</div>'; }
  }
}
function wantArt(card, r) {
  if (!r.minted) {
    card._want = null; card._key = null;
    $('.art', card).innerHTML = '<div class="empty">' + (r.landedAt ? 'NO EDITIONS WERE COLLECTED' : 'AWAITING FIRST EDITION') + '</div>';
    return;
  }
  var tokenId = r.rec * 100 + r.minted;
  var key = tokenId + ':' + (r.landedAt ? 1 : 0);
  if (card._want === key) return;
  card._want = key; card._tokenId = tokenId;
  if (io) { card._key = null; io.observe($('.art', card)); } else loadCardArt(card);
}

/* ---------- records UI ---------- */
function renderRecords() {
  var main = $('#main');
  var list = $('#recs');
  if (!list) {
    main.innerHTML = '<div id="recs"></div><div id="auction"></div>';
    list = $('#recs');
  }
  var ids = Array.from(S.recs.keys()).sort(function (a, b) { return b - a; });
  if (!ids.length) { list.innerHTML = '<div class="empty-l">NO RECORDS FILED YET.</div>'; return; }
  var emp = $('.empty-l', list); if (emp) emp.remove();
  var prev = null;
  ids.forEach(function (id) {
    var r = S.recs.get(id), card = S.cards.get(id);
    if (!card) {
      card = document.createElement('article');
      card.className = 'card'; card.id = 'rec-' + id; card.setAttribute('data-rec', id);
      card.innerHTML = '<div class="art"></div><div class="info"></div>';
      card._card = card; $('.art', card)._card = card;
      S.cards.set(id, card);
    }
    $('.art', card)._card = card;
    if (prev ? prev.nextSibling !== card : list.firstChild !== card) list.insertBefore(card, prev ? prev.nextSibling : list.firstChild);
    prev = card;
    updateCard(card, r);
  });
  if (!S.hlDone) {
    var want = parseInt(QS.get('rec'), 10);
    if (want && S.cards.has(want)) {
      S.hlDone = true;
      var c = S.cards.get(want); c.classList.add('hl');
      setTimeout(function () { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    }
  }
}

function updateCard(card, r) {
  var now = nowSec(), st = stateOf(r, now);
  var owned = S.owned.get(r.rec) ? Array.from(S.owned.get(r.rec)).sort(function (a, b) { return a - b; }) : [];
  var msg = S.msgs[r.rec] || null;
  var sig = [st, r.minted, r.cap, String(r.price), S.dossiers.get(r.rec) || '', owned.join(','), msg ? msg.h : '', S.account || ''].join('|');
  if (card._sig !== sig) {
    card._sig = sig; card._state = st;
    $('.info', card).innerHTML = infoHtml(r, st, now, owned, msg);
    wire(card, r);
  }
  wantArt(card, r);
}

function infoHtml(r, st, now, owned, msg) {
  var h = '<div class="row"><span class="lbl">REC ' + p3(r.rec) + '</span><span class="st' + (st === 'IN FLIGHT' ? ' live' : '') + '">' + st + '</span></div>';
  if (st === 'FILED SOON') h += '<div class="kv"><span>WINDOW OPENS IN</span><span data-t="' + r.windowOpen + '">--</span></div>';
  if (st === 'IN FLIGHT') h += '<div class="kv"><span>WINDOW CLOSES IN</span><span data-t="' + r.deadline + '">--</span></div>';
  if (st === 'LANDING') h += '<div class="kv"><span>WINDOW</span><span>CLOSED, AWAITING LANDING</span></div>';
  if (st !== 'LANDED') h += '<div class="kv"><span>HASH</span><span>' + esc(short(r.passHash)) + '</span></div><div class="kv"><span>ROUTE DATE SEAT</span><span>SEALED</span></div>';
  if (st === 'LANDED') {
    var d = (S.dossiers.get(r.rec) || '').split('|');
    h += '<div class="route">' + esc(d[0] || '?') + ' &gt; ' + esc(d[1] || '?') + '</div>';
    h += '<div class="kv"><span>DATE</span><span>' + esc(d[2] || fmtDate(r.landedAt)) + '</span></div>';
    if (d[3]) h += '<div class="kv"><span>SEAT</span><span>' + esc(d[3]) + '</span></div>';
    var extra = [d[4] ? esc(d[4]) + ' MIN' : '', d[5] ? esc(d[5]) + ' KM' : '', d[6] ? esc(d[6]) : ''].filter(Boolean).join(' / ');
    if (extra) h += '<div class="kv"><span>FLIGHT</span><span>' + extra + '</span></div>';
  }
  h += '<div class="kv"><span>MINTED</span><span>' + r.minted + '/' + r.cap + '</span></div>';
  h += '<div class="kv"><span>PRICE</span><span>' + fmtEth(r.price) + ' ETH</span></div>';
  if (canMint(r, now)) h += '<div class="act"><button class="pri" data-act="mint">MINT ' + fmtEth(r.price) + ' ETH</button></div>';
  else if (st === 'IN FLIGHT') h += '<div class="act"><button class="pri" disabled>ALL EDITIONS COLLECTED</button></div>';
  h += '<div class="msg' + (msg && msg.err ? ' err' : '') + '">' + (msg ? msg.h : '') + '</div>';
  var toks = '';
  if (st === 'LANDED' && r.minted) {
    for (var i = 1; i <= r.minted; i++) {
      var id = r.rec * 100 + i, mine = owned.indexOf(i) >= 0;
      toks += '<span class="t"><b>' + p2(i) + '</b> <a target="_blank" rel="noopener" href="' + esc(NET.explorer) + '/nft/' + esc(NET.contract) + '/' + id + '">SCAN</a> <a target="_blank" rel="noopener" href="' + esc(OS_BASE + NET.contract + '/' + id) + '">OPENSEA</a>' +
        (mine ? ' <button data-act="share" data-idx="' + i + '">SHARE</button>' : '') + '</span>';
    }
  } else if (owned.length) {
    owned.forEach(function (i) { toks += '<span class="t"><b>' + p2(i) + '</b> YOURS <button data-act="share" data-idx="' + i + '">SHARE</button></span>'; });
  }
  if (toks) h += '<div class="toks">' + toks + '</div>';
  return h;
}
function wire(card, r) {
  $$('button[data-act]', card).forEach(function (b) {
    b.addEventListener('click', function () {
      var act = b.getAttribute('data-act');
      if (act === 'mint') doMint(r.rec);
      if (act === 'share') { var i = parseInt(b.getAttribute('data-idx'), 10); openShare({ rec: r.rec, index: i, tokenId: r.rec * 100 + i }); }
    });
  });
}
function setMsg(rec, h, err) {
  S.msgs[rec] = h ? { h: h, err: !!err } : null;
  var r = S.recs.get(rec), card = S.cards.get(rec);
  if (r && card) updateCard(card, r);
}

function tick() {
  var now = nowSec();
  $$('[data-t]').forEach(function (el) {
    var t = parseInt(el.getAttribute('data-t'), 10);
    el.textContent = fmtClock(t - now);
  });
  S.recs.forEach(function (r) {
    var card = S.cards.get(r.rec);
    if (card && card._state !== stateOf(r, now)) { updateCard(card, r); setTimeout(refresh, 2500); }
  });
  var ab = $('#aucend');
  if (ab && S.auction) {
    var t2 = S.auction.end - now;
    if (!S.auction.settled) ab.textContent = t2 > 0 ? fmtClock(t2) : 'CLOSED';
  }
}

/* ---------- auction ---------- */
function bidMin(a) {
  var m = a.highBid > 0n ? a.highBid + (a.highBid + 9n) / 10n : a.reserve;
  var u = 1000000000000n;
  return ((m + u - 1n) / u) * u;
}
function renderAuction() {
  var host = $('#auction'); if (!host) return;
  var a = S.auction;
  if (!a || !a.end) { host.innerHTML = ''; host._built = false; return; }
  var now = nowSec();
  var stateTxt = a.settled ? 'SETTLED' : now < a.start ? 'NOT STARTED' : now < a.end ? 'LIVE' : 'CLOSED';
  var live = !a.settled && now >= a.start && now < a.end;
  var min = bidMin(a);
  var hi = a.highBid > 0n ? fmtEth(a.highBid) + ' ETH' : 'NONE, RESERVE ' + fmtEth(a.reserve) + ' ETH';
  var bidder = a.highBid > 0n ? short(a.highBidder) : '--';
  if (!host._built) {
    host._built = true;
    host.innerHTML = '<section class="sec"><h2>1/1 COMPLETE JOURNEY</h2><div class="art" id="aucart"><div class="empty">LOADING</div></div>' +
      '<div class="row"><span class="lbl">TOKEN 0</span><span class="st" id="aucst"></span></div>' +
      '<div class="kv"><span>HIGH BID</span><span id="auchi"></span></div><div class="kv"><span>BIDDER</span><span id="aucbd"></span></div>' +
      '<div class="kv"><span id="auclab">ENDS IN</span><span id="aucend"></span></div>' +
      '<div class="kv"><span>MIN BID</span><span id="aucmin"></span></div>' +
      '<div class="bidrow"><input id="bidin" inputmode="decimal" autocomplete="off" aria-label="BID IN ETH"><button class="pri" id="bidbtn">BID</button></div>' +
      '<div class="msg" id="bidmsg"></div></section>';
    $('#bidin').addEventListener('input', function () { this.setAttribute('data-dirty', '1'); });
    $('#bidbtn').addEventListener('click', doBid);
    host._key = null;
  }
  $('#aucst').textContent = stateTxt;
  $('#auchi').textContent = hi;
  $('#aucbd').textContent = bidder;
  $('#aucmin').textContent = fmtEth(min) + ' ETH';
  $('#auclab').textContent = now < a.start ? 'STARTS IN' : 'ENDS IN';
  $('#aucend').textContent = a.settled ? 'SETTLED' : now < a.start ? fmtClock(a.start - now) : (a.end - now > 0 ? fmtClock(a.end - now) : 'CLOSED');
  var inp = $('#bidin');
  if (!inp.getAttribute('data-dirty') || inp._min !== String(min)) { inp.value = ethers.formatEther(min); inp.removeAttribute('data-dirty'); }
  inp._min = String(min);
  $('#bidbtn').disabled = !live;
  var key = 'a' + (S.auction.settled ? 1 : 0);
  if (host._key !== key) {
    host._key = key;
    getMeta(0, 'tok0:' + key).then(function (meta) { mountPiece($('#aucart'), meta, function () { return host._key !== key; }); }).catch(function () { $('#aucart').innerHTML = '<div class="empty">PIECE UNAVAILABLE</div>'; });
  }
}
async function doBid() {
  var m = $('#bidmsg'), a = S.auction;
  try {
    var wei = ethers.parseEther($('#bidin').value.trim() || '0');
    if (wei < bidMin(a)) { m.textContent = 'BELOW MINIMUM BID'; return; }
    m.textContent = 'CONNECTING';
    await connect(); await ensureChain();
    m.textContent = 'CONFIRM IN WALLET';
    var hash = await S.wp.request({ method: 'eth_sendTransaction', params: [{ from: S.account, to: NET.contract, data: iface.encodeFunctionData('bid', []), value: '0x' + wei.toString(16) }] });
    m.innerHTML = 'PENDING <a target="_blank" rel="noopener" href="' + esc(NET.explorer) + '/tx/' + esc(hash) + '">' + esc(short(hash)) + '</a>';
    var rc = await waitReceipt(hash);
    m.textContent = rc.status === '0x1' ? 'BID CONFIRMED' : 'BID FAILED';
    refresh();
  } catch (e) { m.textContent = errText(e); }
}

/* ---------- wallet ---------- */
var found = [];
window.addEventListener('eip6963:announceProvider', function (e) {
  if (e.detail && e.detail.info && !found.some(function (p) { return p.info.uuid === e.detail.info.uuid; })) found.push(e.detail);
});
function discover() { window.dispatchEvent(new Event('eip6963:requestProvider')); }
function walletList() {
  if (MOCK) return [{ info: { name: 'MOCK WALLET', uuid: 'mock' }, provider: MOCK }];
  var l = found.slice();
  if (!l.length && window.ethereum) l = [{ info: { name: 'INJECTED WALLET', uuid: 'inj' }, provider: window.ethereum }];
  return l;
}
function errText(e) {
  var m = (e && (e.shortMessage || e.message || e.reason)) || String(e);
  if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED')) return 'REJECTED IN WALLET';
  return String(m).slice(0, 120);
}
function chooseWallet(list) {
  return new Promise(function (resolve, reject) {
    var box = $('#pbox');
    box.innerHTML = '<div class="dim">SELECT WALLET</div>';
    list.forEach(function (w) {
      var b = document.createElement('button');
      b.innerHTML = (w.info.icon ? '<img alt="" src="' + esc(w.info.icon) + '">' : '') + esc(w.info.name || 'WALLET');
      b.addEventListener('click', function () { $('#picker').classList.remove('on'); resolve(w); });
      box.appendChild(b);
    });
    var c = document.createElement('button'); c.textContent = 'CANCEL';
    c.addEventListener('click', function () { $('#picker').classList.remove('on'); reject(new Error('CANCELLED')); });
    box.appendChild(c);
    $('#picker').classList.add('on');
  });
}
async function connect() {
  if (S.account && S.wp) return S.account;
  discover(); await sleep(60);
  var list = walletList();
  if (!list.length) { showOpenIn(true); throw new Error('NO WALLET FOUND'); }
  var w = list.length === 1 ? list[0] : await chooseWallet(list);
  var accts = await w.provider.request({ method: 'eth_requestAccounts' });
  if (!accts || !accts[0]) throw new Error('NO ACCOUNT');
  S.wp = w.provider; S.account = ethers.getAddress(accts[0]);
  if (S.wp.on) {
    S.wp.on('accountsChanged', function (a) { S.account = a && a[0] ? ethers.getAddress(a[0]) : null; if (!S.account) S.wp = null; S.owned.clear(); S.notMine.clear(); walletBtn(); S.cards.forEach(function (c) { c._sig = null; }); refresh(); });
    S.wp.on('chainChanged', function () { });
  }
  walletBtn(); refresh();
  return S.account;
}
function walletBtn() { $('#wbtn').textContent = S.account ? short(S.account) : 'CONNECT'; }
async function ensureChain() {
  var want = '0x' + NET.chainId.toString(16);
  var cur = await S.wp.request({ method: 'eth_chainId' });
  if (parseInt(cur, 16) === NET.chainId) return;
  try {
    await S.wp.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
  } catch (e) {
    if (e && e.code === 4902 && NETKEY === 'sepolia') {
      await S.wp.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [NET.rpc], blockExplorerUrls: [NET.explorer] }] });
    } else throw e;
  }
}
function showOpenIn(force) {
  if (MOCK) return;
  if (!isMobile()) return;
  if (walletList().length && !force) return;
  var hostPath = location.host + location.pathname + location.search;
  var bar = $('#openbar');
  bar.innerHTML =
    '<a href="https://metamask.app.link/dapp/' + esc(hostPath) + '"><button>OPEN IN METAMASK</button></a>' +
    '<a href="https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(pageUrl()) + '"><button>OPEN IN COINBASE</button></a>' +
    '<a href="https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(pageUrl()) + '"><button>OPEN IN TRUST</button></a>';
  $('#openin').classList.add('on');
}

async function waitReceipt(hash) {
  for (var i = 0; i < 400; i++) {
    var r = (await rpcBatch([{ method: 'eth_getTransactionReceipt', params: [hash] }]))[0];
    if (r.ok && r.v) return r.v;
    await sleep(3000);
  }
  throw new Error('RECEIPT TIMEOUT');
}

async function doMint(rec) {
  var r = S.recs.get(rec);
  if (!r) return;
  try {
    setMsg(rec, 'CONNECTING');
    await connect(); await ensureChain();
    setMsg(rec, 'CONFIRM IN WALLET');
    var hash = await S.wp.request({ method: 'eth_sendTransaction', params: [{ from: S.account, to: NET.contract, data: iface.encodeFunctionData('mint', [rec]), value: '0x' + r.price.toString(16) }] });
    setMsg(rec, 'PENDING <a target="_blank" rel="noopener" href="' + esc(NET.explorer) + '/tx/' + esc(hash) + '">' + esc(short(hash)) + '</a>');
    var rc = await waitReceipt(hash);
    if (rc.status !== '0x1') { setMsg(rec, 'FAILED. WINDOW MAY HAVE CLOSED.', true); return; }
    var tokenId = null, idx = null;
    (rc.logs || []).forEach(function (lg) {
      if (tokenId !== null || !lg.address || lg.address.toLowerCase() !== NET.contract.toLowerCase()) return;
      try { var p = iface.parseLog({ topics: lg.topics, data: lg.data }); if (p && p.name === 'Minted') { tokenId = Number(p.args.tokenId); idx = Number(p.args.index); } } catch (e) { }
    });
    if (tokenId === null) { setMsg(rec, 'CONFIRMED. TOKEN ID NOT FOUND IN RECEIPT.'); refresh(); return; }
    markOwned(tokenId);
    setMsg(rec, 'CONFIRMED TOKEN ' + tokenId);
    await refresh();
    openShare({ rec: rec, index: idx, tokenId: tokenId });
  } catch (e) { setMsg(rec, esc(errText(e)), true); }
}

/* ---------- tweets ---------- */
var POOLS = {
  liveWhen: ['while the plane was still in the air', 'before the plane landed', 'mid flight', 'at altitude', 'while the window was open', 'somewhere over the ocean'],
  doneWhen: ['after the plane landed', 'from a finished flight', 'once the window closed', 'after declassification', 'from a completed route'],
  liveState: ['sealed until landing', 'still sealed', 'sealed in flight', 'unreadable until touchdown'],
  doneState: ['declassified at landing', 'declassified', 'route and seat now public', 'filed and landed'],
  verb: ['just collected', 'just minted', 'picked up', 'claimed', 'logged', 'secured'],
  noun: ['flight recorder entry', 'flight record', 'black box entry', 'boarding record', 'ledger entry'],
  tail: ['rendered entirely from the chain.', 'every flight writes a record.', 'unminted supply never exists.', 'one window per flight.', 'the plane is the clock.', 'no landing, no edition.'],
  tag: ['#ethereum', '#onchain', '#nft']
};
var TEMPLATES = [
  '{verb} {name} by @greencrosslive {when}. {tag}{phrase} {link}',
  'a {noun}, {state}: {name} by @greencrosslive. {tag}{phrase} {link}',
  '{name} by @greencrosslive. {tail} {tag}{phrase} {link}',
  '{verb} a {noun} {when}. {name} by @greencrosslive. {tag}{phrase} {link}',
  '{noun}, {state}. {name} by @greencrosslive. {tail} {tag}{phrase} {link}',
  'filed on ethereum {when}: {name} by @greencrosslive. {tag}{phrase} {link}',
  '{tail} {name} by @greencrosslive, {state}. {tag}{phrase} {link}',
  '{verb} {name} by @greencrosslive. {state}. {tag}{phrase} {link}',
  'one more record in the black box. {name} by @greencrosslive, {when}. {tag}{phrase} {link}',
  'flight record in hand, {state}: {name} by @greencrosslive. {tail} {tag}{phrase} {link}'
];
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function tweetLen(text, link) { return text.split(link).join('x'.repeat(23)).length; }
function makeTweet(ctx, seen) {
  var link = deepLink(ctx.rec), name = pieceName(ctx.rec, ctx.index);
  var phrase = ctx.open ? 'currently minting at:' : 'recorded at:';
  var out = null;
  for (var tries = 0; tries < 400; tries++) {
    var tpl = pick(TEMPLATES);
    var tag = Math.random() < 0.22 ? pick(POOLS.tag) + ' ' : '';
    var text = tpl
      .replace('{verb}', pick(POOLS.verb)).replace('{noun}', pick(POOLS.noun)).replace('{tail}', pick(POOLS.tail))
      .replace('{when}', pick(ctx.open ? POOLS.liveWhen : POOLS.doneWhen)).replace('{state}', pick(ctx.open ? POOLS.liveState : POOLS.doneState))
      .replace('{name}', name).replace('{tag}', tag).replace('{phrase}', phrase).replace('{link}', link);
    if (tweetLen(text, link) > 280) continue;
    if (seen && seen.has(text)) continue;
    out = text; break;
  }
  if (!out) out = 'BLACKBOX: ' + name + ' by @greencrosslive. ' + phrase + ' ' + link;
  if (seen) seen.add(out);
  return { text: out, body: out.split(link).join('').replace(/\s+$/, ''), link: link, name: name, len: tweetLen(out, link) };
}

/* ---------- share dialog ---------- */
var SH = null;
function openShare(p) {
  var r = S.recs.get(p.rec);
  var open = r ? canMint(r, nowSec()) || stateOf(r, nowSec()) === 'IN FLIGHT' : true;
  SH = { rec: p.rec, index: p.index, tokenId: p.tokenId, open: open, seen: new Set(), saved: false, file: null, busy: false, tw: null };
  var name = pieceName(p.rec, p.index);
  var dl = $('#dlgin');
  dl.innerHTML =
    '<div class="top"><span class="lbl">SHARE</span><button id="shx" aria-label="CLOSE">CLOSE</button></div>' +
    '<div class="dim">' + esc(name) + '</div>' +
    '<div class="art" id="shart" style="margin-top:8px"><div class="empty">LOADING</div></div>' +
    '<div class="step"><div class="h">STEP 1</div><button class="pri" id="shdl">DOWNLOAD GIF</button><div class="prog" id="shprog"><i></i></div><div class="msg" id="shnote"></div></div>' +
    '<div class="step"><div class="h">STEP 2</div><button class="pri" id="shx2" disabled>SHARE TO X</button><div class="dim" id="shlock" style="margin-top:6px">SAVE THE GIF TO UNLOCK</div></div>' +
    '<div class="step"><div class="h">TEXT</div><div class="tw" id="shtw"></div><div class="grid"><button id="shre">NEW TEXT</button><button id="shct">COPY TEXT</button></div></div>' +
    '<div class="step"><div class="h">OTHER</div><div class="grid"><button id="shcl">COPY LINK</button><a id="shfc" target="_blank" rel="noopener"><button style="width:100%">FARCASTER</button></a><a id="shtg" target="_blank" rel="noopener"><button style="width:100%">TELEGRAM</button></a>' +
    (navigator.share ? '<button id="shns">NATIVE SHARE</button>' : '') + '</div></div>';
  $('#dlg').classList.add('on');
  document.body.style.overflow = 'hidden';
  $('#shx').addEventListener('click', closeShare);
  $('#shdl').addEventListener('click', onDownload);
  $('#shx2').addEventListener('click', onShareX);
  $('#shre').addEventListener('click', function () { newTweet(); });
  $('#shct').addEventListener('click', function () { copy(SH.tw.text, this); });
  $('#shcl').addEventListener('click', function () { copy(SH.tw.link, this); });
  if ($('#shns')) $('#shns').addEventListener('click', function () { navigator.share({ text: SH.tw.body, url: SH.tw.link }).catch(function () { }); });
  newTweet();
  var key = 'sh:' + p.tokenId + ':' + (r && r.landedAt ? 1 : 0) + ':' + Date.now();
  var shid = SH;
  getMeta(p.tokenId, key).then(function (meta) {
    if (SH !== shid) return;
    var f = mountPiece($('#shart'), meta, function () { return SH !== shid; });
    shid.iframe = f;
  }).catch(function () { $('#shart').innerHTML = '<div class="empty">PIECE UNAVAILABLE</div>'; $('#shnote').textContent = 'PIECE COULD NOT BE LOADED'; });
}
function closeShare() {
  $('#dlg').classList.remove('on');
  $('#dlgin').innerHTML = '';
  document.body.style.overflow = '';
  SH = null;
}
function newTweet() {
  var t = makeTweet({ rec: SH.rec, index: SH.index, open: SH.open }, SH.seen);
  SH.tw = t;
  $('#shtw').textContent = t.text;
  $('#shfc').href = 'https://farcaster.xyz/~/compose?text=' + encodeURIComponent(t.body) + '&embeds[]=' + encodeURIComponent(t.link);
  $('#shtg').href = 'https://t.me/share/url?url=' + encodeURIComponent(t.link) + '&text=' + encodeURIComponent(t.body);
}
async function copy(txt, btn) {
  var ok = false;
  try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {
    try { var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e2) { }
  }
  var old = btn.getAttribute('data-l') || btn.textContent;
  btn.setAttribute('data-l', old);
  btn.textContent = ok ? 'COPIED' : 'COPY FAILED';
  setTimeout(function () { btn.textContent = old; }, 1600);
}
function onShareX() {
  if (!SH || !SH.saved) return;
  var url = 'https://x.com/intent/post?text=' + encodeURIComponent(SH.tw.text);
  if (isMobile()) location.href = url; else window.open(url, '_blank', 'noopener');
}
function markSaved() {
  SH.saved = true;
  $('#shx2').disabled = false;
  $('#shlock').textContent = 'GIF SAVED. ATTACH IT IN THE X COMPOSER.';
  $('#shdl').textContent = 'DOWNLOAD GIF AGAIN';
}
async function waitCanvas(f, ms) {
  var t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { var c = f.contentDocument && f.contentDocument.querySelector('canvas'); if (c && c.width > 0) return c; } catch (e) { }
    await sleep(150);
  }
  throw new Error('NO CANVAS');
}
function canvasLive(c) {
  try {
    var t = document.createElement('canvas'); t.width = t.height = 32;
    var x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0, 32, 32);
    var d = x.getImageData(0, 0, 32, 32).data, first = d[0] + ',' + d[1] + ',' + d[2];
    for (var i = 4; i < d.length; i += 4) if ((d[i] + ',' + d[i + 1] + ',' + d[i + 2]) !== first) return true;
  } catch (e) { return true; }
  return false;
}
function setProg(p, txt) {
  $('#shprog').style.display = 'block';
  $('#shprog i').style.width = Math.round(p * 100) + '%';
  if (txt) $('#shnote').textContent = txt;
}
async function onDownload() {
  if (!SH || SH.busy) return;
  if (SH.file) { deliver(SH.file); return; }
  var shid = SH; SH.busy = true;
  var btn = $('#shdl'); btn.disabled = true; btn.textContent = 'WORKING';
  try {
    var f = shid.iframe;
    if (!f) { setProg(0, 'WAITING FOR PIECE'); for (var k = 0; k < 200 && !shid.iframe; k++) await sleep(100); f = shid.iframe; }
    if (!f) throw new Error('PIECE NOT LOADED');
    setProg(0, 'WAITING FOR RENDER');
    var canvas = await waitCanvas(f, 90000);
    for (var w = 0; w < 100 && !canvasLive(canvas); w++) await sleep(150);
    var N = 36, SZ = 480, iw = f.contentWindow;
    var off = document.createElement('canvas'); off.width = off.height = SZ;
    var ox = off.getContext('2d', { willReadFrequently: true }); ox.imageSmoothingEnabled = false;
    var frames = [], t0 = performance.now();
    for (var i = 0; i < N; i++) {
      var wait = t0 + i * 40 - performance.now();
      if (wait > 0) await sleep(wait);
      await Promise.race([new Promise(function (r) { iw.requestAnimationFrame(function () { r(); }); }), sleep(80)]);
      ox.drawImage(canvas, 0, 0, SZ, SZ);
      frames.push(ox.getImageData(0, 0, SZ, SZ).data);
      setProg(0.4 * (i + 1) / N, 'CAPTURING ' + (i + 1) + '/' + N);
    }
    var mod = await import(GIFENC_URL);
    var enc = mod.GIFEncoder();
    for (var j = 0; j < N; j++) {
      var palette = mod.quantize(frames[j], 256);
      var idx = mod.applyPalette(frames[j], palette);
      enc.writeFrame(idx, SZ, SZ, { palette: palette, delay: 40, repeat: 0 });
      setProg(0.4 + 0.6 * (j + 1) / N, 'ENCODING ' + (j + 1) + '/' + N);
      await sleep(0);
    }
    enc.finish();
    var bytes = enc.bytes();
    window.BB.lastGif = bytes;
    var fname = 'blackbox_rec' + p3(shid.rec) + '_' + p2(shid.index) + '.gif';
    var file = new File([bytes], fname, { type: 'image/gif' });
    if (SH !== shid) return;
    shid.file = file;
    setProg(1, 'GIF READY');
    deliver(file, true);
  } catch (e) {
    if (SH === shid) $('#shnote').textContent = 'FAILED: ' + errText(e);
  } finally {
    if (SH === shid) { SH.busy = false; var b = $('#shdl'); b.disabled = false; if (!SH.saved) b.textContent = SH.file ? 'SAVE GIF' : 'DOWNLOAD GIF'; }
  }
}
async function deliver(file, auto) {
  var shid = SH;
  var url = URL.createObjectURL(file);
  var mobile = isMobile();
  if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); if (SH === shid) markSaved(); }
    catch (e) {
      if (SH !== shid) return;
      $('#shnote').textContent = (e && e.name === 'AbortError') ? 'NOT SAVED. TAP SAVE GIF TO TRY AGAIN.' : 'TAP SAVE GIF TO CONTINUE.';
      $('#shdl').textContent = 'SAVE GIF';
    }
    return;
  }
  if (mobile) {
    var w = window.open(url, '_blank');
    if (w) { $('#shnote').textContent = 'LONG PRESS TO SAVE'; markSaved(); }
    else { $('#shnote').textContent = 'LONG PRESS TO SAVE'; $('#shdl').textContent = 'SAVE GIF'; if (!auto) location.href = url; }
    return;
  }
  var a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  markSaved();
  $('#shnote').textContent = 'SAVED ' + file.name;
}

/* ---------- init ---------- */
function init() {
  build();
  if (!NET.contract) { renderUnarmed(); return; }
  discover();
  setTimeout(function () { showOpenIn(false); }, 700);
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - S.lastPoll > POLL_MS) refresh(); });
}

window.BB = { tweet: makeTweet, tweetLen: tweetLen, pieceName: pieceName, deepLink: deepLink, state: S, openShare: openShare, TEMPLATES: TEMPLATES, lastGif: null };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
