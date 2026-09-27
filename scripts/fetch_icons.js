/**
 * fetch_icons.js
 * ブルアカ攻略Wikiの「キャラクター一覧」ページ等から生徒アイコン情報を自動取得し、
 * data/student_icons.json に保存するスクリプト。
 * 外部npmパッケージ不要（Node.js標準モジュールのみで動作）
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://bluearchive.wikiru.jp/?%E3%82%AD%E3%83%A3%E3%83%A9%E3%82%AF%E3%82%BF%E3%83%BC%E4%B8%80%E8%A6%A7';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'student_icons.json');

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
      }
    }, (res) => {
      // リダイレクト対応
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = 'https://bluearchive.wikiru.jp' + redirectUrl;
        }
        return resolve(fetchHTML(redirectUrl));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch: HTTP Status ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    }).on('error', reject);
  });
}

function parseIcons(html) {
  const iconMap = {};
  
  // テーブル行 <tr>...</tr> を抽出
  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trMatches) {
    // 生徒一覧表は ★1, ★2, ★3 のいずれかが含まれる行
    if (!tr.includes('★1') && !tr.includes('★2') && !tr.includes('★3')) {
      continue;
    }

    // 画像タグ <img ...>
    const dataSrcMatch = tr.match(/data-src=["']([^"']+)["']/i);
    const regularSrcMatch = tr.match(/src=["']([^"']+)["']/i);
    
    let src = '';
    if (dataSrcMatch && !dataSrcMatch[1].startsWith('data:') && dataSrcMatch[1].includes('attach2')) {
      src = dataSrcMatch[1];
    } else if (regularSrcMatch && !regularSrcMatch[1].startsWith('data:') && regularSrcMatch[1].includes('attach2')) {
      src = regularSrcMatch[1];
    }

    if (!src) continue;

    // 完全なURLに整形
    if (!src.startsWith('http') && !src.startsWith('data:')) {
      if (src.startsWith('/')) {
        src = 'https://bluearchive.wikiru.jp' + src;
      } else {
        src = 'https://bluearchive.wikiru.jp/' + src;
      }
    }

    // キャラクター名の抽出
    let name = '';

    // パターン1: 3列目セルなどにあるキャラ名リンク <a href="./?%E3%82%...">(キャラ名)</a>
    const linkMatches = [...tr.matchAll(/<a[^>]+>([^<]+)<\/a>/gi)];
    for (const lm of linkMatches) {
      const text = lm[1].trim();
      // 余分なリンク（編集、学校名、装甲タイプなど）を除外
      if (text && !/^(編集|TOP|Top|★\d|STRIKER|SPECIAL|FRONT|MIDDLE|BACK|軽装備|重装甲|特殊装甲|弾力装甲|爆発|貫通|神秘|振動|帽子|ヘアピン|バッジ|腕時計|お守り|ネックレス)$/.test(text)) {
        name = text;
        break;
      }
    }

    // パターン2: title または alt
    if (!name) {
      const titleMatch = tr.match(/title=["']([^"']+)["']/i);
      const altMatch = tr.match(/alt=["']([^"']+)["']/i);
      let raw = (titleMatch ? titleMatch[1] : '') || (altMatch ? altMatch[1] : '');
      raw = raw.replace(/(_icon\.png|\.png|\.jpg|\.webp)/gi, '').trim();
      if (raw && !/^(★\d|STRIKER|SPECIAL|D|B|A|S|SS)$/.test(raw)) {
        name = raw;
      }
    }

    if (name && src) {
      name = name.replace(/\[編集\]/g, '').trim();
      // 余計なシステム文字列を除外
      if (name && name.length >= 2 && !/^(スマホ|Area|編集|テーブル)/.test(name)) {
        iconMap[name] = src;
      }
    }
  }

  return iconMap;
}

async function main() {
  console.log(`[Icon Fetcher] Fetching wiki page: ${TARGET_URL}`);
  try {
    const html = await fetchHTML(TARGET_URL);
    console.log(`[Icon Fetcher] HTML fetched (${html.length} bytes). Parsing icons...`);
    const icons = parseIcons(html);
    const count = Object.keys(icons).length;

    console.log(`[Icon Fetcher] Successfully extracted ${count} student icons.`);

    if (count === 0) {
      console.warn('[Icon Fetcher] Warning: No icons extracted. Aborting file write.');
      process.exit(1);
    }

    // 既存データがある場合はマージ
    let existing = {};
    if (fs.existsSync(OUTPUT_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      } catch (e) {
        console.warn('[Icon Fetcher] Failed to read existing JSON, will overwrite.');
      }
    }

    const merged = { ...existing, ...icons };
    // 不要なキーをクリーンアップ
    delete merged["スマホ版表示に切り替える"];
    delete merged["Area1-Area10"];
    delete merged["Area11-Area20"];
    delete merged["Area21-Area30"];

    const mergedCount = Object.keys(merged).length;

    const dataDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`[Icon Fetcher] Saved ${mergedCount} icons to ${OUTPUT_FILE}`);
  } catch (err) {
    console.error(`[Icon Fetcher] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
