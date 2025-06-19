const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // 5秒待つ（長めに）
  await new Promise(resolve => setTimeout(resolve, 5000));

  // すべての a タグを抽出して、エピソードリンク候補を探す
  const allLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a'))
      .map(el => el.href)
      .filter(href => href.includes('/podcasts/') && href.includes('/episodes/'));
  });

  if (allLinks.length > 0) {
    console.log('✅ 見つかったリンク一覧:');
    allLinks.forEach((url, i) => {
      console.log(`${i + 1}: ${url}`);
    });
  } else {
    console.error('❌ エピソードリンクが見つかりませんでした');
  }

  await browser.close();
})();