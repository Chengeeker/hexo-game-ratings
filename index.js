'use strict';

const fs = require('node:fs');
const path = require('node:path');

if (typeof hexo === 'undefined' || !hexo.extend) {
  throw new Error('hexo-game-ratings must be loaded by Hexo');
}

require('./lib/steam')(hexo);
require('./lib/store')(hexo);

const styles = fs.readFileSync(path.join(__dirname, 'assets', 'game-ratings.css'), 'utf8');

// Deliver CSS as a generated route, rather than requiring theme-specific edits.
hexo.extend.generator.register('hexo-game-ratings-css', () => ({
  path: 'css/hexo-game-ratings.css',
  data: styles
}));

hexo.extend.injector.register('head_end', () => {
  const configuredRoot = String(hexo.config.root || '/');
  const root = '/' + configuredRoot.replace(/^\/+|\/+$/g, '');
  const href = (root === '/' ? '/' : root + '/') + 'css/hexo-game-ratings.css';
  return '<link rel="stylesheet" href="' + href + '">';
}, 'post');
