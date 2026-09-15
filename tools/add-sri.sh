#!/usr/bin/env bash
# Pin the third-party CDN scripts in index.html with Subresource Integrity hashes.
#
# Why: those libraries run with full access to the page, including the Microsoft Graph
# access token used to read and write your OneDrive quotes. Without SRI, a compromised
# or hijacked CDN can serve different JavaScript and the browser will run it happily.
# With SRI the browser refuses any file whose hash does not match.
#
# Run this once, from a machine with internet access, then commit index.html.
# Re-run it whenever you bump a library version.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f index.html ] || { echo "index.html not found" >&2; exit 1; }

urls=$(grep -o 'src="https://[^"]*\.js"' index.html | sed 's/src="//;s/"$//')
[ -n "$urls" ] || { echo "no CDN script tags found" >&2; exit 1; }

for url in $urls; do
  printf 'hashing %s ... ' "$url"
  hash="sha384-$(curl -fsSL --retry 3 "$url" | openssl dgst -sha384 -binary | openssl base64 -A)"
  echo "$hash"
  python3 - "$url" "$hash" <<'PY'
import io, sys, re
url, h = sys.argv[1], sys.argv[2]
s = io.open('index.html', encoding='utf-8').read()
tag = re.search(r'<script src="%s"[^>]*></script>' % re.escape(url), s)
if not tag:
    sys.exit('could not locate the tag for ' + url)
new = tag.group(0)
new = re.sub(r'\s+integrity="[^"]*"', '', new)               # replace any existing hash
new = new.replace('></script>', ' integrity="%s"></script>' % h)
io.open('index.html', 'w', encoding='utf-8').write(s.replace(tag.group(0), new))
PY
done
echo
echo "Done. Open index.html in a browser and confirm the app still loads before committing:"
echo "a wrong hash blocks the script silently, so verify rather than assume."
