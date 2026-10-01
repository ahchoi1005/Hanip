/* 한입 기록장 — Supabase + Leaflet + OpenStreetMap(Photon) */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CFG = window.HANIP_CONFIG || {};
const BUCKET = 'photos';
const FREE_BYTES = 1024 * 1024 * 1024; // Supabase 무료 저장 용량 1GB

const S = {
  rest: new Map(), dishes: new Map(), lists: [],
  tab: 'dishes', tag: null, scores: new Set(), sort: 'score', q: '', list: null,
  scale: '10', detail: null, user: null, here: null, urls: new Map(),
};
try { S.scale = localStorage.getItem('hanip-scale') || '10'; } catch (e) {}
let sb = null, E = null;

/* ---------- helpers ---------- */
const fmt = r => S.scale === '5' ? (r / 2).toFixed(1) : String(Math.round(r * 10) / 10);
const unit = () => S.scale === '5' ? '/5' : '/10';
const tier = r => r >= 9 ? 't4' : r >= 7 ? 't3' : r >= 5 ? 't2' : 't1';
const DEFAULT_GUIDE = {
  10: { name: '인생 메뉴', desc: '이거 먹으러 일부러 다시 간다. 흠잡을 데가 없다' },
  9: { name: '최고', desc: '무조건 다시 시킨다. 단점이 거의 없다' },
  8: { name: '아주 좋음', desc: '재주문 의사 확실. 사소한 아쉬움 정도' },
  7: { name: '좋음', desc: '다시 먹을 만하다. 장점이 단점보다 확실히 많다' },
  6: { name: '양호', desc: '그냥저냥 괜찮은, 단점보다 장점이 약간 더' },
  5: { name: '평범', desc: '돈 내고 다시 시켜먹기 애매, 장점/단점 비슷한' },
  4: { name: '아쉬움', desc: '단점이 장점보다 약간 더. 다시 시키진 않는다' },
  3: { name: '별로', desc: '단점이 확실히 많다' },
  2: { name: '실망', desc: '먹기 힘든 수준에 가깝다' },
  1: { name: '최악', desc: '돈이 아깝다. 거의 못 먹었다' },
};
const guideOf = r => (S.guide && S.guide[Math.round(r)]) || DEFAULT_GUIDE[Math.round(r)] || { name: '', desc: '' };
const badge = r => `<span class="badge ${tier(r)}">${fmt(r)}<small>${unit()}</small></span>`;
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dshow = s => s ? String(s).replace(/-/g, '.') : '';
const tsOf = x => x.created_at ? Date.parse(x.created_at) : 0;
const cmpDate = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || tsOf(a) - tsOf(b);
const mapUrl = (n, a) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([n, a].filter(Boolean).join(' '));
const dishesOf = rid => [...S.dishes.values()].filter(d => d.restaurant_id === rid);
const avg = ds => ds.length ? ds.reduce((s, d) => s + d.rating, 0) / ds.length : null;
const photoUrl = p => { const u = S.urls.get(p.path); return u ? u.url : ''; };
const mb = b => (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + 'MB';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => el.hidden = true, 2600); }
function errMsg(e) {
  const m = (e && (e.message || e.error_description || e.error)) || '';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return '인터넷 연결을 확인해 주세요.';
  if (/JWT|session|not authenticated/i.test(m)) return '로그인이 만료됐어요. 새로고침 후 다시 로그인해 주세요.';
  if (/exceeded|quota|too large|Payload/i.test(m)) return '저장 공간이 부족하거나 파일이 너무 커요.';
  return '저장하지 못했어요. ' + (m ? `(${m})` : '잠시 후 다시 시도해 주세요.');
}
function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2)); }

/* ---------- data ---------- */
async function fetchAll(table, order) {
  const out = []; const size = 1000;
  for (let i = 0; ; i += size) {
    let q = sb.from(table).select('*').range(i, i + size - 1);
    if (order) q = q.order(order);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}
async function reload() {
  const [r, d, l] = await Promise.all([fetchAll('restaurants', 'created_at'), fetchAll('dishes', 'created_at'), fetchAll('lists', 'created_at')]);
  S.rest = new Map(r.map(x => [x.id, x]));
  S.dishes = new Map(d.map(x => [x.id, x]));
  S.lists = l;
  await ensureUrls([...S.dishes.values()].map(x => (x.photos || [])[0]).filter(Boolean));
  render();
}
async function ensureUrls(photos) {
  const now = Date.now();
  const need = [...new Set(photos.map(p => p.path))].filter(p => { const u = S.urls.get(p); return !u || u.exp < now + 60000; });
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(chunk, 60 * 60 * 6);
    if (error) { console.warn(error); continue; }
    data.forEach(x => { if (x.signedUrl) S.urls.set(x.path, { url: x.signedUrl, exp: now + 6 * 3600 * 1000 }); });
  }
}
function usageBytes() { let b = 0; S.dishes.forEach(d => (d.photos || []).forEach(p => b += p.size || 0)); return b; }

