import { chromium } from "playwright";

const CHANNEL_URL = process.env.CHANNEL_URL;
const WP_USER = process.env.WP_USER;
const WP_PASS = process.env.WP_PASS;
const FIELD_KEY = process.env.FIELD_KEY || "field_680d867a57991";
const POST_ID = process.env.POST_ID && String(process.env.POST_ID).trim();

const ENDPOINTS_RAW = (process.env.ENDPOINTS || "").trim();
const ENDPOINTS = ENDPOINTS_RAW
  ? ENDPOINTS_RAW.split(",").map(s => s.trim()).filter(Boolean)
  : ["https://hossy.org/wp-json/agent/v1/meta", "https://hossy.org/wp-json/agent/v1/meta/"];

const finish = (obj) => { process.stdout.write(JSON.stringify(obj) + "\n"); process.exit(0); };
const fail   = (msg="Amazon Music page could not be loaded") => finish({ error: msg });

if (!CHANNEL_URL) fail("CHANNEL_URL missing");
if (!WP_USER || !WP_PASS) fail("WP credentials missing");

function pickUpdated(obj) {
  const meta = obj?.meta || {};
  if (typeof obj?.updated === "boolean") return obj.updated;
  if (typeof meta.updated === "boolean") return meta.updated;
  if (typeof meta.skipped === "boolean") return meta.skipped === false;
  return false;
}
function pickReason(obj) {
  const meta = obj?.meta || {};
  return obj?.reason || obj?.skipped_reason || meta?.reason || meta?.skipped_reason || null;
}
function asPlatform(name, episode_url, srcObj) {
  const updated = pickUpdated(srcObj);
  const reason = pickReason(srcObj);
  const o = { name, episode_url, updated };
  if (reason) o.skipped_reason = reason;
  return o;
}

(async () => {
  let browser;
  try {
    // ① Amazon Music から “最初の横長カード” の URL を取得
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(CHANNEL_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    const item = page.locator("music-episode-row-item").first();
    if (!(await item.count())) return fail();

    let href = await item.getAttribute("primary-href");
    if (!href) {
      const link = item.locator('a[href*="/episodes/"]').first();
      if (await link.count()) href = await link.getAttribute("href");
    }
    if (!href) return fail();
    if (href.startsWith("/")) {
      const { origin } = new URL(CHANNEL_URL);
      href = origin + href;
    }
    const episode_url = href;

    // ② WPエンドポイントへPOST
    const auth = "Basic " + Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64");
    const baseBody = {
      field: FIELD_KEY,
      value: episode_url,
      is_acf: true,
      skip_if_exists: true,
    };
    const body = POST_ID ? { ...baseBody, post_id: POST_ID } : baseBody;

    let resultJson = null;
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "Authorization": auth,
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        try { resultJson = JSON.parse(text); } catch { resultJson = { raw: text }; }
        if (res.ok) break;
      } catch {}
    }

    // ③ プラットフォーム配列を組み立て
    const matched_post_id = resultJson?.post_id ?? null;

    const platforms = [];

    // a) Amazon（今回の主対象）
    platforms.push(asPlatform("amazon_music", episode_url, resultJson));

    // b) YouTube / iTunes（PHP: feeds.youtube / feeds.itunes）
    const feeds = resultJson?.feeds || {};
    const yt = feeds?.youtube;
    const it = feeds?.itunes;

    if (yt) {
      const yt_url =
        yt?.episode_url || yt?.url || yt?.value || yt?.link || null;
      platforms.push(asPlatform("youtube", yt_url, yt));
    }
    if (it) {
      const it_url =
        it?.episode_url || it?.url || it?.value || it?.link || null;
      platforms.push(asPlatform("itunes", it_url, it));
    }

    // c) Spotify（PHP: spotify.enabled/result）
    const sp_wrap = resultJson?.spotify || {};
    const sp = sp_wrap?.result || null;
    if (sp || sp_wrap?.enabled) {
      const sp_url =
        (sp && (sp?.episode_url || sp?.url || sp?.value || sp?.link))
        || null;
      platforms.push(asPlatform("spotify", sp_url, sp || sp_wrap));
    }

    // ④ 最終出力（要望フォーマット）
    return finish({ matched_post_id, platforms });
  } catch {
    return fail();
  } finally {
    if (browser) await browser.close();
  }
})();