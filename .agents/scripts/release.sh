#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode=dry-run
tag=''
expected_head=''
repository=''
timeout=180

die() { printf 'release: %s\n' "$*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) mode=dry-run; shift ;;
    --execute) mode=execute; shift ;;
    --verify-only) mode=verify-only; shift ;;
    --tag) tag="$2"; shift 2 ;;
    --expected-head) expected_head="$2"; shift 2 ;;
    --repository) repository="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] || die 'invalid expected head'
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'invalid repository'
cd "$repo_root"
plan="$(node scripts/release-package.ts plan --tag "$tag" --format json)" || die 'tag does not select a releasable workspace'
package_name="$(jq -r .package_name <<<"$plan")"
version="$(jq -r .version <<<"$plan")"
[[ -z "$(git status --porcelain=v1)" ]] || die 'release requires a clean checkout'
[[ "$(git branch --show-current)" == main ]] || die 'release must run from main'
[[ "$(git rev-parse HEAD)" == "$expected_head" ]] || die 'HEAD is not expected release head'
git fetch --quiet --no-tags origin main
[[ "$(git rev-parse origin/main)" == "$expected_head" ]] || die 'origin/main is not expected release head'

temporary_root="$(mktemp -d /tmp/dsh-plugins-release.XXXXXX)"
trap '/usr/bin/find "$temporary_root" -depth -delete' EXIT INT TERM
gh api --paginate --slurp "repos/$repository/commits/$expected_head/pulls" | jq 'add' > "$temporary_root/associations.json"
pull_request="$(node scripts/check-reviewed-release-source.ts --repository "$repository" --commit "$expected_head" --associations "$temporary_root/associations.json")"
gh api --paginate --slurp "repos/$repository/issues/$pull_request/comments" | jq 'add' > "$temporary_root/comments.json"
printf '{}\n' > "$temporary_root/reviewers.json"
jq -r '.[] | select(.body | contains("forge-cli:review-state:v1")) | .user.login' "$temporary_root/comments.json" | sort -u | while IFS= read -r login; do
  permission="$(gh api "repos/$repository/collaborators/$login/permission" --jq '.permission')"
  jq --arg login "$login" --arg permission "$permission" '. + {($login): $permission}' "$temporary_root/reviewers.json" > "$temporary_root/reviewers.next.json"
  mv "$temporary_root/reviewers.next.json" "$temporary_root/reviewers.json"
done
review="$(node scripts/check-reviewed-release-source.ts --repository "$repository" --commit "$expected_head" --associations "$temporary_root/associations.json" --comments "$temporary_root/comments.json" --reviewers "$temporary_root/reviewers.json")"
remote_refs="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")"

if [[ "$mode" == verify-only ]]; then
  [[ -n "$remote_refs" ]] || die 'remote tag is missing'
  release_json="$(gh release view "$tag" --repo "$repository" --json tagName,url,assets)" || die 'release is missing'
  jq -e --arg tag "$tag" '.tagName == $tag and ([.assets[].name] | index("SHA256SUMS") != null) and ([.assets[].name] | index("release-lock.json") != null)' <<<"$release_json" >/dev/null || die 'release assets are incomplete'
  published="$(npm view "$package_name@$version" version --json --registry=https://registry.npmjs.org/)" || die 'npm package version is missing'
  [[ "$(jq -r . <<<"$published")" == "$version" ]] || die 'npm registry version mismatch'
  printf 'status=published\ntag=%s\npackage=%s\nversion=%s\ncommit=%s\nreview=%s\nrelease_url=%s\n' "$tag" "$package_name" "$version" "$expected_head" "$review" "$(jq -r .url <<<"$release_json")"
  exit 0
fi
[[ -z "$remote_refs" ]] || die 'immutable tag already exists'
if [[ "$mode" == dry-run ]]; then
  printf 'status=ready\ntag=%s\npackage=%s\nversion=%s\ncommit=%s\nreview=%s\n' "$tag" "$package_name" "$version" "$expected_head" "$review"
  exit 0
fi
git tag -s "$tag" "$expected_head" -m "$package_name $version"
git verify-tag "$tag" >/dev/null 2>&1 || die 'tag signature verification failed'
git push origin "refs/tags/$tag:refs/tags/$tag"
started="$(date +%s)"
run_id=''
until [[ -n "$run_id" ]]; do
  run_id="$(gh run list --repo "$repository" --workflow release.yml --event push --branch "$tag" --limit 20 --json databaseId,headSha --jq ".[] | select(.headSha == \"$expected_head\") | .databaseId" | sed -n '1p')"
  (( $(date +%s) - started < timeout )) || die 'release workflow did not appear in time'
  [[ -n "$run_id" ]] || sleep 5
done
gh run watch "$run_id" --repo "$repository" --exit-status
"$0" --verify-only --tag "$tag" --expected-head "$expected_head" --repository "$repository"
