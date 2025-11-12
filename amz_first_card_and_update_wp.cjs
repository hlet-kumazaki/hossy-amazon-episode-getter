const { chromium } = require("playwright");

const CHANNEL_URL = process.env.CHANNEL_URL;
const WP_USER = process.env.WP_USER;
const WP_PASS = process.env.WP_PASS;
const FIELD_KEY_AMAZON = process.env.FIELD_KEY_AMAZON || "field_680d867a57991"; // backward compat
const FIELD_KEY_YOUTUBE = process.env.FIELD_KEY_YOUTUBE || "field_680bf82a6b5c0";
const FIELD_KEY_ITUNES  = process.env.FIELD_KEY_ITUNES  || "field_680bf86a6b5c2";
const FIELD_KEY_SPOTIFY = process.env.FIELD_KEY_SPOTIFY || "field_680bf85c6b5c1";
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

// Helper to POST update to WP for a specific fieldKey/value/postId
async function postToWP(fieldKey, value, postId, skipIfExists = true) {
  if (!fieldKey) return { skipped: true, reason: "no_field_key" };
  if (!value)    return { skipped: true, reason: "no_value" };
  const auth = "Basic " + Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64");
  const baseBody = { field: fieldKey, value, is_acf: true, skip_if_exists: !!skipIfExists };
  const body = postId ? { ...baseBody, post_id: postId } : baseBody;
  let last = { skipped: true, reason: "no_endpoint" };
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
      try { last = JSON.parse(text); } catch { last = { raw: text }; }
      // normalize result shape for mail/jq
      if (last && typeof last === "object") {
        const meta = last.meta || {};
        if (typeof last.skipped === "boolean" && typeof meta.skipped !== "boolean") meta.skipped = last.skipped;
        if ((last.reason || last.skipped_reason) && !meta.reason) meta.reason = last.reason || last.skipped_reason;
        if (typeof last.updated !== "boolean" && typeof meta.skipped === "boolean") last.updated = (meta.skipped === false);
        last.meta = meta;
      }
      if (res.ok) break;
    } catch (e) {
      last = { skipped: true, reason: String(e && e.message ? e.message : e) };
    }
  }
  return last;
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
function computeMatched(need, actual, expected, bootstrap) {
  // If the platform URL already exists, we want matched = null ("--")
  if (!need) return null;
  // When expected is not available (bootstrap run), fall back to a bootstrap value (e.g., Amazon first card number)
  const exp = expected != null ? expected : bootstrap;
  if (exp == null || actual == null) return false;
  return actual === exp;
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
    const cacheBust = Date.now();
    const latestSite = await getJson(`https://hossy.org/wp-json/agent/v1/latest?t=${cacheBust}`);
    const expectedEpisode = latestSite && latestSite.json ? latestSite.json.episode_num : null;
    //const expectedEpisode = 1;
    const targetTitle = latestSite && latestSite.json ? latestSite.json.title : null;
    const targetUrl = latestSite && latestSite.json ? latestSite.json.url : null;
    const targetPostId = latestSite && latestSite.json ? latestSite.json.post_id : null;
    const existingFields = latestSite && latestSite.json ? latestSite.json.fields : null;

    function pickUrlField(fields, keys) {
      if (!fields || typeof fields !== "object") return "";
      for (const k of keys) {
        const v = fields[k];
        let s = null;
        if (!v) continue;
        if (typeof v === "string") s = v;
        else if (typeof v.url === "string") s = v.url;
        else if (typeof v.value === "string") s = v.value;
        if (typeof s === "string") {
          s = s.trim();
          if (!s || s === "null" || s === "undefined") continue;
          return s;
        }
      }
      return "";
    }

    // 既存のプラットフォームURLをチェック
    const existingAmazon = pickUrlField(existingFields, ["amazon_music", "amazon", "amazon_music_url"]);
    const existingYouTube = pickUrlField(existingFields, ["youtube", "yt", "youtube_url"]);
    const existingItunes = pickUrlField(existingFields, ["itunes", "apple_podcasts", "itunes_url", "apple_podcasts_url"]);
    const existingSpotify = pickUrlField(existingFields, ["spotify", "spotify_url"]);

    // どのプラットフォームを取得する必要があるか判定
    const needAmazon = !(existingAmazon && /^https?:\/\//.test(existingAmazon));
    const needYouTube = !(existingYouTube && /^https?:\/\//.test(existingYouTube));
    const needItunes = !(existingItunes && /^https?:\/\//.test(existingItunes));
    const needSpotify = !(existingSpotify && /^https?:\/\//.test(existingSpotify));

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
    let ytUrl = null, itUrl = null, spUrl = null;
    // YouTube の取得（必要な場合のみ）
    if (needYouTube) {
      try {
        const r = await getText(YT_FEED_URL);
        if (r.ok) {
          const m = r.text.match(/<entry>[\s\S]*?<title>([^<]+)<\/title>/i);
          if (m) ytTitle = m[1];
          // Extract YouTube episode URL from feed
          const mLink = r.text.match(/<entry>[\s\S]*?<link[^>]*href=\"([^\"]+)\"/i);
          if (mLink) ytUrl = mLink[1];
        }
      } catch {}
    }
    // iTunes の取得（必要な場合のみ）
    if (needItunes) {
      try {
        const r = await getJson(ITUNES_LOOKUP_URL);
        if (r.ok && r.json && Array.isArray(r.json.results)) {
          const ep = r.json.results.find((x) => x.wrapperType === "podcastEpisode");
          var itUrlTemp = null;
          if (ep) {
            itTitle = ep.trackName || ep.collectionName || null;
            itUrlTemp = ep.trackViewUrl || null;
          }
          itUrl = itUrlTemp;
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
          const href = await firstEp.getAttribute("href");
          if (href) {
            const { origin } = new URL("https://open.spotify.com");
            spUrl = origin + href;
          }
          const container = firstEp.locator("xpath=ancestor-or-self::*[1]");
          spTitle = (await container.innerText()).split("\n").filter(Boolean)[0] || null;
        }
        await spPage.close();
      } catch {}
    }

    // ④ 各PFを独立で WP 更新
    let resultAmazon = null, resultYouTube = null, resultItunes = null, resultSpotify = null;
    const postId = targetPostId || POST_ID;
    // Amazon
    const sameAMZ = !!(existingAmazon && episode_url && existingAmazon === episode_url);
    if (!needAmazon) {
      resultAmazon = { updated: false, skipped_reason: "already_has_value", post_id: postId, meta: { skipped: true, reason: "already_has_value" } };
    } else if (amazonActual == null || expectedEpisode == null ? false : amazonActual !== expectedEpisode) {
      resultAmazon = { updated: false, skipped_reason: `Episode number mismatch (expected: ${expectedEpisode}, actual: ${amazonActual})`, post_id: postId, meta: { skipped: true, reason: `Episode number mismatch (expected: ${expectedEpisode}, actual: ${amazonActual})` } };
    } else {
      resultAmazon = await postToWP(FIELD_KEY_AMAZON, episode_url, postId, /* skip_if_exists: */ sameAMZ || !needAmazon);
    }
    // Fallback: same URL but no reason from API -> treat as already_has_value
    if (sameAMZ && (!pickReason(resultAmazon))) {
      resultAmazon = { ...(resultAmazon||{}), updated: false, skipped_reason: "already_has_value", meta: { ...(resultAmazon&&resultAmazon.meta||{}), skipped: true, reason: "already_has_value" } };
    }
    // YouTube
    const sameYT = !!(existingYouTube && ytUrl && existingYouTube === ytUrl);
    if (!needYouTube) {
      resultYouTube = { updated: false, skipped_reason: "already_has_value", post_id: postId, meta: { skipped: true, reason: "already_has_value" } };
    } else if (episodeNumFromTitle(ytTitle) == null && expectedEpisode != null) {
      resultYouTube = { updated: false, skipped_reason: "no_title_or_episode", post_id: postId, meta: { skipped: true, reason: "no_title_or_episode" } };
    } else {
      resultYouTube = await postToWP(FIELD_KEY_YOUTUBE, ytUrl, postId, /* skip_if_exists: */ sameYT || !needYouTube);
    }
    if (sameYT && (!pickReason(resultYouTube))) {
      resultYouTube = { ...(resultYouTube||{}), updated: false, skipped_reason: "already_has_value", meta: { ...(resultYouTube&&resultYouTube.meta||{}), skipped: true, reason: "already_has_value" } };
    }
    // iTunes
    const sameIT = !!(existingItunes && itUrl && existingItunes === itUrl);
    if (!needItunes) {
      resultItunes = { updated: false, skipped_reason: "already_has_value", post_id: postId, meta: { skipped: true, reason: "already_has_value" } };
    } else if (episodeNumFromTitle(itTitle) == null && expectedEpisode != null) {
      resultItunes = { updated: false, skipped_reason: "no_title_or_episode", post_id: postId, meta: { skipped: true, reason: "no_title_or_episode" } };
    } else {
      resultItunes = await postToWP(FIELD_KEY_ITUNES, itUrl, postId, /* skip_if_exists: */ sameIT || !needItunes);
    }
    if (sameIT && (!pickReason(resultItunes))) {
      resultItunes = { ...(resultItunes||{}), updated: false, skipped_reason: "already_has_value", meta: { ...(resultItunes&&resultItunes.meta||{}), skipped: true, reason: "already_has_value" } };
    }
    // Spotify
    const sameSP = !!(existingSpotify && spUrl && existingSpotify === spUrl);
    if (!needSpotify) {
      resultSpotify = { updated: false, skipped_reason: "already_has_value", post_id: postId, meta: { skipped: true, reason: "already_has_value" } };
    } else if (episodeNumFromTitle(spTitle) == null && expectedEpisode != null) {
      resultSpotify = { updated: false, skipped_reason: "no_title_or_episode", post_id: postId, meta: { skipped: true, reason: "no_title_or_episode" } };
    } else {
      resultSpotify = await postToWP(FIELD_KEY_SPOTIFY, spUrl, postId, /* skip_if_exists: */ sameSP || !needSpotify);
    }
    if (sameSP && (!pickReason(resultSpotify))) {
      resultSpotify = { ...(resultSpotify||{}), updated: false, skipped_reason: "already_has_value", meta: { ...(resultSpotify&&resultSpotify.meta||{}), skipped: true, reason: "already_has_value" } };
    }

    // ⑤ platforms
    const matched_post_id = postId;
    const platforms = [];

    // Amazon Music
    let amazonPlatform = {
      name: "amazon_music",
      episode_url: needAmazon ? episode_url : existingAmazon,
      updated: pickUpdated(resultAmazon)
    };
    const amazonReason = pickReason(resultAmazon);
    if (amazonReason) amazonPlatform.skipped_reason = amazonReason;
    if (!amazonReason && !pickUpdated(resultAmazon)) amazonPlatform.skipped_reason = "unknown";
    amazonPlatform.coherence = {
      expected: expectedEpisode,
      actual: needAmazon ? amazonActual : null,
      title: needAmazon ? amazonTitle : null,
      matched: (pickReason(resultAmazon) === "already_has_value")
        ? null
        : computeMatched(needAmazon, amazonActual, expectedEpisode, amazonActual)
    };
    platforms.push(amazonPlatform);

    // YouTube
    let ytObj = {
      name: "youtube",
      episode_url: needYouTube ? ytUrl : existingYouTube,
      updated: pickUpdated(resultYouTube)
    };
    const ytReason = pickReason(resultYouTube);
    if (ytReason) ytObj.skipped_reason = ytReason;
    if (!ytReason && !pickUpdated(resultYouTube)) ytObj.skipped_reason = "unknown";
    ytObj.coherence = {
      expected: expectedEpisode,
      actual: needYouTube ? episodeNumFromTitle(ytTitle) : null,
      title: needYouTube ? ytTitle : null,
      matched: (pickReason(resultYouTube) === "already_has_value")
        ? null
        : computeMatched(needYouTube, episodeNumFromTitle(ytTitle), expectedEpisode, amazonActual)
    };
    platforms.push(ytObj);

    // iTunes
    let itObj = {
      name: "itunes",
      episode_url: needItunes ? itUrl : existingItunes,
      updated: pickUpdated(resultItunes)
    };
    const itReason = pickReason(resultItunes);
    if (itReason) itObj.skipped_reason = itReason;
    if (!itReason && !pickUpdated(resultItunes)) itObj.skipped_reason = "unknown";
    itObj.coherence = {
      expected: expectedEpisode,
      actual: needItunes ? episodeNumFromTitle(itTitle) : null,
      title: needItunes ? itTitle : null,
      matched: (pickReason(resultItunes) === "already_has_value")
        ? null
        : computeMatched(needItunes, episodeNumFromTitle(itTitle), expectedEpisode, amazonActual)
    };
    platforms.push(itObj);

    // Spotify
    let spObj = {
      name: "spotify",
      episode_url: needSpotify ? spUrl : existingSpotify,
      updated: pickUpdated(resultSpotify)
    };
    const spReason = pickReason(resultSpotify);
    if (spReason) spObj.skipped_reason = spReason;
    if (!spReason && !pickUpdated(resultSpotify)) spObj.skipped_reason = "unknown";
    spObj.coherence = {
      expected: expectedEpisode,
      actual: needSpotify ? episodeNumFromTitle(spTitle) : null,
      title: needSpotify ? spTitle : null,
      matched: (pickReason(resultSpotify) === "already_has_value")
        ? null
        : computeMatched(needSpotify, episodeNumFromTitle(spTitle), expectedEpisode, amazonActual)
    };
    platforms.push(spObj);

    // ⑥ 出力（デバッグ情報付き）
    finish({
      matched_post_id,
      target_title: targetTitle,
      target_url: targetUrl,
      platforms,
      debug: {
        needAmazon,
        needYouTube,
        needItunes,
        needSpotify,
        existingAmazon: existingAmazon || "(empty)",
        existingYouTube: existingYouTube || "(empty)",
        existingItunes: existingItunes || "(empty)",
        existingSpotify: existingSpotify || "(empty)"
      }
    });
  } catch (e) {
    fail(String(e && e.message ? e.message : e));
  } finally {
    if (browser) await browser.close();
  }
})();