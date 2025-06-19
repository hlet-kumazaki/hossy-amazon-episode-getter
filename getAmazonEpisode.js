const fs = require('fs');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise(resolve => setTimeout(resolve, 8000));

  const html = await page.content();
  const found = html.includes('music-episode-row-item');

  console.log('music-episode-row-item 存在:', found ? '✅ あり' : '❌ なし');

  // HTMLをファイルに保存
  fs.writeFileSync('page_dump.html', html);
  console.log('✅ 全HTMLを page_dump.html に保存しました');

  await browser.close();
})();