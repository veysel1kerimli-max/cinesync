// Tek dosyalık sürüm üretir: dist/cinesync.html (CSS + JS satır içi).
// Kullanım: npm run build   (esbuild gerekir: npm install)
import { build } from 'esbuild';
import fs from 'node:fs';

const out = await build({ entryPoints: ['js/app.js'], bundle: true, format: 'iife', minify: true, write: false, target: ['es2020'], legalComments: 'inline' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('css/app.css', 'utf8');
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace('<link rel="stylesheet" href="css/app.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script type="module" src="js/app.js"></script>', () => `<script>window.__CINESYNC_SINGLE__ = true;</script>\n  <script>\n${js}\n</script>`);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/cinesync.html', html);
console.log('dist/cinesync.html', (html.length / 1024).toFixed(1) + ' KB');
