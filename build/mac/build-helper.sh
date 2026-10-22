#!/bin/bash
# 맥에서만 실행: 맥 캘린더 도우미를 애플 실리콘·인텔 겸용으로 빌드
set -euo pipefail
cd "$(dirname "$0")"
for arch in arm64 x86_64; do
  swiftc -swift-version 5 -O -target "${arch}-apple-macos11" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper-Info.plist \
    EventKitHelper.swift -o "deskcal-eventkit-${arch}"
done
lipo -create deskcal-eventkit-arm64 deskcal-eventkit-x86_64 -output deskcal-eventkit
rm -f deskcal-eventkit-arm64 deskcal-eventkit-x86_64
chmod +x deskcal-eventkit
./deskcal-eventkit --version
lipo -info deskcal-eventkit
