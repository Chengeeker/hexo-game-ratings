'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { parseRating, extractStoreLinks } = require('../lib/epic-refresh');

test('Epic player rating parser only accepts the official section', () => {
  assert.equal(parseRating(
    'Flirty Landlord 4.6 Overview Epic Player Ratings\nCaptured from players in the Epic Games ecosystem.\n4.6\nSystem Requirements'
  ), 4.6);
  assert.equal(parseRating('Age rating 18+ and review score 4.9'), null);
  assert.equal(parseRating('Epic Player Ratings Captured from players in the Epic Games ecosystem. 9.3'), null);
  assert.equal(parseRating('Just a moment...'), null);
});

test('only explicit Epic product links are recognized', () => {
  const urls = extractStoreLinks(
    'https://store.epicgames.com/zh-CN/p/flirty-landlord-gorgeous-tenants-9cbdd9 ' +
    'https://store.epicgames.com/zh-CN/browse?q=hello ' +
    'https://evil.com/p/not-an-epic-game'
  );
  assert.equal(urls.size, 1);
  assert.ok(urls.has('flirty-landlord-gorgeous-tenants-9cbdd9'));
});

test('Hexo plugin renders one Epic card after H2 and injects bundled CSS', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-game-ratings-'));
  const filters = {};
  const generators = {};
  const injections = {};
  const tags = {};
  global.hexo = {
    base_dir: tmp,
    config: {root: '/', game_ratings:{categories:['游戏'],show_unlinked:false,epic:{auto_refresh:false}}},
    log: {warn(){}, info(){}},
    extend:{
      filter:{register(name,fn,priority){(filters[name] ||= []).push({fn,priority});}},
      generator:{register(name,fn){generators[name]=fn;}},
      injector:{register(where,fn,to){injections[where]={fn,to};}},
      tag:{register(name,fn){tags[name]=fn;}}
    }
  };
  try {
    require('../index');
    assert.equal(filters.after_post_render.length, 2);
    assert.equal(filters.before_generate.length, 1);
    assert.equal(typeof tags.steam_review, 'function');
    await filters.before_generate[0].fn();
    const css = generators['hexo-game-ratings-css']();
    assert.equal(css.path,'css/hexo-game-ratings.css');
    assert.match(css.data,/\.steam-review-card/);
    assert.match(injections.head_end.fn(),/href="\/css\/hexo-game-ratings\.css"/);

    const post = {
      layout:'post',
      categories:{data:[{name:'游戏'}]},
      raw:'[Epic](https://store.epicgames.com/p/stocking-angel-32af97)',
      content:'<h2 id="game">Game title</h2>\n<p>Introduction</p>'
    };
    for (const {fn} of filters.after_post_render.sort((a,b)=>a.priority-b.priority)) {
      await fn(post);
    }
    assert.match(post.content, /<\/h2>\s*<section class="steam-review-card store-review-card store-review-epic"/);
    assert.equal((post.content.match(/class="steam-review-card/g)||[]).length,1);
    assert.ok(post.content.indexOf('store-review-epic') < post.content.indexOf('Introduction'));

    const other = {
      layout:'post', categories:{data:[{name:'游戏'}]},
      raw:'[B站](https://www.bilibili.com/video/BV1234)',
      content:'<h2>Other game</h2>\n<p>Intro</p>'
    };
    for (const {fn} of filters.after_post_render) await fn(other);
    assert.doesNotMatch(other.content,/steam-review-card/);
  } finally {
    delete global.hexo;
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
