#!/usr/bin/env bash
# Tell IndexNow search engines (Bing, Yandex, Seznam, Naver, Yep) that the sitemap URLs changed.
# usage: web/scripts/indexnow.sh   (after a deploy that changed public pages)
set -euo pipefail
KEY=aac76c0b3dc96e6b349aad340287ee4d
URLS=$(curl -s https://seaflooratlas.org/sitemap.xml | grep -o '<loc>[^<]*' | sed 's/<loc>//' | python3 -c 'import json,sys;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
curl -s -o /dev/null -w "IndexNow HTTP %{http_code}\n" -H 'Content-Type: application/json; charset=utf-8' \
  -d "{\"host\":\"seaflooratlas.org\",\"key\":\"$KEY\",\"keyLocation\":\"https://seaflooratlas.org/$KEY.txt\",\"urlList\":$URLS}" \
  https://api.indexnow.org/indexnow
