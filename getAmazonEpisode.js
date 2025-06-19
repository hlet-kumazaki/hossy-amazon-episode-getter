const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // JS描画を待つ
  await page.waitForTimeout(8000);

  try {
    // カスタム要素をハンドルとして取得
    const episodeHandle = await page.$('music-episode-row-item');
    if (!episodeHandle) throw new Error('music-episode-row-item が見つかりません');

    // Shadow Rootを取得
    const shadowRootHandle = await episodeHandle.evaluateHandle(el => el.shadowRoot);
    if (!shadowRootHandle) throw new Error('shadowRoot が null');

    // Shadow DOM内部の <a> タグ取得
    const linkHandle = await shadowRootHandle.$('a[href*="/episodes/"]');
    if (!linkHandle) throw new Error('リンク要素が shadowRoot 内に見つかりません');

    // href属性を取得
    const episodeUrl = await linkHandle.evaluate(el => el.href);
    console.log('✅ Shadow DOM内のエピソードURL:', episodeUrl);

  } catch (err) {
    console.error('❌ 取得失敗:', err.message);
  }

  await browser.close();
})();