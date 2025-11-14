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

function pickUpdatedFromMeta(obj) {
  const meta = (obj && obj.meta) || {};
  if (typeof (obj && obj.updated) === 'boolean') return obj.updated;
  if (typeof meta.updated === 'boolean') return meta.updated;
  if (typeof meta.skipped === 'boolean') return meta.skipped === false;
  return false;
}

function pickReasonFromMeta(obj) {
  const meta = (obj && obj.meta) || {};
  return (
    (obj && (obj.reason || obj.skipped_reason)) ||
    meta.reason ||
    meta.skipped_reason ||
    null
  );
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

  const meta = (json && json.meta) || {};

  const ok = res.ok && json.ok !== false;
  const updated = pickUpdatedFromMeta(json);
  const skipped = typeof meta.skipped === 'boolean' ? meta.skipped : !!json.skipped;
  let reason = pickReasonFromMeta(json);

  if (!ok && !reason) {
    reason = 'update_failed';
  }

  return {
    ok,
    updated,
    skipped,
    reason,
    meta,
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

// 共通化: fetch → 整合性チェック → 保存
async function fetchAndUpdatePlatform({ need, existingUrl, fetchLatest, fieldKey, expectedEpisode }) {
  let data = { url: existingUrl, title: null, episodeNum: null, error: null };
  let metaResult = {
    updated: false,
    skipped: !need,
    reason: need ? null : 'already_has_value',
  };

  if (need) {
    data = await fetchLatest();

    // 一度ここで話数の整合性を判定し、不一致なら保存処理自体をスキップする
    const provisionalMatched = computeMatched(
      true,
      expectedEpisode,
      data.episodeNum
    );

    if (provisionalMatched === false) {
      metaResult.updated = false;
      metaResult.skipped = true;
      metaResult.reason = 'coherence_mismatch';
    } else if (data.url && fieldKey) {
      metaResult = await postMeta({
        field: fieldKey,
        value: data.url,
        isAcf: true,
        skipIfExists: false,
      });
    } else if (data.error) {
      metaResult.reason = data.error;
    }
  }

  const matched = computeMatched(need, expectedEpisode, data.episodeNum);

  return { data, metaResult, matched };
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

    // 公開日ベースで「新しいエピソードが公開されていない可能性」を判定する
    // 優先して GMT 系フィールドを使い、なければローカル日時を JST とみなして UTC に変換
    const publishDateGmt = latest.post_date_gmt || latest.date_gmt || null;
    const publishDateLocal = latest.post_date || latest.date || null;

    let publishUtcMs = null;
    if (publishDateGmt) {
      const d = new Date(publishDateGmt);
      if (!isNaN(d)) {
        publishUtcMs = d.getTime();
      }
    } else if (publishDateLocal) {
      const d = new Date(publishDateLocal);
      if (!isNaN(d)) {
        // ローカル日時は JST 相当とみなし、UTC に変換
        publishUtcMs = d.getTime() - 9 * 60 * 60 * 1000;
      }
    }

    // 現在時刻から「プログラム開始した日の JST 06:00」を UTC ミリ秒で算出
    const nowUtc = new Date();
    const nowJst = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
    const jstYear = nowJst.getUTCFullYear();
    const jstMonth = nowJst.getUTCMonth();
    const jstDate = nowJst.getUTCDate();
    // JST 06:00 は UTC では前日の 21:00 だが、UTC ミリ秒としては下記で算出
    const thresholdUtcMs = Date.UTC(jstYear, jstMonth, jstDate, 6 - 9, 0, 0, 0);

    const warnNoNewEpisode =
      publishUtcMs != null && publishUtcMs < thresholdUtcMs;

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
    let amazonData;
    let amazonMetaResult;
    let amazonMatched;
    {
      const r = await fetchAndUpdatePlatform({
        need: needAmazon,
        existingUrl: existingAmazon,
        fetchLatest: () => fetchAmazonLatest(context),
        fieldKey: FIELD_KEY_AMAZON,
        30
        //expectedEpisode,
      });
      amazonData = r.data;
      amazonMetaResult = r.metaResult;
      amazonMatched = r.matched;
    }

    const amazonPlatform = {
      name: 'amazon_music',
      // 既存URLがある場合はスキップ扱いとし、URLは表示しない（null）
      episode_url: needAmazon ? (amazonData.url || null) : null,
      // 判定は話数の整合性 + URL の有効性で行う
      updated: needAmazon && amazonMatched !== false && isValidUrl(amazonData.url),
      skipped_reason: !needAmazon
        ? 'already_has_value'
        : (amazonMatched === false
            ? 'coherence_mismatch'
            : (!isValidUrl(amazonData.url) && amazonData.error
                ? amazonData.error
                : (!isValidUrl(amazonData.url) ? 'fetch_failed' : null))),
      coherence: {
        expected: expectedEpisode,
        actual: needAmazon ? amazonData.episodeNum : null,
        title: needAmazon ? amazonData.title : null,
        matched: amazonMatched,
      },
    };

    // YouTube
    let ytData;
    let ytMetaResult;
    let ytMatched;
    {
      const r = await fetchAndUpdatePlatform({
        need: needYouTube,
        existingUrl: existingYouTube,
        fetchLatest: () => fetchYouTubeLatest(),
        fieldKey: FIELD_KEY_YOUTUBE,
        expectedEpisode,
      });
      ytData = r.data;
      ytMetaResult = r.metaResult;
      ytMatched = r.matched;
    }

    const ytPlatform = {
      name: 'youtube',
      episode_url: needYouTube ? (ytData.url || null) : null,
      updated: needYouTube && ytMatched !== false && isValidUrl(ytData.url),
      skipped_reason: !needYouTube
        ? 'already_has_value'
        : (ytMatched === false
            ? 'coherence_mismatch'
            : (!isValidUrl(ytData.url) && ytData.error
                ? ytData.error
                : (!isValidUrl(ytData.url) ? 'fetch_failed' : null))),
      coherence: {
        expected: expectedEpisode,
        actual: needYouTube ? ytData.episodeNum : null,
        title: needYouTube ? ytData.title : null,
        matched: ytMatched,
      },
    };

    // iTunes
    let itData;
    let itMetaResult;
    let itMatched;
    {
      const r = await fetchAndUpdatePlatform({
        need: needItunes,
        existingUrl: existingItunes,
        fetchLatest: () => fetchItunesLatest(),
        fieldKey: FIELD_KEY_ITUNES,
        expectedEpisode,
      });
      itData = r.data;
      itMetaResult = r.metaResult;
      itMatched = r.matched;
    }

    const itPlatform = {
      name: 'itunes',
      episode_url: needItunes ? (itData.url || null) : null,
      updated: needItunes && itMatched !== false && isValidUrl(itData.url),
      skipped_reason: !needItunes
        ? 'already_has_value'
        : (itMatched === false
            ? 'coherence_mismatch'
            : (!isValidUrl(itData.url) && itData.error
                ? itData.error
                : (!isValidUrl(itData.url) ? 'fetch_failed' : null))),
      coherence: {
        expected: expectedEpisode,
        actual: needItunes ? itData.episodeNum : null,
        title: needItunes ? itData.title : null,
        matched: itMatched,
      },
    };

    // Spotify
    let spData;
    let spMetaResult;
    let spMatched;
    {
      const r = await fetchAndUpdatePlatform({
        need: needSpotify,
        existingUrl: existingSpotify,
        fetchLatest: () => fetchSpotifyLatest(context),
        fieldKey: FIELD_KEY_SPOTIFY,
        expectedEpisode,
      });
      spData = r.data;
      spMetaResult = r.metaResult;
      spMatched = r.matched;
    }

    const spPlatform = {
      name: 'spotify',
      episode_url: needSpotify ? (spData.url || null) : null,
      updated: needSpotify && spMatched !== false && isValidUrl(spData.url),
      skipped_reason: !needSpotify
        ? 'already_has_value'
        : (spMatched === false
            ? 'coherence_mismatch'
            : (!isValidUrl(spData.url) && spData.error
                ? spData.error
                : (!isValidUrl(spData.url) ? 'fetch_failed' : null))),
      coherence: {
        expected: expectedEpisode,
        actual: needSpotify ? spData.episodeNum : null,
        title: needSpotify ? spData.title : null,
        matched: spMatched,
      },
    };

    // すべての更新処理が終わったあとに、実際に保存されたURLを再取得して最終結果を補正
    const latestAfter = await getJson(
      `${LATEST_ENDPOINT}?t=${Date.now().toString()}&phase=after`
    );
    const fieldsAfter = latestAfter.fields || {};
    const finalAmazon = pickExistingUrl(fieldsAfter, META_KEY_AMAZON);
    const finalYouTube = pickExistingUrl(fieldsAfter, META_KEY_YOUTUBE);
    const finalItunes = pickExistingUrl(fieldsAfter, META_KEY_ITUNES);
    const finalSpotify = pickExistingUrl(fieldsAfter, META_KEY_SPOTIFY);

    if (needAmazon && amazonMatched !== false && isValidUrl(finalAmazon)) {
      amazonPlatform.episode_url = finalAmazon;
      amazonPlatform.updated = true;
      amazonPlatform.skipped_reason = null;
    }

    if (needYouTube && ytMatched !== false && isValidUrl(finalYouTube)) {
      ytPlatform.episode_url = finalYouTube;
      ytPlatform.updated = true;
      ytPlatform.skipped_reason = null;
    }

    if (needItunes && itMatched !== false && isValidUrl(finalItunes)) {
      itPlatform.episode_url = finalItunes;
      itPlatform.updated = true;
      itPlatform.skipped_reason = null;
    }

    if (needSpotify && spMatched !== false && isValidUrl(finalSpotify)) {
      spPlatform.episode_url = finalSpotify;
      spPlatform.updated = true;
      spPlatform.skipped_reason = null;
    }

    const resultJson = {
      matched_post_id: postId,
      target_title: targetTitle,
      target_url: targetUrl,
      warn_no_new_episode: warnNoNewEpisode,
      publish_date_gmt: publishDateGmt || null,
      publish_date_local: publishDateLocal || null,
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
        finalAmazon,
        finalYouTube,
        finalItunes,
        finalSpotify,
        publishDateGmt,
        publishDateLocal,
        publishUtcMs,
        thresholdUtcMs,
        warnNoNewEpisode,
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