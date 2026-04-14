#!/usr/bin/env bash
set -euo pipefail

# Fetch via pure.md (HTML->Markdown proxy) to bypass flaky direct fetches.
# Usage:
#   ./scripts/run-crab-puremd.sh <url> [--lang zh]

# Default to puremd, but allow overrides.
node ./scripts/add-url.mjs "$@" --via puremd

cat <<'EOF'

Next steps:
  1) Translate the prompt file: content/articles/<slug>/translate.<lang>.prompt.txt
     (output: a markdown file starting with '# <中文标题>' then blank line then body)
  2) Apply:
       node scripts/apply-translation.mjs <slug> --lang <lang> --in /path/to/translated.<lang>.md
  3) Commit + push:
       git add content/articles/<slug>/ && git commit -m "publish: <slug>" && git push
EOF

