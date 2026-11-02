#!/bin/sh
# Builds the npm tarball and Claude Desktop bundle into release/.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cd "$root"
rm -rf release
mkdir release
npm ci
npm test
npm pack --pack-destination release

cp -R dist manifest.json package.json package-lock.json README.md LICENSE "$stage"
(cd "$stage" && npm ci --omit=dev --ignore-scripts)
npx --yes @anthropic-ai/mcpb@2.1.2 validate "$stage/manifest.json"
npx --yes @anthropic-ai/mcpb@2.1.2 pack "$stage" "release/moodle-mcp-$(node -p "require('./package.json').version").mcpb"
ls -l release
