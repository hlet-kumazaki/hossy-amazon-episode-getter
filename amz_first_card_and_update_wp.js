import { chromium } from "playwright";

const CHANNEL_URL = process.env.CHANNEL_URL;
const WP_USER = process.env.WP_USER;
const WP_PASS = process.env.WP_PASS;
const FIELD_KEY = process.env.FIELD_KEY || "field_680d867a57991";
const POST_ID = process.env.POST_ID && String(process.env.POST_ID).trim();

const YT_FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=UC4vypjnhxhnyGERcqRGv5nA";
const ITUNES_LOOKUP_URL = "https://itunes.apple.com/lookup?id=1810690058&country=JP&media=podcast&entity=podcastEpisode";
const SPOTIFY_SHOW_ID = "1F9Wl0HZBxkHsVToJhpyQl";

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

function episodeNumFromTitle(t) {
  if (!t || typeof t !== "string") return null;
  const m = t.match(/^\s*Episode\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function episodeNumFromUrl(u) {
  if (!u || typeof u !== "string") return null;
  const dec = decodeURIComponent(u);
  const m = dec.match(/episode[\s\\-_/]*([0-9]{1,4})/i);
  return m ? Number(m[1]) : null;
}

async function getJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "Accept": "*/*" } });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { ok: r.ok, status: r.status, text, json: data };
  } catch (e) {
    return { ok: false, status: 0, text: String(e), json: null };
  } finally {
    clearTimeout(id);
  }
}

async function getText(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "Accept": "text/html,*/*" } });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String(e) };
  } finally {
    clearTimeout(id);
  }
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

    // === Amazon Music: 最初のエピソード（row-item を採用） ===
    const item = page.locator('music-episode-row-item').first();
    if (!(await item.count())) return fail();

    // URLの拾い方：1) primary-href → 2) 内部リンク /episodes/ のhref
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

    // === 整合性チェック用：サイトの最新Episode番号を取得 ===
    const latestSite = await getJson("https://hossy.org/wp-json/agent/v1/latest");
    const expectedEpisode = latestSite?.json?.episode_num ?? null;
    const targetTitle = latestSite?.json?.title || null;
    const targetUrl   = latestSite?.json?.url   || null;

    // Amazon（チャンネルの最初のカードからタイトルを推測）
    let amazonTitle = null;
    try {
      // 1st: row-item の primary-text 属性
      const attrTitle = await item.getAttribute("primary-text");
      if (attrTitle && attrTitle.trim()) {
        amazonTitle = attrTitle.trim();
      }
      // 2nd: スロット/一般セレクタ
      if (!amazonTitle) {
        const titleNode = item.locator('[slot="title"], .title, [data-testid="title"]').first();
        if (await titleNode.count()) {
          const t = (await titleNode.innerText()).trim();
          if (t) amazonTitle = t;
        }
      }
      // 3rd: textContent の1行目
      if (!amazonTitle) {
        const raw = await item.evaluate(el => (el.textContent || '').trim());
        if (raw) {
          amazonTitle = raw.split('\n').map(s => s.trim()).filter(Boolean)[0] || raw.replace(/\s+/g, ' ');
        }
      }
    } catch {}

    const amazonActual = (episodeNumFromTitle(amazonTitle) ?? episodeNumFromUrl(episode_url));

    // 他PFの最新タイトル（軽量取得、失敗しても続行）
    let ytTitle = null, itTitle = null, spTitle = null;

    // YouTube: Atom feed
    try {
      const r = await getText(YT_FEED_URL);
      if (r.ok) {
        const m = r.text.match(/<entry>[\s\S]*?<title>([^<]+)<\/title>/i);
        if (m) ytTitle = m[1];
      }
    } catch {}

    // iTunes: Lookup API
    try {
      const r = await getJson(ITUNES_LOOKUP_URL);
      if (r.ok && r.json && Array.isArray(r.json.results)) {
        const ep = r.json.results.find(x => x.wrapperType === "podcastEpisode");
        if (ep) itTitle = ep.trackName || ep.collectionName || null;
      }
    } catch {}

    // Spotify: Web（クローラでshowページ先頭のエピソード名を拾う）
    try {
      const spPage = await context.newPage();
      await spPage.goto(`https://open.spotify.com/show/${SPOTIFY_SHOW_ID}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await spPage.waitForLoadState("networkidle", { timeout: 60000 });
      const firstEp = spPage.locator('a[href^="/episode/"]').first();
      if (await firstEp.count()) {
        const container = firstEp.locator('xpath=ancestor-or-self::*[1]');
        spTitle = (await container.innerText()).split('\n').filter(Boolean)[0] || null;
      }
      await spPage.close();
    } catch {}

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

    const amazonPlatform = asPlatform("amazon_music", episode_url, resultJson);
    amazonPlatform.coherence = {
      expected: expectedEpisode,
      actual: amazonActual,
      title: amazonTitle,
      matched: (expectedEpisode == null) ? true : (amazonActual === expectedEpisode)
    };
    platforms.push(amazonPlatform);

    const feeds = resultJson?.feeds || {};
    const yt = feeds?.youtube;
    const it = feeds?.itunes;

    if (yt) {
      const yt_url = yt?.episode_url || yt?.url || yt?.value || yt?.link || null;
      const obj = asPlatform("youtube", yt_url, yt);
      obj.coherence = {
        expected: expectedEpisode,
        actual: episodeNumFromTitle(ytTitle),
        title: ytTitle,
        matched: (expectedEpisode != null && episodeNumFromTitle(ytTitle) === expectedEpisode) || expectedEpisode == null ? true : false
      };
      platforms.push(obj);
    } else {
      const obj = asPlatform("youtube", null, yt || {});
      obj.coherence = {
        expected: expectedEpisode, actual: episodeNumFromTitle(ytTitle), title: ytTitle,
        matched: (expectedEpisode != null && episodeNumFromTitle(ytTitle) === expectedEpisode) || expectedEpisode == null ? true : false
      };
      platforms.push(obj);
    }

    if (it) {
      const it_url = it?.episode_url || it?.url || it?.value || it?.link || null;
      const obj = asPlatform("itunes", it_url, it);
      obj.coherence = {
        expected: expectedEpisode,
        actual: episodeNumFromTitle(itTitle),
        title: itTitle,
        matched: (expectedEpisode != null && episodeNumFromTitle(itTitle) === expectedEpisode) || expectedEpisode == null ? true : false
      };
      platforms.push(obj);
    } else {
      const obj = asPlatform("itunes", null, it || {});
      obj.coherence = {
        expected: expectedEpisode, actual: episodeNumFromTitle(itTitle), title: itTitle,
        matched: (expectedEpisode != null && episodeNumFromTitle(itTitle) === expectedEpisode) || expectedEpisode == null ? true : false
      };
      platforms.push(obj);
    }

    const sp_wrap = resultJson?.spotify || {};
    const sp = sp_wrap?.result || null;
    const sp_url =
      (sp && (sp?.episode_url || sp?.url || sp?.value || sp?.link))
      || null;
    const spObj = asPlatform("spotify", sp_url, sp || sp_wrap);
    spObj.coherence = {
      expected: expectedEpisode,
      actual: episodeNumFromTitle(spTitle),
      title: spTitle,
      matched: (expectedEpisode != null && episodeNumFromTitle(spTitle) === expectedEpisode) || expectedEpisode == null ? true : false
    };
    platforms.push(spObj);

    // ④ 最終出力（要望フォーマット）
    return finish({ matched_post_id, target_title: targetTitle, target_url: targetUrl, platforms });
  } catch {
    return fail();
  } finally {
    if (browser) await browser.close();
  }
})();