/* ---------- place search (OpenStreetMap / Photon) ---------- */
function biasPoint() {
  if (S.here) return S.here;
  if (S.map) { const c = S.map.getCenter(); if (S.mapMoved) return [c.lat, c.lng]; }
  const pts = [...S.rest.values()].filter(r => r.lat != null).sort((a, b) => tsOf(b) - tsOf(a));
  return pts.length ? [pts[0].lat, pts[0].lng] : null;
}
function askHere() {
  if (S.askedHere || !navigator.geolocation) return; S.askedHere = true;
  navigator.geolocation.getCurrentPosition(p => { S.here = [p.coords.latitude, p.coords.longitude]; }, () => {}, { maximumAge: 600000, timeout: 8000 });
}
async function placeSearch(q) {
  let u = 'https://photon.komoot.io/api/?limit=8&q=' + encodeURIComponent(q);
  const b = biasPoint(); if (b) u += `&lat=${b[0]}&lon=${b[1]}`;
  const r = await fetch(u); if (!r.ok) throw new Error('search ' + r.status);
  const j = await r.json();
  return (j.features || []).map(f => {
    const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
    const line1 = [p.housenumber, p.street].filter(Boolean).join(' ');
    const line2 = [p.city || p.town || p.village || p.county, [p.state, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return { name: p.name || line1 || q, address: [line1, line2].filter(Boolean).join(', '), lat: c[1], lng: c[0], kind: p.osm_value || '' };
  });
}
async function geocode(name, address) {
  try { const res = await placeSearch([name, address].filter(Boolean).join(' ')); if (res[0]) return res[0]; } catch (e) {}
  if (address) { try { const res = await placeSearch(address); if (res[0]) return res[0]; } catch (e) {} }
  return null;
}

/* ---------- main render ---------- */
function render() {
  ['dishes', 'rests', 'map'].forEach(t => $('#tab-' + t).classList.toggle('on', S.tab === t));
  const F = $('#filters'), L = $('#list'), M = $('#mapwrap');
  $('#q').hidden = S.tab === 'map';
  L.hidden = S.tab === 'map'; M.hidden = S.tab !== 'map';
  if (S.tab === 'dishes') renderDishes(F, L);
  else if (S.tab === 'rests') renderRests(F, L);
  else renderMap(F);
  if (S.detail) renderDetail();
  if (S.dview) renderDishView();
}
function histogram(arr) {
  const c = Array(11).fill(0); arr.forEach(d => { const r = Math.round(d.rating); if (r >= 1 && r <= 10) c[r]++; });
  const max = Math.max(1, ...c.slice(1)); const sel = S.scores;
  const cols = [];
  for (let v = 1; v <= 10; v++) {
    const g = guideOf(v), h = c[v] ? Math.max(6, Math.round(c[v] / max * 100)) : 0;
    const on = sel.has(v), dim = sel.size && !on;
    cols.push(`<button class="hcol ${on ? 'on' : ''} ${dim ? 'dim' : ''}" data-a="score" data-v="${v}" title="${fmt(v)}점 ${esc(g.name)} · ${c[v]}개" aria-pressed="${on}">
      <span class="hn">${c[v] || ''}</span><span class="hb-wrap"><span class="hb ${tier(v)}" style="height:${h}%"></span></span><span class="hl">${S.scale === '5' ? (v / 2).toFixed(1).replace('.0', '') : v}</span></button>`);
  }
  const selTxt = sel.size ? [...sel].sort((a, b) => b - a).map(v => `${fmt(v)}점 ${esc(guideOf(v).name)}`).join(', ') : '';
  return `<div class="hist-card"><div class="hist-top"><span class="hist-t">점수 분포 <span class="help">막대를 눌러 점수별로 보기</span></span>${sel.size ? `<button class="linkbtn" data-a="scoreclear">선택 해제</button>` : `<button class="linkbtn" data-a="guide">점수 기준 ›</button>`}</div>
  <div class="hist">${cols.join('')}</div>${sel.size ? `<div class="help hist-sel">선택: ${selTxt}</div>` : ''}</div>`;
}
function renderDishes(F, L) {
  const all = [...S.dishes.values()];
  if (!all.length) { F.innerHTML = ''; L.innerHTML = `<div class="empty"><h2>첫 메뉴를 기록해 보세요</h2>먹은 메뉴의 사진, 점수, 음식 종류를 남기면<br>여기서 종류별·점수별로 모아볼 수 있어요.<div style="margin-top:16px"><button class="btn" data-a="add">+ 첫 기록 남기기</button></div></div>`; return; }
  const counts = {}; all.forEach(d => (d.tags || []).forEach(t => counts[t] = (counts[t] || 0) + 1));
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  F.innerHTML = `<div class="chips"><button class="chip ${!S.tag ? 'on' : ''}" data-a="tag" data-v="">모든 종류</button>${tags.map(t => `<button class="chip ${S.tag === t ? 'on' : ''}" data-a="tag" data-v="${esc(t)}">${esc(t)}<span class="n">${counts[t]}</span></button>`).join('')}</div>
`;
  let arr = all; const q = S.q.trim().toLowerCase();
  if (q) arr = arr.filter(d => { const r = S.rest.get(d.restaurant_id); return [d.name, r && r.name, r && r.address, d.note, ...(d.tags || [])].some(x => x && String(x).toLowerCase().includes(q)); });
  if (S.tag) arr = arr.filter(d => (d.tags || []).includes(S.tag));
  F.innerHTML += histogram(arr);
  if (S.scores.size) arr = arr.filter(d => S.scores.has(Math.round(d.rating)));
  arr.sort(S.sort === 'score' ? (a, b) => b.rating - a.rating || cmpDate(b, a) : (a, b) => cmpDate(b, a));
  L.innerHTML = `<div class="bar"><span>메뉴 ${arr.length}개</span><button class="linkbtn" data-a="sort" data-v="${S.sort === 'score' ? 'recent' : 'score'}">${S.sort === 'score' ? '점수 높은 순 ⇅' : '최근 먹은 순 ⇅'}</button></div>` +
    (arr.length ? `<div class="grid">${arr.map(dishCard).join('')}</div>` : `<div class="empty">조건에 맞는 메뉴가 없어요.</div>`);
}
function dishCard(d) {
  const r = S.rest.get(d.restaurant_id); const p = (d.photos || [])[0]; const u = p && photoUrl(p);
  return `<button class="card" data-a="viewdish" data-id="${d.id}"><div class="ph">${u ? `<img src="${esc(u)}" alt="" loading="lazy">` : `<span class="ini">${esc((d.name || '?').slice(0, 1))}</span>`}<span class="score">${badge(d.rating)}</span></div>
  <div class="body"><div class="t">${esc(d.name)}</div><div class="s">${esc(r ? r.name : '식당 정보 없음')}${d.date ? ' · ' + dshow(d.date) : ''}</div>${(d.tags || []).length ? `<div class="tags">${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}</div></button>`;
}
function listChips(extra) {
  return `<div class="chips"><button class="chip ${!S.list ? 'on' : ''}" data-a="list" data-v="">모든 식당</button>${S.lists.map(l => { const n = [...S.rest.values()].filter(r => (r.lists || []).includes(l.id)).length; return `<button class="chip ${S.list === l.id ? 'on' : ''}" data-a="list" data-v="${l.id}">${esc(l.name)}<span class="n">${n}</span></button>`; }).join('')}${extra || ''}</div>`;
}
function restRows() {
  let arr = [...S.rest.values()]; const q = S.q.trim().toLowerCase();
  if (S.list) arr = arr.filter(r => (r.lists || []).includes(S.list));
  if (q && S.tab !== 'map') arr = arr.filter(r => [r.name, r.address, ...dishesOf(r.id).map(d => d.name)].some(x => x && x.toLowerCase().includes(q)));
  return arr.map(r => { const ds = dishesOf(r.id); return { r, ds, a: avg(ds), last: ds.map(d => d.date || '').sort().pop() || '' }; });
}
function renderRests(F, L) {
  F.innerHTML = listChips(`<button class="chip add" data-a="lists">+ 리스트 관리</button>`);
  const rows = restRows();
  rows.sort(S.sort === 'score' ? (x, y) => (y.a ?? -1) - (x.a ?? -1) : (x, y) => (y.last || '').localeCompare(x.last || '') || tsOf(y.r) - tsOf(x.r));
  L.innerHTML = `<div class="bar"><span>식당 ${rows.length}곳</span><span><button class="linkbtn" data-a="newrest">+ 식당만 추가</button><button class="linkbtn" data-a="sort" data-v="${S.sort === 'score' ? 'recent' : 'score'}">${S.sort === 'score' ? '평균 점수 순 ⇅' : '최근 방문 순 ⇅'}</button></span></div>` +
    (rows.length ? `<div class="rows">${rows.map(({ r, ds, a }) => `<button class="rrow" data-a="rest" data-id="${r.id}"><div class="main"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.address || '주소 없음')}${r.lat == null ? ' · 지도 위치 없음' : ''}</div><div class="s">${ds.length ? `메뉴 ${ds.length}개` : '아직 기록한 메뉴 없음'}${(r.lists || []).map(id => S.lists.find(l => l.id === id)).filter(Boolean).map(l => ` · ${esc(l.name)}`).join('')}</div></div>${a != null ? badge(a) : ''}</button>`).join('')}</div>`
      : `<div class="empty">${S.rest.size ? '조건에 맞는 식당이 없어요.' : '아직 식당이 없어요. 메뉴를 기록하면 식당이 함께 추가돼요.'}</div>`);
}

/* ---------- map ---------- */
function tierColor(a) {
  const cs = getComputedStyle(document.documentElement);
  const v = a == null ? '--muted' : a >= 9 ? '--gold' : a >= 7 ? '--t3' : a >= 5 ? '--t2' : '--t1';
  return cs.getPropertyValue(v).trim() || '#888';
}
function renderMap(F) {
  F.innerHTML = listChips();
  if (!window.L) { $('#mapwrap').innerHTML = '<div class="empty">지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.</div>'; return; }
  if (!S.map) {
    S.map = L.map('map', { zoomControl: true }).setView([36.1627, -86.7816], 12);
    // 기본 OpenStreetMap 지도를 CSS로 회색톤 처리 (API 키 필요 없음)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap', className: 'gray-tiles' }).addTo(S.map);
    S.layer = L.layerGroup().addTo(S.map);
    S.map.on('dragend zoomend', () => { S.mapMoved = true; });
  }
  S.layer.clearLayers();
  const rows = restRows().filter(x => x.r.lat != null && x.r.lng != null);
  rows.forEach(({ r, a, ds }) => {
    const m = L.circleMarker([r.lat, r.lng], { radius: 11, weight: 3, color: '#ffffff', fillColor: tierColor(a), fillOpacity: 1, className: 'pin' });
    m.bindTooltip(esc(r.name), { direction: 'top', offset: [0, -10], className: 'pin-label' });
    m.bindPopup(`<div class="pop-t">${esc(r.name)}</div><div>${a != null ? `평균 ${fmt(a)}${unit()} · 메뉴 ${ds.length}개` : '아직 기록 없음'}</div><button class="linkbtn" data-a="rest" data-id="${r.id}" style="padding:4px 0">자세히 보기 ›</button>`);
    S.layer.addLayer(m);
  });
  setTimeout(() => {
    S.map.invalidateSize();
    const key = (S.list || '') + ':' + rows.length;
    if (rows.length && S.fitKey !== key) { S.fitKey = key; S.map.fitBounds(L.latLngBounds(rows.map(x => [x.r.lat, x.r.lng])), { padding: [30, 30], maxZoom: 15 }); }
  }, 50);
  const missing = restRows().filter(x => x.r.lat == null).length;
  F.innerHTML += missing ? `<div class="help" style="margin-bottom:8px">지도 위치가 없는 식당 ${missing}곳은 표시되지 않아요. 식당 수정에서 위치를 찾을 수 있어요.</div>` : '';
}

/* ---------- restaurant detail ---------- */
async function openDetail(id) {
  S.detail = id; renderDetail(); $('#detail').scrollTop = 0;
  const ph = dishesOf(id).flatMap(d => d.photos || []);
  if (ph.some(p => !S.urls.has(p.path))) { await ensureUrls(ph); if (S.detail === id) renderDetail(); }
}
function renderDetail() {
  const el = $('#detail'), r = S.rest.get(S.detail);
  if (!r) { el.hidden = true; S.detail = null; return; }
  const ds = dishesOf(r.id).sort((a, b) => b.rating - a.rating || cmpDate(b, a)); const a = avg(ds);
  el.innerHTML = `<div class="wrap"><div class="ovhead"><button class="back" data-a="closedetail">‹ 목록</button><button class="linkbtn" data-a="editrest" data-id="${r.id}">식당 수정</button></div>
  <div class="dtitle">${esc(r.name)}</div>
  <div class="addr"><span>${esc(r.address || '주소 없음')}</span><a href="${mapUrl(r.name, r.address)}" target="_blank" rel="noopener">구글 지도에서 열기 ↗</a></div>
  ${r.lat == null ? `<div class="note-box" style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span>지도 위치가 없어서 지도 탭에 안 보여요.</span><button class="btn small" data-a="pickrest" data-id="${r.id}">📍 위치 찍기</button></div>` : ''}
  <div class="stat">${a != null ? `<span>평균 ${badge(a)}</span>` : ''}<span class="help">메뉴 ${ds.length}개</span></div>
  <div class="chips wrapc">${S.lists.map(l => `<button class="chip ${(r.lists || []).includes(l.id) ? 'on' : ''}" data-a="togglelist" data-id="${r.id}" data-v="${l.id}">${(r.lists || []).includes(l.id) ? '✓ ' : ''}${esc(l.name)}</button>`).join('')}<button class="chip add" data-a="lists">+ 리스트</button></div>
  <div class="sec">먹은 메뉴</div>
  <div class="rows">${ds.map(d => `<div class="dish"><div class="hd"><div class="t">${esc(d.name)}</div>${badge(d.rating)}</div>
    ${(d.photos || []).length ? `<div class="strip">${d.photos.map(p => `<img src="${esc(photoUrl(p))}" alt="" data-a="photo" data-p="${esc(p.path)}" loading="lazy">`).join('')}</div>` : ''}
    <div class="meta">${[dshow(d.date), d.price].filter(Boolean).map(esc).join(' · ')}</div>
    ${(d.tags || []).length ? `<div class="tags">${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
    <div><button class="linkbtn" data-a="dish" data-id="${d.id}">수정</button></div></div>`).join('') || '<div class="empty">아직 기록한 메뉴가 없어요.</div>'}</div>
  <div class="actions"><button class="btn grow" data-a="add" data-r="${r.id}">+ 이 식당에 메뉴 추가</button></div></div>`;
  el.hidden = false;
}

/* ---------- dish view ---------- */
async function openDishView(id) {
  S.dview = id; renderDishView(); $('#dview').scrollTop = 0;
  const d = S.dishes.get(id); const ph = (d && d.photos) || [];
  if (ph.some(p => !S.urls.has(p.path))) { await ensureUrls(ph); if (S.dview === id) renderDishView(); }
}
function closeDishView() { S.dview = null; const el = $('#dview'); el.hidden = true; el.innerHTML = ''; }
function renderDishView() {
  const el = $('#dview'), d = S.dishes.get(S.dview);
  if (!d) { closeDishView(); return; }
  const r = S.rest.get(d.restaurant_id) || {};
  const ph = d.photos || [];
  const others = dishesOf(d.restaurant_id).filter(x => x.id !== d.id).sort((a, b) => b.rating - a.rating);
  el.innerHTML = `<div class="wrap"><div class="ovhead"><button class="back" data-a="closedview">‹ 목록</button><button class="btn small" data-a="dish" data-id="${d.id}">수정</button></div>
  ${ph.length ? `<img class="hero" src="${esc(photoUrl(ph[0]))}" alt="" data-a="photo" data-p="${esc(ph[0].path)}">` : `<div class="hero-empty">${esc((d.name || '?').slice(0, 1))}</div>`}
  ${ph.length > 1 ? `<div class="strip" style="margin-top:8px">${ph.slice(1).map(p => `<img src="${esc(photoUrl(p))}" alt="" data-a="photo" data-p="${esc(p.path)}" loading="lazy">`).join('')}</div>` : ''}
  <div class="dv-head"><div class="dtitle">${esc(d.name)}</div><div style="text-align:right;flex:none">${badge(d.rating)}<div class="help" style="margin-top:4px">${esc(guideOf(d.rating).name)}</div></div></div>
  <div class="help" style="font-size:14px;margin-top:4px">${[dshow(d.date), d.price].filter(Boolean).map(esc).join(' · ')}</div>
  ${(d.tags || []).length ? `<div class="tags" style="margin-top:8px">${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
  <button class="restlink" data-a="rest" data-id="${esc(r.id || '')}"><div style="min-width:0"><div class="t">${esc(r.name || '식당 정보 없음')}</div><div class="s">${esc(r.address || '')}</div></div><span class="linkbtn" style="white-space:nowrap;flex:none">식당 보기 ›</span></button>
  ${d.note ? `<div class="sec">메모</div><div class="dv-note">${esc(d.note)}</div>` : ''}
  ${others.length ? `<div class="sec">이 식당의 다른 메뉴</div><div class="rows">${others.map(x => `<button class="rrow" data-a="viewdish" data-id="${x.id}"><div class="main"><div class="t">${esc(x.name)}</div><div class="s">${dshow(x.date)}</div></div>${badge(x.rating)}</button>`).join('')}</div>` : ''}
  </div>`;
  el.hidden = false;
}

/* ---------- score guide ---------- */
function openGuide(edit, keepDraft) {
  const el = $('#guide');
  const prevE = el.hidden ? null : el._draft;
  const draft = keepDraft && E && E.draft ? E.draft : (prevE || JSON.parse(JSON.stringify(Object.assign({}, DEFAULT_GUIDE, S.guide || {}))));
  if (E && keepDraft) E.draft = null;
  el._draft = draft; el._edit = !!edit;
  const rows = [];
  for (let v = 10; v >= 1; v--) {
    const g = draft[v] || { name: '', desc: '' };
    rows.push(edit
      ? `<div class="grow-row">${badge(v)}<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px"><input class="in" id="g-n-${v}" value="${esc(g.name)}" placeholder="이름 (예: 평범)"><input class="in" id="g-d-${v}" value="${esc(g.desc)}" placeholder="설명"></div></div>`
      : `<div class="grow-row">${badge(v)}<div style="min-width:0"><div class="t">${esc(g.name)}</div><div class="s">${esc(g.desc)}</div></div></div>`);
  }
  el.innerHTML = `<div class="wrap"><div class="ovhead"><button class="back" data-a="guideclose">${edit ? '취소' : '닫기'}</button><h2>점수 기준표</h2>${edit ? `<button class="btn small" id="g-save" data-a="guidesave">저장</button>` : `<button class="btn ghost small" data-a="guideedit">편집</button>`}</div>
  <div class="help" style="margin-bottom:12px">${S.scale === '5' ? '★5점 표시는 이 기준의 절반 값이에요 (예: 9점 = 4.5).' : '메뉴 점수를 매길 때 이 기준을 참고하세요.'}</div>
  <div class="rows">${rows.join('')}</div><div class="err" id="g-err" style="margin-top:10px"></div>
  ${edit ? `<div class="actions"><button class="btn ghost small" data-a="guidereset">기본 기준으로 되돌리기</button></div>` : ''}</div>`;
  el.hidden = false; el.scrollTop = 0;
}
function readGuideDraft() {
  const g = {}; for (let v = 1; v <= 10; v++) g[v] = { name: ($('#g-n-' + v).value || '').trim(), desc: ($('#g-d-' + v).value || '').trim() }; return g;
}
async function saveGuide() {
  const g = readGuideDraft(); const btn = $('#g-save'); btn.disabled = true;
  const { error } = await sb.auth.updateUser({ data: { score_guide: g } });
  if (error) { btn.disabled = false; $('#g-err').textContent = errMsg(error); return; }
  S.guide = g; toast('기준표를 저장했어요'); $('#guide')._draft = null; openGuide(false); render();
  if (E && E.kind === 'dish') renderRate();
}

/* ---------- sheets ---------- */
function openSheet(html) { const s = $('#sheet'); s.innerHTML = `<div class="wrap">${html}</div>`; s.hidden = false; s.scrollTop = 0; }
function closeSheet() { if (E && E.pickMap) { try { E.pickMap.remove(); } catch (e) {} } const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; if (E && E.newFiles) E.newFiles.forEach(f => URL.revokeObjectURL(f.url)); E = null; }

/* place picker used by dish + restaurant editors */
function placePicker(boxSel, onPick, initialName) {
  const box = $(boxSel);
  box.innerHTML = `<input class="in" id="pp-q" placeholder="식당 이름으로 검색 (예: Hattie B's)" autocomplete="off" value="${esc(initialName || '')}">
  <div class="sug" id="pp-sug" hidden></div>
  <div class="help">검색 결과에 없으면 <button type="button" class="linkbtn" data-a="ppmanual" style="padding:0">직접 입력</button>하세요.</div>`;
  const qi = $('#pp-q'), sg = $('#pp-sug'); let tmr = null, seq = 0;
  E.ppPick = onPick; E.ppResults = []; E.ppLocal = [];
  qi.addEventListener('focus', askHere, { once: true });
  qi.addEventListener('input', () => {
    clearTimeout(tmr); const q = qi.value.trim();
    const local = q ? [...S.rest.values()].filter(x => x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 4) : [];
    E.ppLocal = local;
    const draw = (remote, loading) => {
      E.ppResults = remote;
      const html = (local.length ? `<div class="hdr">내가 기록한 식당</div>` + local.map(x => `<button type="button" data-a="pplocal" data-id="${x.id}">${esc(x.name)}<small>${esc(x.address || '주소 없음')}</small></button>`).join('') : '') +
        (loading ? `<div class="hdr">지도에서 찾는 중…</div>` : remote.length ? `<div class="hdr">지도 검색 결과</div>` + remote.map((x, i) => `<button type="button" data-a="ppremote" data-v="${i}">${esc(x.name)}<small>${esc(x.address || '')}${x.kind ? ' · ' + esc(x.kind) : ''}</small></button>`).join('') : (q.length > 1 ? `<div class="hdr">지도 검색 결과 없음</div>` : ''));
      sg.innerHTML = html; sg.hidden = !html;
    };
    if (q.length < 2) { draw([], false); return; }
    draw([], true);
    tmr = setTimeout(async () => {
      const my = ++seq;
      try { const res = await placeSearch(q); if (my === seq && E && E.ppPick) draw(res, false); }
      catch (e) { if (my === seq) { sg.innerHTML = (sg.innerHTML.split('<div class="hdr">지도에서')[0]) + `<div class="hdr">지도 검색을 할 수 없어요. 직접 입력해 주세요.</div>`; } }
    }, 400);
  });
}

/* ---------- dish editor ---------- */
function openDish({ dishId = null, restId = null } = {}) {
  const d = dishId ? S.dishes.get(dishId) : null;
  E = { kind: 'dish', id: dishId, restId: d ? d.restaurant_id : restId, newRest: null, rating: d ? d.rating : 0, tags: d ? [...(d.tags || [])] : [], photos: d ? [...(d.photos || [])] : [], newFiles: [], removed: [], saving: false, armDel: false };
  openSheet(`<div class="ovhead"><button class="back" data-a="cancel">취소</button><h2>${d ? '메뉴 수정' : '새 기록'}</h2><button class="btn" id="e-save" data-a="savedish">저장</button></div>
  <div class="f"><span class="lbl">식당</span><div id="e-rest"></div></div>
  <div class="f"><label for="e-name">메뉴 이름</label><input id="e-name" class="in" value="${esc(d ? d.name : '')}" placeholder="예: 핫치킨 샌드위치"></div>
  <div class="f"><span class="lbl">점수 <span class="ratehint" id="e-rv"></span></span><div class="rate" id="e-rate"></div><div class="gline" id="e-guide"></div></div>
  <div class="f"><span class="lbl">사진</span><div class="phs" id="e-phs"></div><input id="e-file" type="file" accept="image/*" multiple hidden></div>
  <div class="f"><label for="e-tag">음식 종류 태그</label><div class="tags" id="e-tags"></div><input id="e-tag" class="in" placeholder="입력 후 Enter (예: 치킨, 버거)" autocomplete="off" enterkeyhint="done"><div class="chips wrapc" id="e-tagsug" style="margin:0"></div></div>
  <div class="two"><div class="f"><label for="e-date">먹은 날</label><input id="e-date" type="date" class="in" value="${esc(d && d.date || today())}"></div>
  <div class="f"><label for="e-price">가격</label><input id="e-price" class="in" value="${esc(d && d.price || '')}" placeholder="예: $16"></div></div>
  <div class="f"><label for="e-note">메모</label><textarea id="e-note" class="in" placeholder="맛, 양, 다음에 시킬 것…">${esc(d && d.note || '')}</textarea></div>
  <div class="err" id="e-err"></div>
  ${d ? `<div class="actions"><button class="btn danger" id="e-del" data-a="deldish">이 메뉴 삭제</button></div>` : ''}`);
  renderPick(); renderRate(); renderPhotos(); renderTags();
  $('#e-tag').addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); addTag(ev.target.value); } });
  $('#e-tag').addEventListener('input', renderTags);
  $('#e-tag').addEventListener('blur', ev => { if (ev.target.value.trim()) addTag(ev.target.value); });
  $('#e-file').addEventListener('change', ev => { [...ev.target.files].forEach(f => E.newFiles.push({ f, url: URL.createObjectURL(f) })); ev.target.value = ''; renderPhotos(); });
  if (E.photos.length) ensureUrls(E.photos).then(() => E && E.kind === 'dish' && renderPhotos());
}
function renderPick() {
  const box = $('#e-rest'); if (!box) return;
  const r = E.restId && S.rest.get(E.restId);
  if (r) { box.innerHTML = `<div class="picked"><div style="min-width:0"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.address || '주소 없음')}</div></div><button class="linkbtn" data-a="changerest">변경</button></div>`; return; }
  if (E.newRest && !E.manual) { const n = E.newRest; box.innerHTML = `<div class="picked"><div style="min-width:0"><div class="t">${esc(n.name)} <span class="help">새 식당</span></div><div class="s">${esc(n.address || '주소 없음')}</div></div><button class="linkbtn" data-a="changerest">변경</button></div>`; return; }
  if (E.manual) {
    box.innerHTML = `<input id="m-name" class="in" placeholder="식당 이름" value="${esc(E.newRest && E.newRest.name || '')}"><input id="m-addr" class="in" placeholder="주소 (선택)" style="margin-top:6px" value="${esc(E.newRest && E.newRest.address || '')}"><div class="help">주소를 넣으면 저장할 때 지도 위치를 자동으로 찾아요. <button type="button" class="linkbtn" data-a="changerest" style="padding:0">검색으로 돌아가기</button></div>`;
    return;
  }
  const div = document.createElement('div'); div.id = 'e-pp'; box.innerHTML = ''; box.appendChild(div);
  placePicker('#e-pp', pick => { if (pick.local) { E.restId = pick.local; E.newRest = null; } else { E.newRest = pick; } renderPick(); });
}
function renderRate() {
  const el = $('#e-rate'); if (!el) return;
  el.innerHTML = Array.from({ length: 10 }, (_, i) => i + 1).map(v => `<button type="button" data-a="rate" data-v="${v}" class="${v === E.rating ? 'on' : v < E.rating ? 'fill' : ''}" aria-label="${fmt(v)}점">${S.scale === '5' ? (v / 2).toFixed(1).replace('.0', '') : v}</button>`).join('');
  $('#e-rv').textContent = E.rating ? `${fmt(E.rating)} ${unit()}` : '';
  const g = E.rating ? guideOf(E.rating) : null;
  $('#e-guide').innerHTML = g ? `<b>${esc(g.name)}</b> — ${esc(g.desc)} <button type="button" class="linkbtn" data-a="guide" style="padding:0 0 0 4px">기준표</button>` : `점수를 누르면 기준이 보여요. <button type="button" class="linkbtn" data-a="guide" style="padding:0">기준표 보기</button>`;
}
function renderPhotos() {
  const el = $('#e-phs'); if (!el) return;
  el.innerHTML = E.photos.map(p => `<div class="p"><img src="${esc(photoUrl(p))}" alt=""><button type="button" data-a="rmphoto" data-p="${esc(p.path)}" aria-label="사진 빼기">×</button></div>`).join('') +
    E.newFiles.map((n, i) => `<div class="p"><img src="${n.url}" alt=""><button type="button" data-a="rmnew" data-v="${i}" aria-label="사진 빼기">×</button></div>`).join('') +
    `<label class="addp" for="e-file">+ 사진</label>`;
}
function allTags() { const c = {}; S.dishes.forEach(d => (d.tags || []).forEach(t => c[t] = (c[t] || 0) + 1)); return Object.keys(c).sort((a, b) => c[b] - c[a]); }
function renderTags() {
  const el = $('#e-tags'); if (!el) return;
  el.innerHTML = E.tags.map(t => `<button type="button" class="chip on" data-a="rmtag" data-v="${esc(t)}">${esc(t)} ×</button>`).join('');
  const q = ($('#e-tag').value || '').trim().toLowerCase();
  const s = allTags().filter(t => !E.tags.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 12);
  $('#e-tagsug').innerHTML = s.map(t => `<button type="button" class="chip" data-a="addtag" data-v="${esc(t)}">+ ${esc(t)}</button>`).join('');
}
function addTag(v) { v = String(v || '').replace(/,/g, '').trim(); if (v && !E.tags.includes(v)) E.tags.push(v); const i = $('#e-tag'); if (i) i.value = ''; renderTags(); }
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file); let w = bmp.width, h = bmp.height; const k = Math.min(1, 1600 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const b = await new Promise(r => cv.toBlob(r, 'image/jpeg', .82)); if (b) return b;
  } catch (e) {
    try { // Safari fallback via <img>
      const url = URL.createObjectURL(file); const im = new Image(); im.src = url; await im.decode();
      let w = im.naturalWidth, h = im.naturalHeight; const k = Math.min(1, 1600 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(im, 0, 0, w, h); URL.revokeObjectURL(url);
      const b = await new Promise(r => cv.toBlob(r, 'image/jpeg', .82)); if (b) return b;
    } catch (e2) {}
  }
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  throw new Error('이 사진 형식은 올릴 수 없어요');
}
async function uploadPhoto(blob) {
  const path = `${S.user.id}/${uuid()}.jpg`;
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
  if (error) throw error;
  return { path, size: blob.size };
}
async function removePhotos(paths) { if (paths.length) { try { await sb.storage.from(BUCKET).remove(paths); } catch (e) {} } }
async function insertRestaurant(n) {
  let { lat = null, lng = null } = n;
  if (lat == null && (n.address || n.name) && n.geocode !== false) { const g = await geocode(n.name, n.address); if (g) { lat = g.lat; lng = g.lng; } }
  const { data, error } = await sb.from('restaurants').insert({ name: n.name, address: n.address || '', lat, lng, lists: n.lists || [] }).select().single();
  if (error) throw error; return data;
}
async function saveDish() {
  if (E.saving) return; const er = $('#e-err'); er.textContent = '';
  if (E.manual) { const nm = ($('#m-name').value || '').trim(); E.newRest = nm ? { name: nm, address: ($('#m-addr').value || '').trim() } : null; }
  const name = $('#e-name').value.trim();
  if (!E.restId && !E.newRest && $('#pp-q') && $('#pp-q').value.trim()) E.newRest = { name: $('#pp-q').value.trim(), address: '' };
  if (!E.restId && !E.newRest) { er.textContent = '식당을 골라 주세요.'; return; }
  if (!name) { er.textContent = '메뉴 이름을 입력해 주세요.'; return; }
  if (!E.rating) { er.textContent = '점수를 골라 주세요.'; return; }
  E.saving = true; const btn = $('#e-save'); btn.disabled = true; btn.textContent = '저장 중…';
  try {
    let restId = E.restId;
    if (!restId) {
      const ex = [...S.rest.values()].find(x => x.name.trim().toLowerCase() === E.newRest.name.trim().toLowerCase() && (x.address || '').trim() === (E.newRest.address || '').trim());
      restId = ex ? ex.id : (await insertRestaurant(E.newRest)).id;
    }
    const up = [];
    for (let i = 0; i < E.newFiles.length; i++) { btn.textContent = `사진 ${i + 1}/${E.newFiles.length}…`; up.push(await uploadPhoto(await shrink(E.newFiles[i].f))); }
    const body = { restaurant_id: restId, name, rating: E.rating, tags: E.tags, photos: [...E.photos, ...up], date: $('#e-date').value || null, price: $('#e-price').value.trim(), note: $('#e-note').value.trim(), updated_at: new Date().toISOString() };
    const res = E.id ? await sb.from('dishes').update(body).eq('id', E.id) : await sb.from('dishes').insert(body);
    if (res.error) { await removePhotos(up.map(p => p.path)); throw res.error; }
    await removePhotos(E.removed);
    closeSheet(); toast('저장했어요'); await reload();
  } catch (e) { if (E) { E.saving = false; btn.disabled = false; btn.textContent = '저장'; er.textContent = errMsg(e); } }
}
async function delDish() {
  const b = $('#e-del'); if (!E.armDel) { E.armDel = true; b.classList.add('arm'); b.textContent = '한 번 더 누르면 삭제돼요'; return; }
  try { const d = S.dishes.get(E.id); const { error } = await sb.from('dishes').delete().eq('id', E.id); if (error) throw error; await removePhotos((d.photos || []).map(p => p.path)); closeSheet(); toast('삭제했어요'); await reload(); }
  catch (e) { $('#e-err').textContent = errMsg(e); }
}

