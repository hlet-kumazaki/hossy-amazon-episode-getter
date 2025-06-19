const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const url = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931';
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // 3秒待機
  await new Promise(resolve => setTimeout(resolve, 3000));

  // ページのHTMLを取得してログ出力（長すぎるので最初の1000文字だけ）
  const html = await page.content();
  console.log('----- HTML snapshot -----');
  console.log(html.slice(0, 1000)); // 長すぎるとGitHub Actionsログに載らないので一部だけ
  console.log('-------------------------');

  await browser.close();
})();