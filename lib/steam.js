'use strict';

module.exports = function registerSteam(hexo) {

// Hexo Butterfly Steam review card (server-rendered during "hexo generate").
// Use in posts: {% steam_review 1086940 %}
const fs = require('node:fs');
const path = require('node:path');

const cacheFile = path.join(hexo.base_dir, '.cache', 'steam-reviews.json');
const cacheLifetimeMs = 12 * 60 * 60 * 1000;
const pending = new Map();
// Limit concurrent Steam requests to avoid rate limits during full-site builds.
let activeRequests = 0;
const requestWaiters = [];
async function limitedRequest(callback) {
  if (activeRequests >= 5) {
    await new Promise(resolve => requestWaiters.push(resolve));
  }
  activeRequests++;
  try {
    return await callback();
  } finally {
    activeRequests--;
    const next = requestWaiters.shift();
    if (next) next();
  }
}
const numberFormat = new Intl.NumberFormat('zh-CN');
const ratings = [
  '暂无评价', '差评如潮', '特别差评', '差评', '多半差评',
  '褒贬不一', '多半好评', '好评', '特别好评', '好评如潮'
];
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
} catch {
  cache = {};
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temp = cacheFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(temp, cacheFile);
  } catch (error) {
    hexo.log.warn('[steam_review] 缓存写入失败：' + error.message);
  }
}

function isValid(entry) {
  return entry &&
    Number.isSafeInteger(entry.positive) &&
    Number.isSafeInteger(entry.negative) &&
    Number.isSafeInteger(entry.total) &&
    entry.total >= 0 &&
    entry.positive >= 0 &&
    entry.negative >= 0 &&
    entry.positive + entry.negative <= entry.total &&
    Number.isInteger(entry.level) &&
    entry.level >= 0 && entry.level <= 9 &&
    Number.isFinite(Date.parse(entry.fetchedAt));
}

async function requestReviews(appid) {
  const url = new URL('https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/');
  url.searchParams.set('input_json', JSON.stringify({
    appid: Number(appid),
    filter: 1,          // Recent
    review_type: 0,     // All reviews, required for totals
    purchase_type: 1,   // All purchase sources
    languages: ['all'],
    display_language: 'schinese',
    num_per_page: 1
  }));
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);

  const json = await response.json();
  // The current service API wraps query_summary in "response".
  const summary = json && json.response && json.response.query_summary;
  if (!summary) throw new Error('Steam API 未返回 query_summary');

  const data = {
    positive: Number(summary.total_positive),
    negative: Number(summary.total_negative),
    total: Number(summary.total_reviews),
    level: Number(summary.review_score),
    fetchedAt: new Date().toISOString()
  };
  if (!isValid(data)) throw new Error('Steam 评价统计无效');
  return data;
}

async function getReviews(appid) {
  const old = isValid(cache[appid]) ? cache[appid] : null;
  if (old && Date.now() - Date.parse(old.fetchedAt) < cacheLifetimeMs) {
    return { ...old, stale: false };
  }
  if (pending.has(appid)) return pending.get(appid);

  const work = (async () => {
    try {
      const data = await limitedRequest(() => requestReviews(appid));
      cache[appid] = data;
      persist();
      return { ...data, stale: false };
    } catch (error) {
      hexo.log.warn('[steam_review] AppID ' + appid + ' 获取失败：' + error.message);
      if (old) return { ...old, stale: true };
      throw error;
    } finally {
      pending.delete(appid);
    }
  })();

  pending.set(appid, work);
  return work;
}

function formatDate(iso) {
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'Asia/Shanghai'
  }).format(new Date(iso));
}

