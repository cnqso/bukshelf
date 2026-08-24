#!/bin/bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apple_dir="${app_dir}/src-tauri/gen/apple"
simulator_id="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"

if [[ -z "${simulator_id}" ]]; then
  echo "No booted iOS simulator. Open Simulator and boot a device first."
  exit 1
fi

if [[ ! -f "${apple_dir}/Externals/arm64/release/libapp.a" ]]; then
  echo "No current iOS native build. Run pnpm dev-ios-sim first."
  exit 1
fi

(
  cd "${apple_dir}"
  xcodegen generate
  BUKSHELF_USE_PREBUILT_RUST=1 xcodebuild \
    -quiet \
    -workspace Readest.xcodeproj/project.xcworkspace \
    -scheme Readest_iOS \
    -destination "platform=iOS Simulator,id=${simulator_id}" \
    -configuration release \
    test
)
