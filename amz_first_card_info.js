import { chromium } from "playwright";

const CHANNEL_URL = process.env.CHANNEL_URL;
if (!CHANNEL_URL) {
  console.log(JSON.stringify({ error: "CHANNEL_URL missing" }));
  process.exit(0);
}

const out = (obj) => console.log(JSON.stringify(obj));

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

    const res = await page.goto(CHANNEL_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    // 最初の横長カード = music-episode-row-item の先頭
    const item = page.locator("music-episode-row-item").first();
    if (!(await item.count())) {
      return out({ error: "Amazon Music page could not be loaded" });
    }

    // 1) まず属性から読む（推奨）
    let href = await item.getAttribute("primary-href");
    let title = await item.getAttribute("primary-text");

    // 2) フォールバック：内部の a[href*="/episodes/"] から取得
    if (!href) {
      const link = item.locator('a[href*="/episodes/"]').first();
      if (await link.count()) href = await link.getAttribute("href");
    }
    if (!title) {
      const t = await item.textContent();
      title = (t || "").trim() || null;
    }

    if (!href) {
      return out({ error: "Amazon Music page could not be loaded" });
    }

    // 絶対URL化
    if (href.startsWith("/")) {
      const { origin } = new URL(CHANNEL_URL);
      href = origin + href;
    }

    out({ episode_url: href, title });
  } catch {
    out({ error: "Amazon Music page could not be loaded" });
  } finally {
    if (browser) await browser.close();
  }
})();
