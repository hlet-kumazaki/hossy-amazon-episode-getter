// amz_first_card_and_update_wp.cjs
// 各PFのURLを「未登録ならだけ」自動取得して ACF に保存するスクリプト
// 依存: Node 18+（fetch）, Playwright

const { chromium } = require('playwright');

const LATEST_ENDPOINT =
  process.env.LATEST_ENDPOINT || 'https://hossy.org/wp-json/agent/v1/latest';
const META_ENDPOINT =
  process.env.META_ENDPOINT || 'https://hossy.org/wp-json/agent/v1/meta';

const WP_USER = process.env.WP_USER;
const WP_PASS = process.env.WP_PASS;

// Amazon
const AMAZON_CHANNEL_URL = 'https://music.amazon.co.jp/podcasts/e5b6823d-8e80-425f-8935-83bf019b8931/%E3%83%AA%E3%82%A2%E3%83%AB%E7%B5%8C%E5%96%B6%EF%BD%9C%E7%AD%89%E8%BA%AB%E5%A4%A7%E3%81%A7%E8%AA%9E%E3%82%8B%E5%8F%B0%E6%9C%AC%E3%81%AA%E3%81%8D%E7%A4%BE%E9%95%B7%E3%81%AE%E3%83%AA%E3%82%A2%E3%83%AB'; // Amazon Music の番組URL
const META_KEY_AMAZON  = 'amazon_podcast';        // ACF フィールド名 (meta_key)
const FIELD_KEY_AMAZON = 'field_680d867a57991';   // ACF field_key
// YouTube
const YT_FEED_URL =
  'https://www.youtube.com/feeds/videos.xml?channel_id=UC4vypjnhxhnyGERcqRGv5nA'; // Real Management Podcast YouTube channel feed
const META_KEY_YOUTUBE  = 'youtube_podcast';      // ACF フィールド名 (meta_key)
const FIELD_KEY_YOUTUBE = 'field_680bf82a6b5c0';  // ACF field_key
// Apple Podcasts
const ITUNES_LOOKUP_URL =
  'https://itunes.apple.com/lookup?id=1810690058&entity=podcastEpisode';
const META_KEY_ITUNES  = 'apple_podcast';         // ACF フィールド名 (meta_key)
const FIELD_KEY_ITUNES = 'field_680bf86a6b5c2';   // ACF field_key
// Spotify
const SPOTIFY_SHOW_URL =
  'https://open.spotify.com/show/1F9Wl0HZBxkHsVToJhpyQl'; // Real Management Podcast show URL
const META_KEY_SPOTIFY  = 'spotify_podcast';      // ACF フィールド名 (meta_key)
const FIELD_KEY_SPOTIFY = 'field_680bf85c6b5c1';  // ACF field_key


// ----------------------------------------------------------------------------
// 共通ヘルパ
// ----------------------------------------------------------------------------