/* ---------- restaurant editor ---------- */
function openRest(id, withPicker) {
  const r = id ? S.rest.get(id) : null;
  E = { kind: 'rest', id, lists: r ? [...(r.lists || [])] : (S.list ? [S.list] : []), lat: r ? r.lat : null, lng: r ? r.lng : null, armDel: false };
  openSheet(`<div class="ovhead"><button class="back" data-a="cancel">취소</button><h2>${r ? '식당 수정' : '식당 추가'}</h2><button class="btn" id="r-save" data-a="saverest">저장</button></div>
  ${r ? '' : '<div class="note-box">가보고 싶은 곳처럼 아직 먹은 메뉴가 없는 식당을 리스트에 담을 때 쓰세요.</div>'}
  <div class="f"><span class="lbl">지도에서 찾기</span><div id="r-pp"></div></div>
  <div class="f"><label for="r-name">식당 이름</label><input id="r-name" class="in" value="${esc(r ? r.name : '')}"></div>
  <div class="f"><label for="r-addr">주소</label><input id="r-addr" class="in" value="${esc(r ? r.address || '' : '')}"><div class="help" id="r-loc"></div>
  <button type="button" class="btn ghost small" data-a="pickmap" style="align-self:flex-start">📍 지도에서 위치 찍기</button>
  <div id="r-pick" hidden><div id="r-pickmap" style="height:280px;border-radius:12px;overflow:hidden;border:1px solid var(--line)"></div><div class="help" style="margin-top:4px">지도를 움직여 식당 자리를 누르세요. 핀을 끌어서 옮길 수도 있어요.</div></div></div>
  <div class="f"><span class="lbl">리스트</span><div class="chips wrapc" id="r-lists"></div></div>
  <div class="err" id="e-err"></div>
  ${r ? `<div class="actions"><button class="btn danger" id="r-del" data-a="delrest">식당과 메뉴 기록 모두 삭제</button></div>` : ''}`);
  placePicker('#r-pp', pick => {
    if (pick.local) { const x = S.rest.get(pick.local); pick = { name: x.name, address: x.address, lat: x.lat, lng: x.lng }; }
    $('#r-name').value = pick.name; $('#r-addr').value = pick.address || ''; E.lat = pick.lat; E.lng = pick.lng; E.manualLoc = false; E.addrChanged = false; if (E.pickPin && pick.lat != null) { E.pickPin.setLatLng([pick.lat, pick.lng]); E.pickMap.setView([pick.lat, pick.lng], 17); } $('#pp-sug').hidden = true; renderLoc();
  });
  $('#r-addr').addEventListener('input', () => { if (!E.manualLoc) E.addrChanged = true; renderLoc(); });
  renderLoc(); renderRestLists();
  if (withPicker) openPickMap();
}
function renderLoc() {
  const el = $('#r-loc'); if (!el) return;
  el.innerHTML = E.manualLoc ? '지도에서 찍은 위치로 저장해요 ✓' : E.lat != null && !E.addrChanged ? '지도 위치 있음 ✓' : '저장할 때 주소로 지도 위치를 찾아요. 못 찾으면 지도에서 직접 찍어 주세요.';
}
const pickIcon = () => L.divIcon({ className: 'pick-pin', iconSize: [24, 24], iconAnchor: [12, 12] });
function openPickMap() {
  if (!window.L) { toast('지도를 불러오지 못했어요.'); return; }
  const box = $('#r-pick'); if (!box) return; box.hidden = false;
  if (E.pickMap) { E.pickMap.invalidateSize(); return; }
  const start = E.lat != null ? [E.lat, E.lng] : (biasPoint() || [36.1627, -86.7816]);
  const m = L.map('r-pickmap').setView(start, E.lat != null ? 17 : 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
  E.pickMap = m;
  const place = ll => {
    E.lat = ll.lat; E.lng = ll.lng; E.manualLoc = true; E.addrChanged = false;
    if (!E.pickPin) { E.pickPin = L.marker(ll, { draggable: true, icon: pickIcon() }).addTo(m); E.pickPin.on('dragend', ev => place(ev.target.getLatLng())); }
    else E.pickPin.setLatLng(ll);
    renderLoc();
  };
  if (E.lat != null) { E.pickPin = L.marker(start, { draggable: true, icon: pickIcon() }).addTo(m); E.pickPin.on('dragend', ev => place(ev.target.getLatLng())); }
  m.on('click', ev => place(ev.latlng));
  setTimeout(() => m.invalidateSize(), 60);
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function renderRestLists() {
  const el = $('#r-lists'); if (!el) return;
  el.innerHTML = S.lists.map(l => `<button type="button" class="chip ${E.lists.includes(l.id) ? 'on' : ''}" data-a="rlist" data-v="${l.id}">${E.lists.includes(l.id) ? '✓ ' : ''}${esc(l.name)}</button>`).join('') || '<span class="help">리스트가 없어요. 식당 탭의 "+ 리스트 관리"에서 만들 수 있어요.</span>';
}
async function saveRest() {
  const name = $('#r-name').value.trim(), address = $('#r-addr').value.trim();
  if (!name) { $('#e-err').textContent = '식당 이름을 입력해 주세요.'; return; }
  const btn = $('#r-save'); btn.disabled = true; btn.textContent = '저장 중…';
  try {
    let lat = E.addrChanged ? null : E.lat, lng = E.addrChanged ? null : E.lng;
    if (lat == null && (address || name)) { const g = await geocode(name, address); if (g) { lat = g.lat; lng = g.lng; } }
    const body = { name, address, lat, lng, lists: E.lists };
    const res = E.id ? await sb.from('restaurants').update(body).eq('id', E.id) : await sb.from('restaurants').insert(body);
    if (res.error) throw res.error;
    closeSheet(); toast(lat == null ? '저장했어요. 지도 위치는 찾지 못했어요.' : '저장했어요'); await reload();
  } catch (e) { btn.disabled = false; btn.textContent = '저장'; $('#e-err').textContent = errMsg(e); }
}
async function delRest() {
  const b = $('#r-del'); if (!E.armDel) { E.armDel = true; b.classList.add('arm'); b.textContent = '한 번 더 누르면 모두 삭제돼요'; return; }
  try {
    const paths = dishesOf(E.id).flatMap(d => (d.photos || []).map(p => p.path));
    const { error } = await sb.from('restaurants').delete().eq('id', E.id); if (error) throw error; // dishes cascade
    await removePhotos(paths);
    closeSheet(); S.detail = null; $('#detail').hidden = true; toast('삭제했어요'); await reload();
  } catch (e) { $('#e-err').textContent = errMsg(e); }
}

/* ---------- lists ---------- */
function openLists() {
  E = { kind: 'lists', arm: null };
  openSheet(`<div class="ovhead"><button class="back" data-a="cancel">닫기</button><h2>리스트 관리</h2><span></span></div>
  <div class="f"><label for="l-name">새 리스트</label><div style="display:flex;gap:8px"><input id="l-name" class="in" placeholder="예: 재방문, 가보고 싶은 곳"><button class="btn" data-a="addlist">만들기</button></div></div>
  <div class="err" id="e-err"></div><div class="rows" id="l-rows"></div>`);
  $('#l-name').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addList(); } });
  renderListRows();
}
function renderListRows() {
  const el = $('#l-rows'); if (!el) return;
  el.innerHTML = S.lists.map(l => `<div class="rrow"><div class="main"><div class="t">${esc(l.name)}</div><div class="s">식당 ${[...S.rest.values()].filter(r => (r.lists || []).includes(l.id)).length}곳</div></div><button class="btn danger small ${E.arm === l.id ? 'arm' : ''}" data-a="dellist" data-v="${l.id}">${E.arm === l.id ? '정말 삭제' : '삭제'}</button></div>`).join('') || '<div class="help">아직 리스트가 없어요.</div>';
}
async function addList() {
  const i = $('#l-name'), n = i.value.trim(); if (!n) return;
  const { error } = await sb.from('lists').insert({ name: n }); if (error) { $('#e-err').textContent = errMsg(error); return; }
  i.value = ''; toast('리스트를 만들었어요'); await reload(); renderListRows();
}
async function delList(id) {
  try {
    const { error } = await sb.from('lists').delete().eq('id', id); if (error) throw error;
    for (const r of S.rest.values()) if ((r.lists || []).includes(id)) await sb.from('restaurants').update({ lists: r.lists.filter(x => x !== id) }).eq('id', r.id);
    if (S.list === id) S.list = null; E.arm = null; toast('리스트를 삭제했어요'); await reload(); renderListRows();
  } catch (e) { $('#e-err').textContent = errMsg(e); }
}

