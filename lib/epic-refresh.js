'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 60 * 60 * 1000;
const RATING_MARKER = /Epic Player Ratings\s+Captured from players in the Epic Games ecosystem\.\s+([0-5](?:\.\d{1,2})?)(?![.\d])/i;
const STORE_LINK = /https?:\/\/store\.epicgames\.com\/[^\s<>"')]+/gi;

function parseRating(body) {
  if (typeof body !== 'string' || body.length > 2000000) return null;
  const match = body.replace(/\s+/g, ' ').match(RATING_MARKER);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 1 && value <= 5 ? value : null;
}

function extractStoreLinks(text) {
  const out = new Map();
  for (const match of String(text).matchAll(STORE_LINK)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname !== 'store.epicgames.com') continue;
      const product = url.pathname.match(/\/p\/([a-z0-9][a-z0-9._-]*)(?:\/|$)/i);
      if (product) out.set(product[1].toLowerCase(), url.href);
    } catch {}
  }
  return out;
}

function collectFromPosts(siteDir) {
  const postDir = path.join(siteDir, 'source', '_posts');
  const results = new Map();
  if (!fs.existsSync(postDir)) return results;
  const stack = [postDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        const matches = extractStoreLinks(fs.readFileSync(full, 'utf8'));
        for (const [slug, url] of matches) results.set(slug, url);
      }
    }
  }
  return results;
}

function loadState(filename) {
  try {
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const temp = filename + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, filename);
}

async function readEpicRating(slug, timeout, key) {
  const url = 'https://r.jina.ai/https://store.epicgames.com/p/' + slug + '?lang=en-US';
  const headers = {'X-Respond-With': 'text', Accept: 'text/plain'};
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeout)
  });
  if ([401, 403, 429].includes(res.status)) {
    const error = new Error('external reader returned HTTP ' + res.status);
    error.blocked = true;
    throw error;
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return parseRating(await res.text());
}

function positiveInt(value, defaultValue, maxValue) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, maxValue) : defaultValue;
}

function registerEpicRefresh(hexo, snapshot) {
  const statePath = path.join(hexo.base_dir, '.cache', 'hexo-game-ratings-epic-attempts.json');
  const ratingsPath = path.join(hexo.base_dir, 'source', '_data', 'epic-ratings.json');
  hexo.extend.filter.register('before_generate', async function() {
    const config = (hexo.config.game_ratings || {}).epic || {};
    if (config.auto_refresh === false) return;
    const budget = positiveInt(config.max_requests_per_build, 3, 20);
    if (!budget) return;
    const ttl = positiveInt(config.refresh_days, 14, 365) * DAY;
    const retry = positiveInt(config.missing_retry_days, 2, 365) * DAY;
    const timeout = positiveInt(config.timeout_ms, 14000, 60000);
    const now = Date.now();
    const attempts = loadState(statePath);
    if (Date.parse(attempts.blockedUntil || '') > now) return;
    if (!snapshot.ratings || typeof snapshot.ratings !== 'object') snapshot.ratings = {};
    const products = collectFromPosts(hexo.base_dir);
    const newGames = [];
    const oldGames = [];
    for (const [slug, url] of products) {
      const existing = snapshot.ratings[slug];
      const previousAttempt = Date.parse((attempts.checked || {})[slug] || '');
      if (existing && Number(existing.value) > 0) {
        const lastSuccess = Date.parse(existing.checkedAt || snapshot.checkedAt || '');
        if (!Number.isFinite(lastSuccess) || now - lastSuccess >= ttl) {
          oldGames.push({slug, url});
        }
      } else if (!Number.isFinite(previousAttempt) || now - previousAttempt >= retry) {
        newGames.push({slug, url});
      }
    }
    const targets = newGames.concat(oldGames).slice(0, budget);
    if (!targets.length) return;
    hexo.log.info('[game-ratings] Checking ' + targets.length + ' Epic product(s)');
    const key = process.env.JINA_API_KEY || '';
    attempts.checked = attempts.checked || {};
    let changed = false;
    for (const {slug, url} of targets) {
      const date = new Date().toISOString();
      attempts.checked[slug] = date;
      try {
        const value = await readEpicRating(slug, Math.max(1000, timeout), key);
        if (value !== null) {
          snapshot.ratings[slug] = {value, sourceUrl:url, checkedAt:date.slice(0, 10)};
          changed = true;
          hexo.log.info('[game-ratings] Epic ' + slug + ': ' + value + '/5');
        } else {
          hexo.log.info('[game-ratings] Epic ' + slug + ': no public rating');
        }
      } catch (error) {
        hexo.log.warn('[game-ratings] Epic ' + slug + ': ' + error.message + '; keeping cache');
        if (error.blocked) {
          attempts.blockedUntil = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
          break;
        }
      }
    }
    try {
      writeJson(statePath, attempts);
      if (changed) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.checkedAt || '')) {
          snapshot.checkedAt = new Date().toISOString().slice(0, 10);
        }
        writeJson(ratingsPath, snapshot);
      }
    } catch (error) {
      hexo.log.warn('[game-ratings] Epic cache save failed: ' + error.message);
    }
  }, 90);
}

module.exports = registerEpicRefresh;
module.exports.parseRating = parseRating;
module.exports.extractStoreLinks = extractStoreLinks;
module.exports.collectFromPosts = collectFromPosts;
