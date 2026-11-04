'use strict';
// после «npx cap add android»: свой код Android, разрешения, «Поделиться», номер версии
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), app = path.join(root, 'android', 'app');
const src = path.join(__dirname, 'android'), java = path.join(app, 'src', 'main', 'java', 'com', 'vegasdev', 'linea');
for (const f of ['MainActivity.java', 'LineaPlugin.java', 'PlayService.java']) fs.copyFileSync(path.join(src, f), path.join(java, f));
const draw = path.join(app, 'src', 'main', 'res', 'drawable');
fs.mkdirSync(draw, { recursive: true });
fs.copyFileSync(path.join(src, 'ic_stat_linea.xml'), path.join(draw, 'ic_stat_linea.xml'));

const must = (s, what) => { if (!s) throw new Error('не нашлось: ' + what); return s; };
const mf = path.join(app, 'src', 'main', 'AndroidManifest.xml');
let m = fs.readFileSync(mf, 'utf8');
const perms = ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'POST_NOTIFICATIONS', 'WAKE_LOCK']
  .map((p) => `    <uses-permission android:name="android.permission.${p}" />`).join('\n');
m = must(m.includes('</manifest>') && m.replace('</manifest>', perms + '\n</manifest>'), 'manifest');
// «Поделиться → Linea» из SoundCloud, YouTube и браузера
const share = `            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
        </activity>
        <service android:name=".PlayService" android:exported="false" android:foregroundServiceType="mediaPlayback" />`;
must(m.includes('</activity>'), 'activity');
m = m.replace('</activity>', share);
fs.writeFileSync(mf, m);

const gf = path.join(app, 'build.gradle');
let g = fs.readFileSync(gf, 'utf8');
const code = Number(process.env.LN_BUILD) || 1, name = process.env.LN_VERSION || '0.0.1';
must(/versionCode \d+/.test(g) && /versionName "[^"]*"/.test(g), 'version');
g = g.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${name}"`);
fs.writeFileSync(gf, g);
console.log('android пропатчен', code, name);
