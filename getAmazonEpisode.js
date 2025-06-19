const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';
  await page.goto(url, { waitUntil: 'networkidle2' });

  const episodeUrl = await page.evaluate(() => {
    const el = document.querySelector('a[href*="/episodes/"]');
    return el ? el.href : null;
  });

  if (episodeUrl) {
    console.log('✅ 最新エピソードURL:', episodeUrl);
  } else {
    console.error('❌ URL取得失敗');
  }

  await browser.close();
})();