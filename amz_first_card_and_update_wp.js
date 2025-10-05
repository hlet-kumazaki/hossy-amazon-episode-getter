name: Fetch and Update

on:
  workflow_dispatch:

jobs:
  fetch_and_update:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3

      - name: Prepare email content
        id: prepare_email
        run: |
          RES=$(cat result.json)
          if ! echo "$RES" | jq empty; then
            echo "Invalid JSON in result.json"
            exit 1
          fi

          STATUS_TXT=$(echo "$RES" | jq -r '.matched_post_id // "不明"')
          TARGET_TITLE=$(echo "$RES" | jq -r '.target_title // "不明"')
          TARGET_URL=$(echo "$RES" | jq -r '.target_url // "不明"')

          SUBJECT="エピソードURL更新通知 — ${STATUS_TXT} / ${TARGET_TITLE}"

          # JST current timestamp for "更新日時：YYYY / mm / dd H:i"
          JST_NOW=$(TZ=Asia/Tokyo date '+%Y / %m / %d %H:%M')

          # Build platform sections in fixed order with human-readable labels
          PLAT_SECTIONS=$(
            echo "$RES" | jq -r '
              def pick($name; $label):
                # 既存platformを取得（なければ {} ）
                ( first(.platforms[]? | select(.name==$name)) // {} ) as $p
                | {
                    label:  $label,
                    sym:    ( if ($p.coherence.matched // false) then "✅" else "❌" end ),
                    url:    ( $p.episode_url // "" ),
                    reason: (
                      $p.skipped_reason
                      // $p.reason
                      // $p.meta?.reason
                      // $p.meta?.skipped_reason
                      // "（理由情報なし / PFデータ未取得）"
                    )
                  };
              [
                pick("amazon_music"; "Amazon Music"),
                pick("youtube";      "YouTube Music"),
                pick("itunes";       "Apple Podcasts"),
                pick("spotify";      "Spotify")
              ]
              | .[]
              | "◯\(.label)\n- 整合性チェック：\(.sym)\n- URL：\(.url // "（未取得）")\n- 取得ログ：\(.reason // "（理由情報なし / PFデータ未取得）")\n"
            '
          )

          {
            echo "エピソードURL更新通知を更新しました。"
            echo
            echo "更新日時：${JST_NOW}"
            echo "対象ページ：${TARGET_TITLE}"
            echo "${TARGET_URL}"
            echo
            printf "%s\n" "$PLAT_SECTIONS"
          } > email_body.txt

          {
            echo "subject<<EOF"
            printf '%s\n' "$SUBJECT"
            echo "EOF"
          } >> "$GITHUB_OUTPUT"
          {
            echo "body<<EOF"
            cat email_body.txt
            echo "EOF"
          } >> "$GITHUB_OUTPUT"