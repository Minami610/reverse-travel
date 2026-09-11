# 逆引き旅行アプリ（Reverse Travel）

出発駅と予算を入れると、その予算内で**公共交通機関（電車・バス）だけ**で行ける、あまり知られていない景勝地を提案するアプリです。バックエンドを持たない静的サイトで、GitHub Pages 上でそのまま動作します。

**公開URL**：https://minami610.github.io/reverse-travel/

---

## 現在の状態

- **香川県版が公開済み**です（琴電＋ことでんバスの2社）。
- **全国対応（約43都道府県）へ移行中**です。鳥取・広島・宮崎・福井の4県はデータ源に情報がなく対象外のため、カバレッジは「約43都道府県」となる見込みです。
- 新しい全国対応パイプライン（`scripts/build-pipeline/generate-spots-by-region.js` ほか）は実装済みですが、`npm run build` の入口（`fetch-and-build.js`）はまだ香川県版の旧パイプラインを呼んでいます。設計判断の詳細な経緯は [CLAUDE.md](CLAUDE.md) と `git log` を参照してください。

---

## データの出典・ライセンス

このアプリはデータの出典・正確性の非保証・お問い合わせ先を、**アプリ画面のフッターおよび「出典の詳細・免責・お問い合わせ」モーダル**に常時表示しています（ビルド時に実際に使用したフィードの情報から自動生成されるため、以下の説明と実装が食い違うことはありません）。