function basicAuthHeader() {
  if (!WP_USER || !WP_PASS) {
    throw new Error('WP_USER / WP_PASS が設定されていません');
  }
  const token = Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
  return 'Basic ' + token;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status}`);
  }
  return res.json();
}

async function postMeta({ field, value, isAcf = true, skipIfExists = true }) {
  const body = {
    field,
    value,
    is_acf: !!isAcf,
    skip_if_exists: !!skipIfExists,
  };

  const res = await fetch(META_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      Authorization: basicAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      updated: false,
      skipped: false,
      reason: 'invalid_json',
      raw: text,
    };
  }

  if (!res.ok || json.ok === false) {
    return {
      ok: false,
      updated: false,
      skipped: !!json.skipped,
      reason: json.reason || 'update_failed',
      meta: json.meta || null,
    };
  }

  return {
    ok: true,
    updated: !!json.updated,
    skipped: !!json.skipped,
    reason: json.reason || null,
    meta: json.meta || null,
  };
}

function pickExistingUrl(fields, key) {
  if (!fields || typeof fields !== 'object') return '';
  const v = fields[key];
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v.url === 'string') return v.url.trim();
  if (typeof v.value === 'string') return v.value.trim();
  return '';
}

function isValidUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function episodeNumFromTitle(title) {
  if (!title || typeof title !== 'string') return null;
  // 例: "Episode 28｜..." "エピソード28" などから数値抜き出し
  const m = title.match(/(?:Episode|エピソード)[^\d]*(\d+)/i);
  if (m) return Number(m[1]);
  // 後ろの「28｜」だけ拾う保険
  const m2 = title.match(/(\d+)[^\d]*$/);
  if (m2) return Number(m2[1]);
  return null;
}

function episodeNumFromUrl(u) {
  if (!u || typeof u !== 'string') return null;
  const m = u.match(/episode[-/](\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

function computeMatched(need, expected, actual) {
  if (!need) return null; // 既存URLあり → "--"
  if (expected == null || actual == null) return null; // 判定不能 → "--"
  return actual === expected;
}

// ----------------------------------------------------------------------------
// 各PF取得
// ----------------------------------------------------------------------------

async function fetchAmazonLatest(context) {
  if (!AMAZON_CHANNEL_URL) {
    return { url: null, title: null, episodeNum: null, error: 'no_channel_url' };
  }

  const page = await context.newPage();
  try {
    await page.goto(AMAZON_CHANNEL_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });

    // 旧コードと同様に networkidle まで待機
    await page.waitForLoadState('networkidle', { timeout: 60000 });

    // 最終URLをデバッグ出力（リダイレクト有無の確認用）
    console.error('[AMZ] goto url =', AMAZON_CHANNEL_URL);
    console.error('[AMZ] final url =', page.url());

    // 旧コード同様、エピソード要素の出現を明示的に待つ
    const selector = 'music-episode-row-item';
    try {
      await page.waitForSelector(selector, { timeout: 60000 });
    } catch (e) {
      // セレクタが一定時間出てこなかった場合はここで終了
      return { url: null, title: null, episodeNum: null, error: 'no_episode_item' };
    }

    const item = page.locator(selector).first();
    if (!(await item.count())) {
      return { url: null, title: null, episodeNum: null, error: 'no_episode_item' };
    }

    let href = await item.getAttribute('primary-href');
    if (!href) {
      const link = item.locator('a[href*="/episodes/"]').first();
      if (await link.count()) href = await link.getAttribute('href');
    }
    if (!href) {
      return { url: null, title: null, episodeNum: null, error: 'no_href' };
    }
    if (href.startsWith('/')) {
      const { origin } = new URL(AMAZON_CHANNEL_URL);
      href = origin + href;
    }

    // タイトル推測
    let title = null;
    const attrTitle = await item.getAttribute('primary-text');
    if (attrTitle && attrTitle.trim()) title = attrTitle.trim();

    if (!title) {
      const titleNode = item
        .locator('[slot="title"], .title, [data-testid="title"]')
        .first();
      if (await titleNode.count()) {
        const t = (await titleNode.innerText()).trim();
        if (t) title = t;
      }
    }

    if (!title) {
      const raw = await item.evaluate(el => (el.textContent || '').trim());
      if (raw) {
        title = raw
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)[0];
      }
    }

    const episodeNum = episodeNumFromTitle(title) ?? episodeNumFromUrl(href);

    return { url: href, title, episodeNum, error: null };
  } finally {
    await page.close();
  }
}

async function fetchYouTubeLatest() {
  if (!YT_FEED_URL) {
    return { url: null, title: null, episodeNum: null, error: 'no_feed_url' };
  }
  const res = await fetch(YT_FEED_URL);
  if (!res.ok) {
    return {
      url: null,
      title: null,
      episodeNum: null,
      error: `http_${res.status}`,
    };
  }
  const xml = await res.text();
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/i);
  if (!entryMatch) {
    return { url: null, title: null, episodeNum: null, error: 'no_entry' };
  }
  const entry = entryMatch[0];
  const linkMatch = entry.match(
    /<link[^>]*href=\"([^\"]+)\"[^>]*rel=\"alternate\"/i
  );
  const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const url = linkMatch ? linkMatch[1] : null;
  const rawTitle = titleMatch ? titleMatch[1] : null;
  const title = rawTitle ? rawTitle.replace(/\s+/g, ' ').trim() : null;
  const episodeNum = episodeNumFromTitle(title) ?? episodeNumFromUrl(url);

  return { url, title, episodeNum, error: null };
}

async function fetchItunesLatest() {
  const res = await fetch(ITUNES_LOOKUP_URL);
  if (!res.ok) {
    return {
      url: null,
      title: null,
      episodeNum: null,
      error: `http_${res.status}`,
    };
  }
  const json = await res.json();
  const results = json.results || [];
  const ep = results.find(r => r.wrapperType === 'podcastEpisode') || results[1];
  if (!ep) {
    return { url: null, title: null, episodeNum: null, error: 'no_episode' };
  }
  const url = ep.trackViewUrl || null;
  const title = ep.trackName || ep.collectionName || null;
  const episodeNum = episodeNumFromTitle(title) ?? episodeNumFromUrl(url);
  return { url, title, episodeNum, error: null };
}

async function fetchSpotifyLatest(context) {
  if (!SPOTIFY_SHOW_URL) {
    return { url: null, title: null, episodeNum: null, error: 'no_show_url' };
  }

  const page = await context.newPage();
  try {
    await page.goto(SPOTIFY_SHOW_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForLoadState('networkidle', { timeout: 60000 });

    const firstEp = page.locator('a[href*="/episode/"]').first();
    if (!(await firstEp.count())) {
      return { url: null, title: null, episodeNum: null, error: 'no_episode_link' };
    }

    const href = await firstEp.getAttribute('href');
    const { origin } = new URL(SPOTIFY_SHOW_URL);
    const url = href.startsWith('http') ? href : origin + href;

    const container = firstEp.locator('xpath=ancestor-or-self::*[1]');
    const rawText = (await container.innerText()).trim();
    const title = rawText.split('\n').filter(Boolean)[0] || rawText;
    const episodeNum = episodeNumFromTitle(title) ?? episodeNumFromUrl(url);

    return { url, title, episodeNum, error: null };
  } finally {
    await page.close();
  }
}

// ----------------------------------------------------------------------------
// メイン
// ----------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  });

  try {
    // 1) 最新投稿 & 既存フィールド取得
    const latest = await getJson(
      `${LATEST_ENDPOINT}?t=${Date.now().toString()}`
    );
    if (!latest.ok) throw new Error('latest endpoint error');

    const postId = latest.post_id;
    const targetTitle = latest.title;
    const targetUrl = latest.url;
    const fields = latest.fields || {};
    const expectedEpisode =
      process.env.EXPECTED_EPISODE != null
        ? Number(process.env.EXPECTED_EPISODE)
        : (typeof latest.episode_num === 'number' ? latest.episode_num : null);

    // 既存URL
    const existingAmazon = pickExistingUrl(fields, META_KEY_AMAZON);
    const existingYouTube = pickExistingUrl(fields, META_KEY_YOUTUBE);
    const existingItunes = pickExistingUrl(fields, META_KEY_ITUNES);
    const existingSpotify = pickExistingUrl(fields, META_KEY_SPOTIFY);

    const needAmazon = !isValidUrl(existingAmazon);
    const needYouTube = !isValidUrl(existingYouTube);
    const needItunes = !isValidUrl(existingItunes);
    const needSpotify = !isValidUrl(existingSpotify);

    // Amazon
    let amazonData = { url: existingAmazon, title: null, episodeNum: null, error: null };
    let amazonMetaResult = {
      updated: false,
      skipped: !needAmazon,
      reason: needAmazon ? null : 'already_has_value',
    };

    if (needAmazon) {
      amazonData = await fetchAmazonLatest(context);

      if (amazonData.url && FIELD_KEY_AMAZON) {
        // URL が取得できた場合のみ /meta に保存を試みる
        amazonMetaResult = await postMeta({
          field: FIELD_KEY_AMAZON,
          value: amazonData.url,
          isAcf: true,
          skipIfExists: false,
        });
      } else if (amazonData.error) {
        // URL が取れなかった場合は fetch 側のエラー内容を reason に反映しておく
        amazonMetaResult.reason = amazonData.error;
      }
    }

    const amazonMatched = computeMatched(
      needAmazon,
      expectedEpisode,
      amazonData.episodeNum
    );

    const amazonPlatform = {
      name: 'amazon_music',
      episode_url: needAmazon ? (amazonData.url || existingAmazon || null) : null,
      updated: !!amazonMetaResult.updated,
      skipped_reason: amazonMetaResult.skipped
        ? (amazonMetaResult.reason || 'already_has_value')
        : (!amazonMetaResult.updated && amazonMetaResult.reason
            ? amazonMetaResult.reason
            : null),
      coherence: {
        expected: expectedEpisode,
        actual: needAmazon ? amazonData.episodeNum : null,
        title: needAmazon ? amazonData.title : null,
        matched: amazonMatched,
      },
    };

    // YouTube
    let ytData = { url: existingYouTube, title: null, episodeNum: null, error: null };
    let ytMetaResult = {
      updated: false,
      skipped: !needYouTube,
      reason: needYouTube ? null : 'already_has_value',
    };

    if (needYouTube) {
      ytData = await fetchYouTubeLatest();
      if (ytData.url && FIELD_KEY_YOUTUBE) {
        ytMetaResult = await postMeta({
          field: FIELD_KEY_YOUTUBE,
          value: ytData.url,
          isAcf: true,
          skipIfExists: false,
        });
      }
    }

    const ytMatched = computeMatched(
      needYouTube,
      expectedEpisode,
      ytData.episodeNum
    );

    const ytPlatform = {
      name: 'youtube',
      episode_url: needYouTube ? (ytData.url || existingYouTube || null) : null,
      updated: !!ytMetaResult.updated,
      skipped_reason: ytMetaResult.skipped
        ? (ytMetaResult.reason || 'already_has_value')
        : (!ytMetaResult.updated && ytMetaResult.reason
            ? ytMetaResult.reason
            : null),
      coherence: {
        expected: expectedEpisode,
        actual: needYouTube ? ytData.episodeNum : null,
        title: needYouTube ? ytData.title : null,
        matched: ytMatched,
      },
    };

    // iTunes
    let itData = { url: existingItunes, title: null, episodeNum: null, error: null };
    let itMetaResult = {
      updated: false,
      skipped: !needItunes,
      reason: needItunes ? null : 'already_has_value',
    };

    if (needItunes) {
      itData = await fetchItunesLatest();
      if (itData.url && FIELD_KEY_ITUNES) {
        itMetaResult = await postMeta({
          field: FIELD_KEY_ITUNES,
          value: itData.url,
          isAcf: true,
          skipIfExists: false,
        });
      }
    }

    const itMatched = computeMatched(
      needItunes,
      expectedEpisode,
      itData.episodeNum
    );

    const itPlatform = {
      name: 'itunes',
      episode_url: needItunes ? (itData.url || existingItunes || null) : null,
      updated: !!itMetaResult.updated,
      skipped_reason: itMetaResult.skipped
        ? (itMetaResult.reason || 'already_has_value')
        : (!itMetaResult.updated && itMetaResult.reason
            ? itMetaResult.reason
            : null),
      coherence: {
        expected: expectedEpisode,
        actual: needItunes ? itData.episodeNum : null,
        title: needItunes ? itData.title : null,
        matched: itMatched,
      },
    };

    // Spotify
    let spData = { url: existingSpotify, title: null, episodeNum: null, error: null };
    let spMetaResult = {
      updated: false,
      skipped: !needSpotify,
      reason: needSpotify ? null : 'already_has_value',
    };

    if (needSpotify) {
      spData = await fetchSpotifyLatest(context);
      if (spData.url && FIELD_KEY_SPOTIFY) {
        spMetaResult = await postMeta({
          field: FIELD_KEY_SPOTIFY,
          value: spData.url,
          isAcf: true,
          skipIfExists: false,
        });
      }
    }

    const spMatched = computeMatched(
      needSpotify,
      expectedEpisode,
      spData.episodeNum
    );

    const spPlatform = {
      name: 'spotify',
      episode_url: needSpotify ? (spData.url || existingSpotify || null) : null,
      updated: !!spMetaResult.updated,
      skipped_reason: spMetaResult.skipped
        ? (spMetaResult.reason || 'already_has_value')
        : (!spMetaResult.updated && spMetaResult.reason
            ? spMetaResult.reason
            : null),
      coherence: {
        expected: expectedEpisode,
        actual: needSpotify ? spData.episodeNum : null,
        title: needSpotify ? spData.title : null,
        matched: spMatched,
      },
    };

    const resultJson = {
      matched_post_id: postId,
      target_title: targetTitle,
      target_url: targetUrl,
      platforms: [amazonPlatform, ytPlatform, itPlatform, spPlatform],
      debug: {
        expectedEpisode,
        needAmazon,
        needYouTube,
        needItunes,
        needSpotify,
        existingAmazon,
        existingYouTube,
        existingItunes,
        existingSpotify,
        amazonData,
        ytData,
        itData,
        spData,
        amazonMetaResult,
        ytMetaResult,
        itMetaResult,
        spMetaResult,
        // 追加デバッグ
        fieldsKeys: Object.keys(fields),
        rawAmazonField: fields[META_KEY_AMAZON],
        rawYouTubeField: fields[META_KEY_YOUTUBE],
        rawItunesField: fields[META_KEY_ITUNES],
        rawSpotifyField: fields[META_KEY_SPOTIFY],
      },
    };

    // GitHub Actions のメール整形側が読む前提の JSON 出力
    console.log(JSON.stringify(resultJson, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});