/* ---------- settings / backup ---------- */
function openSettings() {
  E = { kind: 'settings', busy: false };
  const used = usageBytes(), pct = Math.min(100, used / FREE_BYTES * 100);
  const np = [...S.dishes.values()].reduce((s, d) => s + (d.photos || []).length, 0);
  openSheet(`<div class="ovhead"><button class="back" data-a="cancel">닫기</button><h2>설정 · 백업</h2><span></span></div>
  <div class="sec">점수 표시</div>
  <div class="chips"><button class="chip ${S.scale === '10' ? 'on' : ''}" data-a="scale" data-v="10">10점 만점</button><button class="chip ${S.scale === '5' ? 'on' : ''}" data-a="scale" data-v="5">★ 5점 만점 (0.5 단위)</button></div>
  <div class="sec">사진 저장 공간</div>
  <div class="note-box">사진 ${np}장 · ${mb(used)} / 1GB 사용 (${pct.toFixed(1)}%)<div class="meter"><i style="width:${Math.max(pct, .5)}%"></i></div>
  <div class="help" style="margin-top:6px">${pct > 80 ? '용량이 거의 찼어요. 사진을 따로 옮기는 방법은 안내서의 "용량이 찼을 때"를 보세요.' : `이 속도면 사진 약 ${Math.round((FREE_BYTES - used) / Math.max(used / Math.max(np, 1), 250000)).toLocaleString()}장을 더 올릴 수 있어요.`}</div></div>
  <div class="sec">백업</div>
  <div class="rows">
    <div class="rrow"><div class="main"><div class="t">표 파일 (CSV)</div><div class="s">메뉴 하나가 한 줄. 엑셀·구글 시트에서 열려요. 사진 제외.</div></div><button class="btn small" data-a="excsv">받기</button></div>
    <div class="rrow"><div class="main"><div class="t">사진 포함 전체 백업 (ZIP)</div><div class="s">표 파일 + 모든 사진 + 전체 데이터. 사진이 많으면 오래 걸려요.</div></div><button class="btn small" data-a="exzip">받기</button></div>
    <div class="rrow"><div class="main"><div class="t">백업 불러오기</div><div class="s">이 앱이나 claude.ai 한입 기록장에서 받은 ZIP 백업을 추가해요. 기존 기록은 지워지지 않아요.</div></div><label class="btn small" for="imp-file">파일 선택</label><input id="imp-file" type="file" accept=".zip,application/zip" hidden></div>
  </div>
  <div class="err" id="e-err" style="margin-top:12px"></div><div class="help" id="ex-prog"></div>
  <div class="sec">계정</div>
  <div class="rrow"><div class="main"><div class="t">${esc(S.user.email || '')}</div><div class="s">로그인한 계정</div></div><button class="btn ghost small" data-a="logout">로그아웃</button></div>`);
  $('#imp-file').addEventListener('change', ev => { const f = ev.target.files[0]; ev.target.value = ''; if (f) importZip(f); });
}
function csvText() {
  const q = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const listName = id => (S.lists.find(l => l.id === id) || {}).name;
  const head = ['식당', '주소', '위도', '경도', '메뉴', '점수(10점)', '점수(5점)', '음식 종류', '먹은 날', '가격', '메모', '식당 리스트', '사진 수'];
  const rows = [...S.dishes.values()].sort((a, b) => cmpDate(b, a)).map(d => {
    const r = S.rest.get(d.restaurant_id) || {};
    return [r.name, r.address, r.lat, r.lng, d.name, d.rating, (d.rating / 2).toFixed(1), (d.tags || []).join(', '), d.date, d.price, d.note, (r.lists || []).map(listName).filter(Boolean).join(', '), (d.photos || []).length];
  });
  S.rest.forEach(r => { if (!dishesOf(r.id).length) rows.push([r.name, r.address, r.lat, r.lng, '', '', '', '', '', '', '', (r.lists || []).map(listName).filter(Boolean).join(', '), 0]); });
  return '﻿' + [head, ...rows].map(r => r.map(q).join(',')).join('\r\n');
}
function downloadBlob(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
const stamp = () => today().replace(/-/g, '');
function exportCsv() { downloadBlob(`한입기록장_${stamp()}.csv`, new Blob([csvText()], { type: 'text/csv;charset=utf-8' })); }
const photoKey = p => p.path.split('/').pop().replace(/\.[a-z]+$/i, '');
async function exportZip() {
  if (E.busy) return; const err = $('#e-err'), pg = $('#ex-prog'); err.textContent = '';
  if (!window.JSZip) { err.textContent = '백업 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'; return; }
  E.busy = true;
  try {
    const zip = new JSZip();
    zip.file('기록.csv', csvText());
    zip.file('data.json', JSON.stringify({
      app: 'hanip', version: 2, exportedAt: new Date().toISOString(), lists: S.lists.map(l => ({ id: l.id, name: l.name })),
      restaurants: [...S.rest.values()].map(r => ({ id: r.id, name: r.name, address: r.address, lat: r.lat, lng: r.lng, lists: r.lists || [], createdAt: tsOf(r) })),
      dishes: [...S.dishes.values()].map(d => ({ id: d.id, restId: d.restaurant_id, name: d.name, rating: d.rating, tags: d.tags || [], photos: (d.photos || []).map(photoKey), date: d.date, price: d.price, note: d.note, createdAt: tsOf(d) })),
    }, null, 2));
    const photos = [...S.dishes.values()].flatMap(d => d.photos || []); let miss = 0;
    for (let i = 0; i < photos.length; i++) {
      pg.textContent = `사진 모으는 중… ${i + 1}/${photos.length}`;
      const { data, error } = await sb.storage.from(BUCKET).download(photos[i].path);
      if (error || !data) { miss++; continue; }
      zip.file('photos/' + photoKey(photos[i]) + '.jpg', data);
    }
    pg.textContent = '파일 만드는 중…';
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(`한입기록장_백업_${stamp()}.zip`, blob);
    pg.textContent = miss ? `사진 ${miss}장은 불러오지 못해 빠졌어요.` : '백업 파일을 만들었어요.';
  } catch (e) { err.textContent = '백업 파일을 만들지 못했어요. ' + (e.message || ''); }
  if (E) E.busy = false;
}
async function importZip(file) {
  if (E.busy) return; const err = $('#e-err'), pg = $('#ex-prog'); err.textContent = '';
  if (!window.JSZip) { err.textContent = '백업 도구를 불러오지 못했어요.'; return; }
  E.busy = true;
  try {
    const zip = await JSZip.loadAsync(file);
    const jf = zip.file('data.json'); if (!jf) throw new Error('data.json이 없는 파일이에요. 한입 기록장 백업 ZIP을 골라 주세요.');
    const data = JSON.parse(await jf.async('string'));
    const listMap = {};
    for (const l of data.lists || []) {
      const ex = S.lists.find(x => x.name === l.name);
      if (ex) { listMap[l.id] = ex.id; continue; }
      const { data: nl, error } = await sb.from('lists').insert({ name: l.name }).select().single(); if (error) throw error; listMap[l.id] = nl.id;
    }
    const restMap = {}; const rs = data.restaurants || [];
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i]; pg.textContent = `식당 옮기는 중… ${i + 1}/${rs.length}`;
      const ex = [...S.rest.values()].find(x => x.name.trim().toLowerCase() === (r.name || '').trim().toLowerCase() && (x.address || '').trim() === (r.address || '').trim());
      if (ex) { restMap[r.id] = ex.id; continue; }
      const needGeo = r.lat == null && (r.address || r.name);
      const nr = await insertRestaurant({ name: r.name || '이름 없음', address: r.address || '', lat: r.lat ?? null, lng: r.lng ?? null, lists: (r.lists || []).map(x => listMap[x]).filter(Boolean) });
      restMap[r.id] = nr.id;
      if (needGeo) await sleep(1100); // 지도 검색 서비스 배려
    }
    const ds = data.dishes || []; let photoMiss = 0;
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i]; pg.textContent = `메뉴 옮기는 중… ${i + 1}/${ds.length}`;
      const rid = restMap[d.restId]; if (!rid) continue;
      const photos = [];
      for (const key of d.photos || []) {
        const zf = zip.file('photos/' + key + '.jpg') || zip.file(new RegExp('^photos/' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.'))[0];
        if (!zf) { photoMiss++; continue; }
        const blob = new Blob([await zf.async('arraybuffer')], { type: 'image/jpeg' });
        photos.push(await uploadPhoto(blob));
      }
      const r = Math.max(1, Math.min(10, Math.round(Number(d.rating) || 1)));
      const { error } = await sb.from('dishes').insert({ restaurant_id: rid, name: d.name || '이름 없음', rating: r, tags: d.tags || [], photos, date: d.date || null, price: d.price || '', note: d.note || '', created_at: d.createdAt ? new Date(d.createdAt).toISOString() : undefined });
      if (error) { await removePhotos(photos.map(p => p.path)); throw error; }
    }
    await reload();
    pg.textContent = `불러오기 끝: 식당 ${rs.length}곳, 메뉴 ${ds.length}개${photoMiss ? `, 찾지 못한 사진 ${photoMiss}장` : ''}.`;
  } catch (e) { err.textContent = '불러오지 못했어요. ' + (e.message || ''); await reload().catch(() => {}); }
  if (E) E.busy = false;
}

