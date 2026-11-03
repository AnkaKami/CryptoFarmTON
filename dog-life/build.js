// Wraps game.html (page body) into a standalone index.html for any static host
// (GitHub Pages, Netlify, Vercel) and for a Capacitor/WebView wrapper later.
// Usage: node dog-life/build.js
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const body = fs.readFileSync(path.join(dir, 'game.html'), 'utf8');

const head = [
  '<!doctype html>',
  '<html lang="ru">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="theme-color" content="#E8ECE6" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#121614" media="(prefers-color-scheme: dark)">',
  '<meta property="og:title" content="Собачья жизнь">',
  '<meta property="og:description" content="В мире около 900 миллионов собак. Кем родишься ты?">',
  '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>',
  '</head>',
  '<body>'
].join('\n');

fs.writeFileSync(path.join(dir, 'index.html'), `${head}\n${body}\n</body>\n</html>\n`);
console.log('dog-life/index.html written');