- **運賃・経路・停留所データ（GTFS／GTFS-JP）**：[公共交通オープンデータセンター](https://www.odpt.org/)や [gtfs-data.jp（GTFSデータリポジトリ）](https://gtfs-data.jp/) を主な取得元とし、それらに未登録の事業者については個別に事業者公式サイトから取得しています。他データソースの併用は「公共交通オープンデータチャレンジ」の応募条件で禁止されていません。各フィードの公開元・ライセンス表記・取得日時は `data/derived/data-sources.json`（ビルド時生成、`scripts/build-pipeline/generate-data-sources-manifest.js` 参照）にまとまっており、アプリ画面のモーダルはこれをそのまま描画しています。
- **地図タイル**：[国土地理院](https://maps.gsi.go.jp/development/ichiran.html) の地理院タイル（標準地図）。
- **観光地の説明・画像・座標**：Wikipedia 日本語版・Wikidata（[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja)）。

表示される運賃・所要時間・経路・観光情報は自動生成されたものであり、**正確性・完全性・最新性は保証されません**。実際のご利用前には各交通事業者の公式情報をご確認ください。

## ライセンス

本リポジトリのソースコードは [MIT License](LICENSE) のもとで公開しています。GTFSデータ・地図タイル・Wikipedia/Wikidataのコンテンツは、それぞれ上記の出典元が定めるライセンス（アプリ内表示を参照）に従います。

---

## セットアップ・ビルド手順

### 1. 依存パッケージをインストール
```bash
npm install
```

### 2. ビルド実行（現在動作する経路：香川県版）
```bash
npm run build
```
`scripts/fetch-and-build.js` が以下を順に実行します。
1. `fetch-gtfs.js` — `config/target-operators.json` に基づき GTFS を取得・展開
2. `generate-data-sources-manifest.js` — 出典表示用マニフェスト（`data/derived/data-sources.json`）を生成
3. `parse-and-transform.js` — GTFS → 派生JSON（運賃テーブル、駅メタデータ 等）
4. `generate-route-details.js` — 経路・所要時間の生成
5. `generate-spots.json.js` — Wikidata/Wikipedia からスポット情報を生成

生成物はすべて `data/derived/`（Git管理外）に出力されます。

### 3. 開発サーバーで確認
`file://` で直接開くと CORS エラーになるため、必ずローカルサーバー経由で開いてください。
```bash
# VS Code の Live Server 拡張、または
npx live-server
```

### 4. 単一HTMLファイルにバンドル
```bash
npm run bundle
```
`assets/`・`data/derived/` の内容を1ファイルに埋め込んだ `dist/index.html` を生成し、`docs/index.html` にも自動コピーします（GitHub Pages は `main` ブランチの `docs/` フォルダを配信元にしています）。

### 5. 描画検証（フロントエンド・データ形式を変更したら必須）
```bash
npm run verify-render
```
jsdom で `dist/index.html` を実際にロードし、初期表示・検索結果カード・フッター/出典モーダルが正しく描画されるかを検証します。構文チェックが通っても画面が壊れることがあるため（過去に3回発生）、このチェックを省略しないでください。

### 都道府県単位でスポットデータを再生成する場合（全国対応パイプライン）
新しい地域別収集パイプラインを使う場合は、まず市区町村→都道府県の対応表を生成する必要があります（未生成・不完全だとビルドが致命的エラーで停止します）。
```bash
node scripts/build-pipeline/generate-municipality-table.js
```
その後 `generate-spots-by-region.js` の関数を対象県のGTFS停留所データに対して呼び出します。全国一括ではなく少数県（隣接ペアを含む）から段階的に展開する方針です。詳細は [CLAUDE.md](CLAUDE.md) を参照してください。

---

## ファイル構成

```
reverse-travel/
├── index.html                                  # 開発用（ES6モジュール形式）
├── assets/
│   ├── css/style.css
│   └── js/
│       ├── main.js                             # UIロジック・出典モーダル
│       ├── gtfs-loader.js                      # GTFS派生データの読み込み・県またぎ重複排除
│       ├── fare-calculator.js                  # 運賃計算（均一運賃型／OD運賃表型を自動判定）
│       ├── spot-finder.js                      # スポット検索・順位付け
│       ├── route-formatter.js / route-duration.js
│       ├── map-view.js                         # 地図表示（Leaflet + 地理院タイル）
│       └── layout-controller.js                # PC/スマホのレイアウト切替
├── data/
│   ├── raw-gtfs/                               # ビルド時に自動取得（Git管理外）
│   └── derived/                                # ビルド時に生成（Git管理外）
│       ├── data-sources.json                   # 出典表示用マニフェスト
│       ├── fare-lookup-tables.json / stops-metadata.json / route-info.json / spots-by-station.json 等
├── scripts/
│   ├── fetch-and-build.js                      # ビルド統合実行（現状：香川県版）
│   ├── bundle-html.js                          # 単一HTMLへ結合（docs/へ自動コピー）
│   ├── verify-initial-render.js                # jsdomによる描画検証
│   └── build-pipeline/
│       ├── fetch-gtfs.js
│       ├── generate-data-sources-manifest.js   # 出典マニフェスト生成
│       ├── parse-and-transform.js
│       ├── generate-route-details.js
│       ├── generate-spots-by-region.js         # 全国対応パイプライン（bbox一括取得・除外機構）
│       ├── generate-spots.json.js              # 旧パイプライン（現行のnpm run buildが使用）
│       └── generate-municipality-table.js      # 市区町村→都道府県対応表の生成
├── config/
│   ├── target-operators.json                   # 対象事業者・GTFS URL・出典分類
│   ├── spot-config.json                        # Wikidataクラスフィルタ（除外・保護リスト）
│   └── spot-ranking-config.json                # 知名度指標（sitelinks）の閾値
├── dist/ , docs/                                # ビルド成果物（Git管理対象、docs/がPages配信元）
├── LICENSE
└── package.json
```

---

## 運賃計算ロジック

GTFSの `fare_rules.txt` を実データから解析し、**均一運賃型**（`route_id` のみ）と**OD運賃表型**（`origin_id`/`destination_id` が `zone_id` として設定）を自動判定します（configの想定値は信用せず、常に実データを優先）。経路選択は「運行頻度の下限＋所要時間最短」を基準とし、待ち時間（運行時間帯÷便数÷2）を考慮します。詳細な設計判断は [CLAUDE.md](CLAUDE.md) を参照してください。

## スポット収集・知名度判定

Wikidata SPARQL の bbox（`wikibase:box`）で都道府県単位に一括取得し、知名度指標には Wikidata の `sitelinks`（他言語版記事数）を使用しています。除外リストはクラス保護（守護リスト）・ガードテスト・機械的な誤除外検出・個別許可リストの4層構成で、`config/spot-config.json` に定義を集約しています。設計に至った経緯（pageviewsを廃止した理由、除外の判断軸など）は [CLAUDE.md](CLAUDE.md) を参照してください。

---

## 今後の展開

- gtfs-data.jp API v2 のカタログ（`/feeds`）を用いた都道府県別フィード割り当てとビルドオーケストレーションの実装
- 全国約43都道府県への段階的展開（まず隣接3県で全経路を検証してから拡大）
- ダイヤ改正・運賃改定に追従する自動更新の仕組み
