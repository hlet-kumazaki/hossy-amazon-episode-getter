import { chromium } from "playwright";

const CHANNEL_URL = process.env.CHANNEL_URL;
if (!CHANNEL_URL) {
  console.log(JSON.stringify({ error: "CHANNEL_URL missing" }));
  process.exit(0);
}

function outError(msg) {
  console.log(JSON.stringify({ error: msg }));
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const page = await context.newPage();

    await page.goto(CHANNEL_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    const card = page.locator('[data-testid="music-episode-row-item"], .music-episode-row-item').first();
    let episodeUrl = null;

    if (await card.count()) {
      const link = card.locator('a[href*="/episodes/"]').first();
      if (await link.count()) {
        episodeUrl = await link.getAttribute("href");
      } else {
        episodeUrl = await card.getAttribute("primary-href");
      }
    }
    if (!episodeUrl) {
      const section = page.locator('section:has-text("おすすめ"), section:has-text("始める")').first();
      if (await section.count()) {
        const link = section.locator('a[href*="/episodes/"]').first();
        if (await link.count()) episodeUrl = await link.getAttribute("href");
      }
    }
    if (episodeUrl && episodeUrl.startsWith("/")) {
      const { origin } = new URL(CHANNEL_URL);
      episodeUrl = origin + episodeUrl;
    }

    if (!episodeUrl) return outError("Amazon Music page could not be loaded");
    process.stdout.write(episodeUrl + "\n");
  } catch {
    outError("Amazon Music page could not be loaded");
  } finally {
    if (browser) await browser.close();
  }
})();
