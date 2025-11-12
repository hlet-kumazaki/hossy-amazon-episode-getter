const { chromium } = require("playwright");

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
  : [
      "https://hossy.org/wp-json/agent/v1/meta",
      "https://hossy.org/wp-json/agent/v1/meta/"
    ];

function finish(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}
function fail(msg = "Amazon Music page could not be loaded") {
  finish({ error: msg });
}

if (!CHANNEL_URL) fail("CHANNEL_URL missing");
if (!WP_USER || !WP_PASS) fail("WP credentials missing");

function pickUpdated(obj) {
  const meta = (obj && obj.meta) || {};
  if (typeof (obj && obj.updated) === "boolean") return obj.updated;
  if (typeof meta.updated === "boolean") return meta.updated;
  if (typeof meta.skipped === "boolean") return meta.skipped === false;
  return false;
}
function pickReason(obj) {
  const meta = (obj && obj.meta) || {};
  return (obj && (obj.reason || obj.skipped_reason)) || meta.reason || meta.skipped_reason || null;
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
  const m = dec.match(/episode[\s\-_/]*([0-9]{1,4})/i);
  return m ? Number(m[1]) : null;
}

async function getJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: "*/*" } });
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
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
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: "text/html,*/*" } });
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
    // ① Amazon Music の最初の横長カードから URL 取得
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

    // ② hossy.org 側の期待エピソード & 既存のプラットフォームURL
    const latestSite = await getJson("https://hossy.org/wp-json/agent/v1/latest");
    const expectedEpisode = latestSite && latestSite.json ? latestSite.json.episode_num : null;
    const targetTitle = latestSite && latestSite.json ? latestSite.json.title : null;
    const targetUrl = latestSite && latestSite.json ? latestSite.json.url : null;
    const targetPostId = latestSite && latestSite.json ? latestSite.json.post_id : null;
    const existingFields = latestSite && latestSite.json ? latestSite.json.fields : null;
    
    // 既存のプラットフォームURLをチェック
    const existingAmazon = existingFields && existingFields.amazon_music ? existingFields.amazon_music.trim() : "";
    const existingYouTube = existingFields && existingFields.youtube ? existingFields.youtube.trim() : "";
    const existingItunes = existingFields && existingFields.itunes ? existingFields.itunes.trim() : "";
    const existingSpotify = existingFields && existingFields.spotify ? existingFields.spotify.trim() : "";
    
    // どのプラットフォームを取得する必要があるか判定
    const needAmazon = !existingAmazon;
    const needYouTube = !existingYouTube;
    const needItunes = !existingItunes;
    const needSpotify = !existingSpotify;

    // Amazon タイトル（推測） - 整合性チェックのため常に取得
    let amazonTitle = null;
    try {
      const attrTitle = await item.getAttribute("primary-text");
      if (attrTitle && attrTitle.trim()) amazonTitle = attrTitle.trim();
      if (!amazonTitle) {
        const titleNode = item.locator('[slot="title"], .title, [data-testid="title"]').first();
        if (await titleNode.count()) {
          const t = (await titleNode.innerText()).trim();
          if (t) amazonTitle = t;
        }
      }
      if (!amazonTitle) {
        const raw = await item.evaluate((el) => (el.textContent || "").trim());
        if (raw) amazonTitle = raw.split("\n").map((s) => s.trim()).filter(Boolean)[0] || raw.replace(/\s+/g, " ");
      }
    } catch {}

    const amazonActual = episodeNumFromTitle(amazonTitle) ?? episodeNumFromUrl(episode_url);
    
    // 整合性チェック（Amazon Music）
    const amazonMatched = expectedEpisode == null ? true : amazonActual === expectedEpisode;

    // ③ 他PFの軽量取得（必要なプラットフォームのみ）
    let ytTitle = null,
      itTitle = null,
      spTitle = null;
    
    // YouTube の取得（必要な場合のみ）
    if (needYouTube) {
      try {
        const r = await getText(YT_FEED_URL);
        if (r.ok) {
          const m = r.text.match(/<entry>[\s\S]*?<title>([^<]+)<\/title>/i);
          if (m) ytTitle = m[1];
        }
      } catch {}
    }
    
    // iTunes の取得（必要な場合のみ）
    if (needItunes) {
      try {
        const r = await getJson(ITUNES_LOOKUP_URL);
        if (r.ok && r.json && Array.isArray(r.json.results)) {
          const ep = r.json.results.find((x) => x.wrapperType === "podcastEpisode");
          if (ep) itTitle = ep.trackName || ep.collectionName || null;
        }
      } catch {}
    }
    
    // Spotify の取得（必要な場合のみ）
    if (needSpotify) {
      try {
        const spPage = await context.newPage();
        await spPage.goto(`https://open.spotify.com/show/${SPOTIFY_SHOW_ID}`, {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });
        await spPage.waitForLoadState("networkidle", { timeout: 60000 });
        const firstEp = spPage.locator('a[href^="/episode/"]').first();
        if (await firstEp.count()) {
          const container = firstEp.locator("xpath=ancestor-or-self::*[1]");
          spTitle = (await container.innerText()).split("\n").filter(Boolean)[0] || null;
        }
        await spPage.close();
      } catch {}
    }

    // ④ WP 更新（Amazon Music が必要で、整合性チェックがマッチした場合のみ）
    const auth = "Basic " + Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64");
    let resultJson = null;
    
    if (!needAmazon) {
      // Amazon Musicが既に存在する場合はスキップ
      resultJson = { 
        skipped: true, 
        reason: "Amazon Music URL already exists",
        post_id: targetPostId || POST_ID
      };
    } else if (!amazonMatched) {
      // 整合性チェックがマッチしない場合はスキップ
      resultJson = { 
        skipped: true, 
        reason: `Episode number mismatch (expected: ${expectedEpisode}, actual: ${amazonActual})`,
        post_id: targetPostId || POST_ID
      };
    } else {
      // 整合性チェックがマッチした場合のみ更新
      const baseBody = { field: FIELD_KEY, value: episode_url, is_acf: true, skip_if_exists: true };
      const body = POST_ID ? { ...baseBody, post_id: POST_ID } : baseBody;

      for (const url of ENDPOINTS) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Accept: "application/json",
              Authorization: auth,
            },
            body: JSON.stringify(body),
          });
          const text = await res.text();
          try {
            resultJson = JSON.parse(text);
          } catch {
            resultJson = { raw: text };
          }
          if (res.ok) break;
        } catch {}
      }
    }

    // ⑤ platforms
    const matched_post_id = resultJson && resultJson.post_id ? resultJson.post_id : null;
    const platforms = [];

    // Amazon Music
    let amazonPlatform;
    
    if (!needAmazon) {
      // 既存URLを使用
      amazonPlatform = { 
        name: "amazon_music", 
        episode_url: existingAmazon, 
        updated: false, 
        skipped_reason: "URL already exists" 
      };
    } else if (!amazonMatched) {
      // 整合性チェック失敗
      amazonPlatform = { 
        name: "amazon_music", 
        episode_url: null, 
        updated: false, 
        skipped_reason: `Episode number mismatch (expected: ${expectedEpisode}, actual: ${amazonActual})` 
      };
    } else {
      // 新規取得して更新
      amazonPlatform = asPlatform("amazon_music", episode_url, resultJson);
    }
    
    amazonPlatform.coherence = {
      expected: expectedEpisode,
      actual: needAmazon ? amazonActual : null,
      title: needAmazon ? amazonTitle : null,
      matched: needAmazon ? amazonMatched : null,  // 既存URLがある場合はN/A
    };
    platforms.push(amazonPlatform);

    // YouTube
    const feeds = (resultJson && resultJson.feeds) || {};
    const yt = feeds.youtube;
    let ytObj;
    
    if (!needYouTube) {
      // 既存URLを使用
      ytObj = { 
        name: "youtube", 
        episode_url: existingYouTube, 
        updated: false, 
        skipped_reason: "URL already exists" 
      };
    } else if (yt) {
      const yt_url = yt.episode_url || yt.url || yt.value || yt.link || null;
      ytObj = asPlatform("youtube", yt_url, yt);
    } else {
      ytObj = asPlatform("youtube", null, yt || {});
    }
    
    ytObj.coherence = {
      expected: expectedEpisode,
      actual: needYouTube ? episodeNumFromTitle(ytTitle) : null,
      title: needYouTube ? ytTitle : null,
      matched: needYouTube
        ? ((expectedEpisode != null && episodeNumFromTitle(ytTitle) === expectedEpisode) ||
           expectedEpisode == null
             ? true
             : false)
        : null,  // 既存URLがある場合はN/A
    };
    platforms.push(ytObj);

    // iTunes
    const it = feeds.itunes;
    let itObj;
    
    if (!needItunes) {
      // 既存URLを使用
      itObj = { 
        name: "itunes", 
        episode_url: existingItunes, 
        updated: false, 
        skipped_reason: "URL already exists" 
      };
    } else if (it) {
      const it_url = it.episode_url || it.url || it.value || it.link || null;
      itObj = asPlatform("itunes", it_url, it);
    } else {
      itObj = asPlatform("itunes", null, it || {});
    }
    
    itObj.coherence = {
      expected: expectedEpisode,
      actual: needItunes ? episodeNumFromTitle(itTitle) : null,
      title: needItunes ? itTitle : null,
      matched: needItunes
        ? ((expectedEpisode != null && episodeNumFromTitle(itTitle) === expectedEpisode) ||
           expectedEpisode == null
             ? true
             : false)
        : null,  // 既存URLがある場合はN/A
    };
    platforms.push(itObj);

    // Spotify
    const sp_wrap = (resultJson && resultJson.spotify) || {};
    const sp = sp_wrap.result || null;
    let spObj;
    
    if (!needSpotify) {
      // 既存URLを使用
      spObj = { 
        name: "spotify", 
        episode_url: existingSpotify, 
        updated: false, 
        skipped_reason: "URL already exists" 
      };
    } else {
      const sp_url = (sp && (sp.episode_url || sp.url || sp.value || sp.link)) || null;
      spObj = asPlatform("spotify", sp_url, sp || sp_wrap);
    }
    
    spObj.coherence = {
      expected: expectedEpisode,
      actual: needSpotify ? episodeNumFromTitle(spTitle) : null,
      title: needSpotify ? spTitle : null,
      matched: needSpotify
        ? ((expectedEpisode != null && episodeNumFromTitle(spTitle) === expectedEpisode) ||
           expectedEpisode == null
             ? true
             : false)
        : null,  // 既存URLがある場合はN/A
    };
    platforms.push(spObj);

    // ⑥ 出力
    finish({ matched_post_id, target_title: targetTitle, target_url: targetUrl, platforms });
  } catch (e) {
    fail(String(e && e.message ? e.message : e));
  } finally {
    if (browser) await browser.close();
  }
})();