/* ---------- events ---------- */
const H = {
  scale: a => { S.scale = a.dataset.v; try { localStorage.setItem('hanip-scale', S.scale); } catch (e) {} render(); if (E && E.kind === 'settings') openSettings(); },
  tab: a => { S.tab = a.dataset.v; S.sort = 'score'; render(); },
  tag: a => { S.tag = a.dataset.v || null; render(); },
  score: a => { const v = +a.dataset.v; S.scores.has(v) ? S.scores.delete(v) : S.scores.add(v); render(); },
  scoreclear: () => { S.scores.clear(); render(); },
  guide: () => { $('#guide')._draft = null; openGuide(false); },
  guideclose: () => { const el = $('#guide'); if (el._edit) { el._draft = null; openGuide(false); } else { el.hidden = true; el.innerHTML = ''; } },
  guideedit: () => openGuide(true),
  guidesave: () => saveGuide(),
  guidereset: () => { $('#guide')._draft = JSON.parse(JSON.stringify(DEFAULT_GUIDE)); openGuide(true); },
  sort: a => { S.sort = a.dataset.v; render(); },
  list: a => { S.list = a.dataset.v || null; render(); },
  add: a => openDish({ restId: a.dataset.r || null }),
  dish: a => openDish({ dishId: a.dataset.id }),
  viewdish: a => openDishView(a.dataset.id),
  closedview: () => closeDishView(),
  rest: a => { if (S.map) S.map.closePopup(); if (!a.dataset.id) return; closeDishView(); openDetail(a.dataset.id); },
  closedetail: () => { S.detail = null; $('#detail').hidden = true; },
  editrest: a => openRest(a.dataset.id),
  pickrest: a => openRest(a.dataset.id, true),
  pickmap: () => openPickMap(),
  newrest: () => openRest(null),
  lists: () => openLists(),
  settings: () => openSettings(),
  togglelist: async a => {
    const r = S.rest.get(a.dataset.id); if (!r) return; const v = a.dataset.v, l = r.lists || [];
    const { error } = await sb.from('restaurants').update({ lists: l.includes(v) ? l.filter(x => x !== v) : [...l, v] }).eq('id', r.id);
    if (error) toast(errMsg(error)); else await reload();
  },
  photo: a => { const u = S.urls.get(a.dataset.p); if (!u) return; $('#lbimg').src = u.url; $('#lb').hidden = false; },
  lbclose: () => { $('#lb').hidden = true; $('#lbimg').src = ''; },
  cancel: () => closeSheet(),
  rate: a => { E.rating = +a.dataset.v; renderRate(); },
  addtag: a => addTag(a.dataset.v),
  rmtag: a => { E.tags = E.tags.filter(t => t !== a.dataset.v); renderTags(); },
  rmphoto: a => { E.photos = E.photos.filter(p => p.path !== a.dataset.p); E.removed.push(a.dataset.p); renderPhotos(); },
  rmnew: a => { const n = E.newFiles.splice(+a.dataset.v, 1)[0]; if (n) URL.revokeObjectURL(n.url); renderPhotos(); },
  pplocal: a => E && E.ppPick && E.ppPick({ local: a.dataset.id }),
  ppremote: a => E && E.ppPick && E.ppPick(E.ppResults[+a.dataset.v]),
  ppmanual: () => { if (E.kind === 'dish') { E.manual = true; E.newRest = { name: ($('#pp-q') || {}).value || '' }; renderPick(); } else { $('#pp-sug').hidden = true; $('#r-name').focus(); } },
  changerest: () => { E.restId = null; E.newRest = null; E.manual = false; renderPick(); },
  savedish: () => saveDish(),
  deldish: () => delDish(),
  rlist: a => { const v = a.dataset.v; E.lists = E.lists.includes(v) ? E.lists.filter(x => x !== v) : [...E.lists, v]; renderRestLists(); },
  saverest: () => saveRest(),
  delrest: () => delRest(),
  addlist: () => addList(),
  dellist: a => { const id = a.dataset.v; if (E.arm !== id) { E.arm = id; renderListRows(); return; } delList(id); },
  excsv: () => exportCsv(),
  exzip: () => exportZip(),
  logout: async () => { await sb.auth.signOut(); location.reload(); },
};
document.addEventListener('click', ev => {
  const a = ev.target.closest('[data-a]'); if (!a) return;
  const f = H[a.dataset.a]; if (!f) return;
  if (a.tagName !== 'A' && a.tagName !== 'LABEL') ev.preventDefault();
  f(a, ev);
}, true); // capture: Leaflet popups stop bubbling
$('#q').addEventListener('input', ev => { S.q = ev.target.value; render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.user && !E) reload().catch(() => {}); });

