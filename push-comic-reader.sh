#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Branch: comic-reader (1 commit ahead of origin/main)"
git log --oneline origin/main..HEAD

echo ""
echo "Pushing to https://github.com/SnorlaxDeanda/R2-drive ..."
git push -u origin comic-reader

echo ""
echo "Open a pull request:"
echo "  https://github.com/SnorlaxDeanda/R2-drive/compare/main...comic-reader?expand=1"
