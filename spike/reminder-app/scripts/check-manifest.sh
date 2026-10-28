#!/usr/bin/env bash
# D-073 / D-074: the merged Android manifest must not request USE_EXACT_ALARM or
# REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, and must request SCHEDULE_EXACT_ALARM.
# Run after `npx expo prebuild -p android` and `./gradlew :app:processReleaseMainManifest`.
# Phase 1 turns this into the CI check for apps/mobile.
set -euo pipefail
cd "$(dirname "$0")/.."

manifest=$(find android/app/build/intermediates -path '*release*' -name AndroidManifest.xml \
  \( -path '*merged_manifest*' -o -path '*packaged_manifests*' \) | head -1)
if [[ -z "${manifest}" ]]; then
  echo "No merged release manifest found. Run the Gradle manifest task first." >&2
  exit 2
fi
echo "Checking ${manifest}"

# Requested permissions only: entries marked tools:node="remove" are gone after merge.
requested=$(grep -o '<uses-permission[^>]*android:name="[^"]*"' "${manifest}" | sed 's/.*android:name="\([^"]*\)"/\1/' | sort -u)
echo "${requested}"

fail=0
for forbidden in android.permission.USE_EXACT_ALARM android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS; do
  if grep -qx "${forbidden}" <<<"${requested}"; then
    echo "FAIL: ${forbidden} is in the merged manifest" >&2
    fail=1
  fi
done
if ! grep -qx android.permission.SCHEDULE_EXACT_ALARM <<<"${requested}"; then
  echo "FAIL: SCHEDULE_EXACT_ALARM missing" >&2
  fail=1
fi
[[ ${fail} -eq 0 ]] && echo "OK: manifest permissions match D-073 / D-074"
exit ${fail}