/* ---------- boot ---------- */
async function showApp() {
  $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false; $('#fab').hidden = false;
  $('#list').innerHTML = '<div class="empty">기록을 불러오는 중…</div>';
  sb.auth.getUser().then(({ data }) => { if (data && data.user) { S.user = data.user; S.guide = (data.user.user_metadata || {}).score_guide || null; render(); } }).catch(() => {});
  try { await reload(); } catch (e) { $('#list').innerHTML = `<div class="empty"><h2>기록을 불러오지 못했어요</h2>${esc(errMsg(e))}<br><span class="help">안내서의 Supabase 설정(SQL 실행)을 마쳤는지 확인해 주세요.</span></div>`; }
}
function showLogin() { $('#boot').hidden = true; $('#app').hidden = true; $('#fab').hidden = true; $('#login').hidden = false; }
(async () => {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    $('#boot').innerHTML = '<div class="empty" style="margin-top:15vh"><h2>설정이 필요해요</h2>config.js 파일에 Supabase 주소와 키를 넣어 주세요.<br>설치 안내서 3단계를 보세요.</div>'; return;
  }
  if (!window.supabase) { $('#boot').innerHTML = '<div class="empty" style="margin-top:15vh"><h2>불러오지 못했어요</h2>인터넷 연결을 확인하고 새로고침해 주세요.</div>'; return; }
  // 주소 뒤에 /rest/v1 같은 경로가 붙어 있어도 프로젝트 주소만 남긴다
  const m = String(CFG.SUPABASE_URL).trim().match(/https?:\/\/[^/\s]+/);
  const baseUrl = m ? m[0] : String(CFG.SUPABASE_URL).trim();
  sb = window.supabase.createClient(baseUrl, String(CFG.SUPABASE_ANON_KEY).trim(), { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await sb.auth.getSession();
  if (data.session) { S.user = data.session.user; S.guide = (S.user.user_metadata || {}).score_guide || null; showApp(); } else showLogin();
  sb.auth.onAuthStateChange((ev, session) => { if (ev === 'SIGNED_OUT') { S.user = null; showLogin(); } else if (session) S.user = session.user; });
})();
$('#loginform').addEventListener('submit', async ev => {
  ev.preventDefault(); const btn = $('#lg-btn'), er = $('#lg-err'); er.textContent = ''; btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email: $('#lg-email').value.trim(), password: $('#lg-pw').value });
  btn.disabled = false;
  if (error) { er.textContent = /Invalid login/i.test(error.message) ? '이메일이나 비밀번호가 맞지 않아요.' : errMsg(error); return; }
  S.user = data.user; S.guide = (S.user.user_metadata || {}).score_guide || null; showApp();
});
