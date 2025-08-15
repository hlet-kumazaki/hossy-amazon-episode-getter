import { chromium } from "playwright";

// --- 入力（Actions から環境変数で渡す） ---
const CHANNEL_URL = process.env.CHANNEL_URL;                // 番組URL（必須 / repo Variables から）
const WP_USER = process.env.WP_USER;                        // Basic認証ユーザ（Secrets）
const WP_PASS = process.env.WP_PASS;                        // Basic認証パス（Secrets）
const FIELD_KEY = process.env.FIELD_KEY || "field_680d867a57991"; // ACFフィールドキー
const POST_ID = process.env.POST_ID && String(process.env.POST_ID).trim(); // 手動実行で指定可

// カンマ区切りで複数指定可。未指定ならデフォルト2パターンを試行
const ENDPOINTS_RAW = (process.env.ENDPOINTS || "").trim();
const ENDPOINTS = ENDPOINTS_RAW
  ? ENDPOINTS_RAW.split(",").map(s => s.trim()).filter(Boolean)
  : ["https://hossy.org/wp-json/agent/v1/meta", "https://hossy.org/wp-json/agent/v1/meta/"];

// --- 出力ヘルパー（指定の最終JSONだけを出す） ---
const finish = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
};
const fail = (msg = "Amazon Music page could not be loaded") => finish({ error: msg });

if (!CHANNEL_URL) fail("CHANNEL_URL missing");
if (!WP_USER || !WP_PASS) fail("WP credentials missing");

(async () => {
  let browser;
  try {
    // ① Amazon Music から “最初の横長カード” の URL を取得
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

    // ② WPエンドポイントへPOST（User-Agentは付けない）
    const auth = "Basic " + Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64");
    const baseBody = {
      field: FIELD_KEY,
      value: episode_url,
      is_acf: true,
      skip_if_exists: true,
    };
    // 手動実行で post_id 指定があれば送る（指定が無ければAPI側で最新podcastに解決）
    const body = POST_ID ? { ...baseBody, post_id: POST_ID } : baseBody;

    let resultJson = null;
    let lastError = null;

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
        if (res.ok) break; // 成功したら抜ける
        lastError = `http_${res.status}`;
      } catch (e) {
        lastError = String(e);
      }
    }

    // ③ 最終JSON（指定のキーのみ）
    const matched_post_id = resultJson?.post_id ?? null;

    const meta = resultJson?.meta || {};
    // 優先順：top-level.updated → meta.updated → meta.skipped の反転解釈（skipped=false なら更新あり）
    const updated =
      typeof resultJson?.updated === "boolean" ? resultJson.updated
      : typeof meta?.updated === "boolean" ? meta.updated
      : (typeof meta?.skipped === "boolean" ? (meta.skipped === false) : false);

    // 理由は top-level / meta の reason / skipped_reason を網羅的に参照
    const reason =
      resultJson?.reason
      || resultJson?.skipped_reason
      || meta?.reason
      || meta?.skipped_reason
      || null;

    const out = { episode_url, matched_post_id, updated };
    if (reason) out.reason = reason;
    else if (!resultJson && lastError) out.reason = "request_failed";

    return finish(out);
  } catch {
    return fail();
  } finally {
    if (browser) await browser.close();
  }
})();