#!/usr/bin/env node
// 產生 GitHub Pages 靜態版：複製 public/ 前端檔到 docs/ 並注入 localStorage 資料層
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, 'public');
const out = path.join(__dirname, 'docs');
fs.mkdirSync(out, { recursive: true });

for (const f of ['style.css', 'app.js']) {
  fs.copyFileSync(path.join(pub, f), path.join(out, f));
}

let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const appTag = '<script src="app.js';
if (!html.includes(appTag)) throw new Error('public/index.html 找不到 app.js script 標籤');
html = html.replace(appTag, `<script src="local-store.js?v=1"></script>\n  ${appTag}`);
fs.writeFileSync(path.join(out, 'index.html'), html);

fs.writeFileSync(path.join(out, 'CNAME'), 'bill.fearnot.tw\n');
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log('docs/ 已更新（index.html、style.css、app.js、CNAME）');
