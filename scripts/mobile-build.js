'use strict';
// сборка для Android: копия src/ в www/ с номером сборки; Capacitor вставляет свой мост в страницу
// отдельным скриптом прямо в HTML, поэтому в www разрешаем встроенные скрипты (на ПК — нет)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), www = path.join(root, 'www');
fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(root, 'src'), www, { recursive: true });
const html = path.join(www, 'index.html');
const page = fs.readFileSync(html, 'utf8').replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
if (!page.includes("'unsafe-inline';")) throw new Error('CSP не нашлась');
fs.writeFileSync(html, page);
const build = Number(process.env.LN_BUILD) || 0, version = process.env.LN_VERSION || 'dev';
fs.writeFileSync(path.join(www, 'build.js'), `window.LN_BUILD = ${build};\nwindow.LN_VERSION = ${JSON.stringify(version)};\n`);
console.log('www готов, сборка', build, version);
