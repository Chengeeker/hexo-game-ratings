'use strict';

module.exports = function registerStores(hexo) {

// Epic/Xbox review cards: generated at build time, no client-side requests.
// Steam cards remain handled by scripts/steam-review.js.
const fs = require('node:fs');
const path = require('node:path');
const cachePath = path.join(hexo.base_dir, '.cache', 'xbox-reviews.json');
const ttl = 24 * 60 * 60 * 1000;
const num = new Intl.NumberFormat('zh-CN');
const pending = new Map();
let cache = {};
let epicSnapshot = {checkedAt: null, ratings: {}};
try {
  const file = path.join(hexo.base_dir, 'source', '_data', 'epic-ratings.json');
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (source && /^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt) &&
      source.ratings && typeof source.ratings === 'object') {
    epicSnapshot = source;
  }
} catch (error) {
  hexo.log.warn('[store_review] Epic 评分快照读取失败：' + error.message);
}

try {
  const existing = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) cache = existing;
} catch {}

// Discover Epic product links and update ratings before every build.
// Network failures preserve saved ratings and do not fail Hexo generation.
require('./epic-refresh')(hexo, epicSnapshot);

function save() {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath + '.tmp', JSON.stringify(cache, null, 2));
    fs.renameSync(cachePath + '.tmp', cachePath);
  } catch (error) {
    hexo.log.warn('[store_review] Xbox 缓存保存失败：' + error.message);
  }
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isGame(post) {
  if (!post || post.layout !== 'post') return false;
  if (post.game_ratings === false) return false;
  if (post.game_ratings === true) return true;
  const config = hexo.config.game_ratings || {};
  const names = Array.isArray(config.categories) ? config.categories : ['游戏', 'Games'];
  const c = post.categories;
  const entries = Array.isArray(c) ? c : c && Array.isArray(c.data) ? c.data : [];
  return entries.some(x => names.includes(typeof x === 'string' ? x : x && x.name));
}

function getStores(post) {
  const text = String(post.raw || '') + '\n' + String(post.content || '');
  const matches = text.match(/https?:\/\/(?:store\.epicgames\.com|(?:www\.)?xbox\.com)\/[^\s<>"'),]+/gi) || [];
  const found = {};
  for (const input of matches) {
    try {
      const u = new URL(input);
      const host = u.hostname.toLowerCase();
      if (host === 'store.epicgames.com' && !found.epic) {
        // Never treat a browse/search page as a particular product rating.
        const match = u.pathname.match(/\/p\/([a-z0-9][a-z0-9._-]*)(?:\/|$)/i);
        const product = Boolean(match);
        if (product || /\/browse\/?$/i.test(u.pathname)) {
          found.epic = {url:u.href, product, slug:match ? match[1].toLowerCase() : null};
        }
      }
      if ((host === 'xbox.com' || host === 'www.xbox.com') && !found.xbox) {
        const id = u.pathname.match(/\/games\/store\/[^/]+\/([a-z0-9]{12})(?:\/|$)/i);
        if (id) found.xbox = {url:u.href, id:id[1].toUpperCase()};
      }
    } catch {}
  }
  return found;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone:'Asia/Shanghai'
  }).format(new Date(value));
}

function validXbox(entry) {
  return entry && Number.isFinite(entry.value) &&
    entry.value > 0 && entry.value <= 5 &&
    Number.isSafeInteger(entry.count) && entry.count > 0 &&
    Number.isFinite(Date.parse(entry.fetchedAt));
}

