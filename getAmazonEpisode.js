const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // 🔧 waitForTimeout の代用
  await new Promise(resolve => setTimeout(resolve, 8000));

  try {
    const episodeHandle = await page.$('music-episode-row-item');
    if (!episodeHandle) throw new Error('music-episode-row-item が見つかりません');

    const shadowRootHandle = await episodeHandle.evaluateHandle(el => el.shadowRoot);
    if (!shadowRootHandle) throw new Error('shadowRoot が null');

    const linkHandle = await shadowRootHandle.$('a[href*="/episodes/"]');
    if (!linkHandle) throw new Error('リンク要素が shadowRoot 内に見つかりません');

    const episodeUrl = await linkHandle.evaluate(el => el.href);
    console.log('✅ Shadow DOM内のエピソードURL:', episodeUrl);

  } catch (err) {
    console.error('❌ 取得失敗:', err.message);
  }

  await browser.close();
})();