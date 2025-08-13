import { chromium } from "playwright";

const CHANNEL_URL = process.env.CHANNEL_URL;
if (!CHANNEL_URL) {
  console.log(JSON.stringify({ error: "CHANNEL_URL missing" }));
  process.exit(0);
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    await page.goto(CHANNEL_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    // 最初の横長カード
    const item = page.locator("music-episode-row-item").first();
    if (!(await item.count())) {
      console.log(JSON.stringify({ error: "Amazon Music page could not be loaded" }));
      return;
    }

    // primary-href属性を優先
    let href = await item.getAttribute("primary-href");
    if (!href) {
      const link = item.locator('a[href*="/episodes/"]').first();
      if (await link.count()) href = await link.getAttribute("href");
    }
    if (!href) {
      console.log(JSON.stringify({ error: "Amazon Music page could not be loaded" }));
      return;
    }

    // 絶対URL化
    if (href.startsWith("/")) {
      const { origin } = new URL(CHANNEL_URL);
      href = origin + href;
    }

    // URLだけ出力
    process.stdout.write(href + "\n");
  } catch {
    console.log(JSON.stringify({ error: "Amazon Music page could not be loaded" }));
  } finally {
    if (browser) await browser.close();
  }
})();
