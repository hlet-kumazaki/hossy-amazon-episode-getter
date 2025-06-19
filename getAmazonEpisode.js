const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // JS描画待ち
  await new Promise(resolve => setTimeout(resolve, 8000));

  // Shadow DOMを掘る
  const episodeUrl = await page.evaluate(async () => {
    const item = document.querySelector('music-episode-row-item');
    if (!item) return null;

    const getShadowLink = async (elem) => {
      return new Promise(resolve => {
        const interval = setInterval(() => {
          const shadow = elem.shadowRoot;
          if (shadow) {
            const aTag = shadow.querySelector('a[href*="/episodes/"]');
            if (aTag) {
              clearInterval(interval);
              resolve(aTag.href);
            }
          }
        }, 200);
        setTimeout(() => clearInterval(interval), 5000); // timeout fallback
      });
    };

    return await getShadowLink(item);
  });

  if (episodeUrl) {
    console.log('✅ Shadow DOM内のエピソードURL:', episodeUrl);
  } else {
    console.error('❌ Shadow DOMからもURL取得に失敗しました');
  }

  await browser.close();
})();