async function fetchXboxRating(url, productId) {
  const response = await fetch(url, {
    headers: { Accept:'text/html', 'User-Agent':'Mozilla/5.0 (compatible; HexoBlog/1.0)' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const html = await response.text();
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    let document;
    try { document = JSON.parse(script[1]); } catch { continue; }
    const nodes = Array.isArray(document['@graph']) ? document['@graph'] : [document];
    for (const item of nodes) {
      const type = item && item['@type'];
      const isProduct = type === 'VideoGame' || type === 'Product' ||
        (Array.isArray(type) && (type.includes('VideoGame') || type.includes('Product')));
      const sourceUrl = String(item && item.url || '').toUpperCase();
      if (!isProduct || !sourceUrl.includes(productId)) continue;
      const rating = item.aggregateRating;
      const result = {
        value: Number(rating && rating.ratingValue),
        count: Number(rating && rating.ratingCount),
        fetchedAt: new Date().toISOString()
      };
      if (validXbox(result)) return result;
    }
  }
  throw new Error('Xbox 页面暂无可用的评分统计');
}

async function getXbox(url, id) {
  const old = validXbox(cache[id]) ? cache[id] : null;
  if (old && Date.now() - Date.parse(old.fetchedAt) < ttl) return {...old, stale:false};
  if (pending.has(id)) return pending.get(id);
  const job = (async () => {
    try {
      let result;
      try {
        result = await fetchXboxRating(url, id);
      } catch {
        // The Xbox page sometimes interrupts long HTML transfers over HTTP/2.
        result = await fetchXboxRating(url, id);
      }
      cache[id] = result;
      save();
      return {...result, stale:false};
    } catch (error) {
      hexo.log.warn('[store_review] Xbox ' + id + ': ' + error.message);
      if (old) return {...old, stale:true};
      return null;
    } finally {
      pending.delete(id);
    }
  })();
  pending.set(id, job);
  return job;
}

function topCardMarkup(source, title, icon, content, footer, url) {
  return [
    '<section class="steam-review-card store-review-card store-review-' + source + '" aria-label="' + title + '">',
    '  <div class="steam-review-overview">',
    '    <div class="steam-review-heading"><i class="steam-review-icon fa-brands ' + icon + '" aria-hidden="true"></i>',
    '      <span><strong>' + title + '</strong><small>玩家评价与商店信息</small></span></div>',
    '    <span class="steam-review-level store-review-source">' + (source === 'xbox' ? 'Xbox' : 'Epic Games') + '</span>',
    '  </div>',
    '  <div class="steam-review-detail">' + content + '</div>',
    '  <div class="steam-review-footer"><small>' + footer + '</small>',
    '    <a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">前往官方商店查看 ↗</a></div>',
    '</section>'
  ].join('\n');
}

function epicCard(epic) {
  // A manually verified snapshot of official Epic product-page ratings.
  // No network request is made from the visitor's device or the Hexo build.
  const entry = epic.slug && epicSnapshot.ratings[epic.slug];
  const value = entry && Number(entry.value);
  if (epic.product && Number.isFinite(value) && value > 0 && value <= 5 &&
      entry.sourceUrl && /^https:\/\/store\.epicgames\.com\//i.test(entry.sourceUrl)) {
    const rating = value.toFixed(1);
    const percent = (value / 5 * 100).toFixed(1);
    const content = [
      '<div class="steam-review-primary">',
      '  <span class="steam-review-final-score"><strong>' + rating + '</strong><span><b>/5</b><small>Epic 玩家星级</small></span></span>',
      '  <p class="steam-review-rate">Epic Games Store <b>五星制玩家评分</b></p>',
      '  <small class="steam-review-updated">外部检索记录：' + (entry.checkedAt || epicSnapshot.checkedAt) + '（非实时）</small>',
      '</div>',
      '<div class="steam-review-judgment">',
      '  <p class="steam-review-verdict">Epic 官方玩家评分</p>',
      '  <div class="steam-review-meter" role="meter" aria-label="Epic 玩家五星评分" aria-valuemin="0" aria-valuemax="5" aria-valuenow="' + rating + '"><span style="width:' + percent + '%"></span></div>',
      '  <p class="steam-review-meta"><span>平均星级 <b>' + rating + ' / 5</b></span><span>官方评分快照</span></p>',
      '</div>'
    ].join('\n');
    return topCardMarkup('epic', 'Epic Games 玩家评价', 'fa-epic-games',
      content, '来自 Epic Games 官方商品页的星级快照；暂不展示未核实的评价人数', epic.url);
  }

  return '';
}

async function xboxCard(xbox) {
  const data = await getXbox(xbox.url, xbox.id);
  if (!data) return '';
  const rate = data.value.toFixed(1);
  const bar = (data.value / 5 * 100).toFixed(1);
  const date = formatDate(data.fetchedAt);
  const content = [
    '<div class="steam-review-primary">',
    '  <span class="steam-review-final-score"><strong>' + rate + '</strong><span><b>/5</b><small>Xbox 平均星级</small></span></span>',
    '  <p class="steam-review-rate">Xbox 商店 <b>' + num.format(data.count) + '</b> 条星级评价</p>',
    '  <small class="steam-review-updated">' + (data.stale ? '使用最近成功采集的缓存：' : '数据采集于 ') + date + '</small>',
    '</div>',
    '<div class="steam-review-judgment">',
    '  <p class="steam-review-verdict">Xbox 官方玩家评分</p>',
    '  <div class="steam-review-meter" role="meter" aria-label="Xbox 玩家五星评分" aria-valuemin="0" aria-valuemax="5" aria-valuenow="' + rate + '"><span style="width:' + bar + '%"></span></div>',
    '  <p class="steam-review-meta"><span>平均星级 <b>' + rate + ' / 5</b></span><span>星级评价 <b>' + num.format(data.count) + '</b></span></p>',
    '</div>'
  ].join('\n');
  return topCardMarkup('xbox', 'Xbox 玩家评价', 'fa-xbox', content,
    'Xbox 官方五星制评分，不等同于 Steam 好评率', xbox.url);
}

hexo.extend.filter.register('after_post_render', async function (post) {
  if (!isGame(post) || String(post.content || '').includes('class="steam-review-card')) return post;
  const stores = getStores(post);
  if (!stores.epic && !stores.xbox) return post;
  // Prefer available verified data; do not insert empty cards.
  const card = (stores.xbox ? await xboxCard(stores.xbox) : '') ||
    (stores.epic ? epicCard(stores.epic) : '');
  if (!card) return post;
  const html = String(post.content || '');
  const h2 = /<h2\b[^>]*>[\s\S]*?<\/h2>/i;
  post.content = h2.test(html) ? html.replace(h2, text => text + '\n' + card) : card + '\n' + html;
  return post;
}, 95);

};
