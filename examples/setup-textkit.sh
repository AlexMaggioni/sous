#!/bin/sh
# Copies the textkit example to a folder of its own and makes it a git repo, so the ticket
# workflow can branch from it. Usage: examples/setup-textkit.sh <target folder>
set -eu
target=${1:?usage: setup-textkit.sh <target folder>}
here=$(cd "$(dirname "$0")" && pwd)
if [ -e "$target" ]; then
  echo "$target already exists" >&2
  exit 1
fi
cp -R "$here/textkit" "$target"
cd "$target"
git init -q -b main
git add -A
git -c user.name=textkit -c user.email=textkit@example.com commit -q -m "textkit"
echo "textkit is ready in $target"
