const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';
  await page.goto(url, { waitUntil: 'domcontentloaded' }); // networkidle2 を弱めに変更

  // ⏳ 明示的に待つ（3秒）→ Amazon側のJS描画を待つため
  await page.waitForTimeout(3000);

  const selector = 'a[href^="/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931/episodes/"]';

  try {
    await page.waitForSelector(selector, { timeout: 10000 });

    const episodeUrl = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.href : null;
    }, selector);

    if (episodeUrl) {
      console.log('✅ 最新エピソードURL:', episodeUrl);
    } else {
      console.error('❌ URL取得失敗');
    }

  } catch (e) {
    console.error('❌ 要素が表示されませんでした:', e.message);
  }

  await browser.close();
})();