async function renderCard(inputAppId) {
  const appid = String(inputAppId || '').trim();
  if (!/^[1-9]\d{0,9}$/.test(appid) || Number(appid) > 4294967295) {
    return '';
  }

  const steamUrl = 'https://store.steampowered.com/app/' + appid + '/';
  let data;
  try {
    data = await getReviews(appid);
  } catch {
    return '';
  }

  if (data.total === 0) {
    return '';
  }

  const raw = data.positive / data.total * 100;
  // Site-owned Bayesian estimate, NOT Steam's official score.
  const adjusted = (data.positive + 2100) / (data.total + 4200) * 100;
  const score = (adjusted / 10).toFixed(1);
  const adjustedText = adjusted.toFixed(1);
  const level = ratings[data.level] || '玩家评价';
  const sentiment = data.level >= 6 ? 'positive' : data.level <= 4 ? 'negative' : 'mixed';
  const verdict = adjusted >= 80 ? '口碑表现出色，推荐体验' :
    adjusted >= 60 ? '整体评价较好，可以考虑体验' :
    adjusted >= 40 ? '评价存在分歧，建议了解后再决定' : '口碑评价偏低，建议谨慎选择';
  const freshness = data.stale ? '缓存数据（上次成功采集于 ' : '数据采集于 ';
  const updated = freshness + formatDate(data.fetchedAt) + (data.stale ? '）' : '');

  return [
    '<section class="steam-review-card" data-steam-appid="' + appid + '" aria-label="Steam 玩家评价">',
    '  <div class="steam-review-overview">',
    '    <div class="steam-review-heading">',
    '      <i class="steam-review-icon fa-brands fa-steam" aria-hidden="true"></i>',
    '      <span><strong>Steam 玩家评价</strong><small>玩家评价统计</small></span>',
    '    </div>',
    '    <span class="steam-review-level is-' + sentiment + '">' + level + '</span>',
    '  </div>',
    '  <div class="steam-review-detail">',
    '    <div class="steam-review-primary">',
    '      <span class="steam-review-final-score"><strong>' + score + '</strong><span><b>/10</b><small>参考综合评分</small></span></span>',
    '      <p class="steam-review-rate">Steam 好评率 <b>' + raw.toFixed(1) + '%</b><span class="steam-review-separator">·</span><b>' + numberFormat.format(data.total) + '</b> 条评价</p>',
    '      <small class="steam-review-updated">' + updated + '</small>',
    '    </div>',
    '    <div class="steam-review-judgment">',
    '      <p class="steam-review-verdict">' + verdict + '</p>',
    '      <div class="steam-review-meter" role="meter" aria-label="本站修正口碑" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + adjustedText + '"><span style="width:' + adjustedText + '%"></span></div>',
    '      <p class="steam-review-meta"><span>好评 <b class="is-positive">' + numberFormat.format(data.positive) + '</b></span><span>差评 <b class="is-negative">' + numberFormat.format(data.negative) + '</b></span><span>修正口碑 <b>' + adjustedText + '%</b></span></p>',
    '    </div>',
    '  </div>',
    '  <div class="steam-review-footer"><small>综合评分及修正口碑为本站估算，非 Steam 官方评分</small>',
    '    <a href="' + steamUrl + '" target="_blank" rel="noopener noreferrer">查看 Steam 原始评价 ↗</a>',
    '  </div>',
    '</section>'
  ].join('\n');
}

hexo.extend.tag.register('steam_review', async (args) => renderCard(args[0]), { async: true });

// Automatically place the card first in every game article, before the article body.
// Butterfly renders the post's title and metadata outside of post.content.
function isGamePost(post) {
  if (!post || post.layout !== 'post') return false;
  if (post.game_ratings === false) return false;
  if (post.game_ratings === true) return true;
  const config = hexo.config.game_ratings || {};
  const names = Array.isArray(config.categories) ? config.categories : ['游戏', 'Games'];
  const categories = post.categories;
  const items = Array.isArray(categories)
    ? categories
    : categories && Array.isArray(categories.data) ? categories.data : [];
  return items.some(item => names.includes(typeof item === 'string' ? item : item && item.name));
}

function findSteamAppId(post) {
  // Optional front-matter override: steam_appid: 123456
  const override = post.steam_appid || post.steamAppId;
  if (override && /^[1-9]\d{0,9}$/.test(String(override))) {
    return String(override);
  }
  // Only use explicit Steam application links, never guess IDs by similar names.
  const input = String(post.raw || '') + '\n' + String(post.content || '');
  const result = input.match(/(?:store\.steampowered\.com|steamcommunity\.com)\/app\/([1-9]\d{0,9})(?:\b|\/)/i);
  return result ? result[1] : null;
}

hexo.extend.filter.register('after_post_render', async function (post) {
  if (!isGamePost(post)) return post;
  // Respect an explicitly placed steam_review tag, if the author uses one.
  if (String(post.content || '').includes('class="steam-review-card"')) return post;
  const appid = findSteamAppId(post);
  // An unsupported or unlinked platform should not generate a rating card.
  if (!appid) return post;
  const card = await renderCard(appid);
  if (!card) return post;
  // Game/version title is the first Markdown ## heading, rendered as an <h2>.
  // Keep that heading first, then show the Steam card before the description.
  const content = String(post.content || '');
  const firstH2 = /<h2\b[^>]*>[\s\S]*?<\/h2>/i;
  post.content = firstH2.test(content)
    ? content.replace(firstH2, heading => heading + '\n' + card)
    : card + '\n' + content;

  return post;
}, 90);

};
