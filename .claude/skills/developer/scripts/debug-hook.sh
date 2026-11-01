#!/bin/bash
# Adds (on) or removes (off) `window.__city = city` in src/main.ts, marked `// DEBUG-REMOVE`,
# so Playwright scripts can reach the scene (camera, data, traffic). Never commit it.
cd "$(git rev-parse --show-toplevel)"
sed -i '/DEBUG-REMOVE/d' src/main.ts
if [ "$1" = "on" ]; then
  sed -i "s/    city ??= new CityScene(\$('canvas'), \$('labels'));/    city ??= new CityScene(\$('canvas'), \$('labels'));\n    (window as unknown as { __city: unknown }).__city = city; \/\/ DEBUG-REMOVE/" src/main.ts
fi
grep -c DEBUG-REMOVE src/main.ts || true
