# フィードの運行期間切れ（feed_end_date）への対応手順

> CLAUDE.md から移した元の文（2026-10-27、63本目）。

2026-10-06、立山町営バスのフィードが2026-10-10に`feed_end_date`を迎えることが判明し、対応した際の手順。他のフィードが同様の期限を迎えたときも同じ手順を使う。

1. **期限が近いフィードの把握**：`generate-site-data.js`の`checkFeedExpiry()`が公開モード（`npm run build`等、引数なし）実行時に、残り60日以内のフィードを警告、既に期限切れのフィードがあればビルドを失敗させる（このガードは下記2の仕組みを入れたあとも外さない。「作り直しを忘れないため」の安全網として残す）。
2. **ビルド時点の自動除外（2026-10-06実装）**：`build-prefecture.js`が、GTFS取得後・運賃フィルタ前に、取得した`feed_info.txt`の`feed_end_date`がビルド実行日より過去のフィードを「運行期間が終了したデータ」として理由付きで自動除外する（ライセンス不許可・運賃データなしと同じ`excluded`配列に合流し、出典画面の「対象外としたデータ」に出る）。`feed_end_date`が取得できないフィードは判定不能として除外しない。
3. **期限到来時の手順**：
   a. まず gtfs-data.jp で該当事業者の新しいフィード版が出ていないか確認する（`https://api.gtfs-data.jp/v2/organizations/{org}/feeds/{feed}`で`gtfs_files[].rid==="current"`の`feed_end_date`を見る）。
   b. 新版が出ていれば、該当県を`node scripts/build-prefecture.js {コード} --force`で再ビルドし、`npm run bundle` → `npm run verify-render` → `npm run verify-regression` → `npm run verify-local` を通してから公開（push）する。
   c. 新版が出ていなければ、上記2の仕組みにより次回ビルドで自動的に理由付き除外される。除外後に当該県を`--force`で再ビルド・公開すれば、期限切れデータを使わずに済む（検索結果からは当該事業者が消えるが、ビルド自体は失敗にならない）。
   d. いずれの場合も、再ビルド後は必ずフル検証（bundle/verify-render/verify-regression/verify-local）を通してから公開すること。
4. **2026-10-13時点の状況**：立山町営バス（`tateyamatown.tateyama`）は2026-10-13に新版（`feed_version=2026/10/13改正-見える化ver2.6e`、`feed_start_date=20261013`、`feed_end_date=20270331`）で再ビルド・公開済み。**次にこのフィードの期限切れに注意すべき日は2027-03-31。**
   なお、この再ビルドで路線数が26→4、停留所数が121→52に減ったが、生のGTFSファイル（routes.txt・stops.txt等）を新旧直接比較し、新版で新規追加された停留所が0件・「stops.txtにはあるが代表日に走る便がない」という中間状態も0件であることを確認済み（解析側の不具合ではなく、町の実際のダイヤ改正による路線縮小。詳細はgit logの該当コミット参照）。
