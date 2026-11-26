# 提出物⑨ 使用したオープンデータ

> 2026-11-27（【79】）作成。もとは `docs/data/national/data-sources.json`（公開中の3県〈香川・富山・石川〉を統合したもの。2026-11-27 0:32 JST 生成）と、アプリの出典画面（`index.html` の「1. データの出典」）。
> `data/derived/data-sources.json` は 2026-09-30 の香川だけの古いファイルのため使わなかった。
> フィードの版が変わったら `docs/data/national/data-sources.json` から作り直す。

## 応募フォームに貼る形（記述例の書き方に合わせたもの）

```
 * GTFSデータリポジトリ: https://gtfs-data.jp/
   - 富山地方鉄道株式会社「富山地方鉄道バス」のGTFSデータ
   - 加越能バス株式会社「加越能バス（一般路線）」「加越能バス（世界遺産バス）」「加越能バス（氷見市街地周遊バス）」のGTFSデータ
   - 万葉線株式会社「万葉線」のGTFSデータ
   - 富山市「まいどはやバス」「山田コミュニティバス」「婦中コミュニティバス」「大山コミュニティバス」「八尾コミュニティバス」のGTFSデータ
   - 高岡市「高岡市公営バス」のGTFSデータ
   - 魚津市「魚津市民バス」のGTFSデータ
   - 黒部市「新幹線生地、石田三日市、愛本、電動ミニバス」のGTFSデータ
   - 滑川市「コミュニティバス のるmycar」のGTFSデータ
   - 砺波市「砺波市営バス」のGTFSデータ
   - 小矢部市「小矢部市営バス」のGTFSデータ
   - 南砺市「南砺市営バス」のGTFSデータ
   - 上市町「上市町営バス」のGTFSデータ
   - 立山町「立山町営バス」のGTFSデータ
   - 入善町「のらんマイ・カー」のGTFSデータ
   - 富山県朝日町「あさひまちバス」のGTFSデータ
   - 白山市「白山市コミュニティバス めぐーる」のGTFSデータ
   - 小松市「木場潟線」「市内循環線南コース」のGTFSデータ
   - 野々市市「コミュニティバス」のGTFSデータ
   - 内灘町「コミュニティバス」のGTFSデータ
 * 高松琴平電気鉄道株式会社（事業者のサイトから直接取得）: https://www.kotoden.co.jp/publichtm/gtfs/index.html
   - 「ことでん電車」「ことでんバス」のGTFSデータ
 * Wikidata: https://www.wikidata.org/
   - 観光地の名前・分類・座標・写真のファイル名
 * Wikipedia 日本語版: https://ja.wikipedia.org/
   - 観光地の紹介文・記事へのリンク
 * Wikimedia Commons: https://commons.wikimedia.org/
   - 観光地の写真
 * 国土地理院: https://www.gsi.go.jp/
   - 国土地理院ベクトルタイル提供実験（地図）: https://github.com/gsi-cyberjapan/gsimaps-vector-experiment
   - 地理院タイル（標高タイル〈3Dの地形〉・淡色地図〈地図の読み込み前・WebGLが使えない端末〉）: https://maps.gsi.go.jp/development/ichiran.html
 * 国土交通省 国土数値情報: https://nlftp.mlit.go.jp/ksj/
   - 行政区域データ（N03）〈ビルドのときだけ。同じ名前の駅・停留所を市区町村名で区別するため〉
```

## GTFSのフィード（28件）

取得元は、gtfs-data.jp のものは API v2 の `https://api.gtfs-data.jp/v2/organizations/{組織}/feeds/{フィード}/files/feed.zip`（`?uid=` の版指定は省いた）。期間は `feed_info.txt` の `feed_start_date`〜`feed_end_date`。

| # | 県 | 提供元（feed_publisher_name） | データセット名 | 取得元 | ライセンス | 期間 |
|---|---|---|---|---|---|---|
| 1 | 香川 | 高松琴平電気鉄道株式会社 | ことでん電車 | 事業者サイト https://www.kotoden.co.jp/publichtm/gtfs/gtfsdata/gtfs_kd.zip | CC BY 4.0 | 2025-12-12〜2027-02-28 |
| 2 | 香川 | ことでんバス株式会社 | ことでんバス | 事業者サイト https://www.kotoden.co.jp/publichtm/gtfs/gtfsdata/latest/gtfs_kb.zip | CC BY 4.0 | 2026-10-01〜2027-03-31 |
| 3 | 富山 | 富山地方鉄道株式会社 | 富山地方鉄道バス | gtfs-data.jp chitetsu/chitetsubus | CC0 1.0 | 2026-10-22〜2027-10-21 |
| 4 | 富山 | 加越能バス株式会社 | 加越能バス（世界遺産バス） | gtfs-data.jp kaetsunou/kaetsunousekaiisan | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 5 | 富山 | 加越能バス株式会社 | 加越能バス（氷見市街地周遊バス） | gtfs-data.jp kaetsunou/kaetsunouhimi | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 6 | 富山 | 加越能バス株式会社 | 加越能バス（一般路線） | gtfs-data.jp kaetsunou/kaetsunouippan | CC0 1.0 | 2026-07-16〜2027-03-31 |
| 7 | 富山 | 上市町 | 上市町営バス | gtfs-data.jp kamiichitown/kamiichi | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 8 | 富山 | 黒部市 | 新幹線生地、石田三日市、愛本、電動ミニバス | gtfs-data.jp kurobecity/shinkansenikuji-ishida-aimoto-minibus | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 9 | 富山 | 万葉線株式会社 | 万葉線 | gtfs-data.jp manyosen/manyosen | CC0 1.0 | 2026-09-01〜2027-08-31 |
| 10 | 富山 | 滑川市 | コミュニティバス「のるmycar」 | gtfs-data.jp namerikawacity/norumycar | CC0 1.0 | 2026-10-01〜2027-09-30 |
| 11 | 富山 | 南砺市 | 南砺市営バス | gtfs-data.jp nantocity/nanbus | CC0 1.0 | 2026-10-01〜2027-03-31 |
| 12 | 富山 | 入善町 | のらんマイ・カー | gtfs-data.jp nyuzentown/noranmaicar | CC0 1.0 | 2026-02-25〜2027-03-31 |
| 13 | 富山 | 小矢部市 | 小矢部市営バス | gtfs-data.jp oyabecity/oyabecitybus | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 14 | 富山 | 高岡市 | 高岡市公営バス | gtfs-data.jp takaokacity/koueibus | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 15 | 富山 | 富山県立山町 | 立山町営バス | gtfs-data.jp tateyamatown/tateyama | CC0 1.0 | 2026-10-13〜2027-03-31 |
| 16 | 富山 | 砺波市 | 砺波市営バス | gtfs-data.jp tonamicity/tonamishieibasu | CC0 1.0 | 2026-03-26〜2027-03-31 |
| 17 | 富山 | 富山県朝日町 | あさひまちバス | gtfs-data.jp toyama-asahitown/asahimachibus | CC0 1.0 | 2026-03-16〜2027-03-31 |
| 18 | 富山 | 富山市（八尾バス管理センター） | 山田コミュニティバス | gtfs-data.jp toyamacity/yamadacommunitybus | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 19 | 富山 | 婦中コミュニティバス運営委員会 | 婦中コミュニティバス | gtfs-data.jp toyamacity/fuchucommunitybus | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 20 | 富山 | 富山市（大山バス管理センター） | 大山コミュニティバス | gtfs-data.jp toyamacity/oyamacommunitybus | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 21 | 富山 | 富山市 | まいどはやバス | gtfs-data.jp toyamacity/maidohayabus | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 22 | 富山 | 富山市（八尾バス管理センター） | 八尾コミュニティバス | gtfs-data.jp toyamacity/yatsuocommunitybus | CC0 1.0 | 2026-04-20〜2027-03-31 |
| 23 | 富山 | 魚津市 | 魚津市民バス | gtfs-data.jp uozucity/junkai | CC0 1.0 | 2026-04-02〜2027-03-31 |
| 24 | 石川 | 白山市 | 白山市コミュニティバス「めぐーる」 | gtfs-data.jp hakusancity/hakusan_bus_meguru | CC BY 4.0 | 2026-03-16〜2027-03-15 |
| 25 | 石川 | 小松市（※） | 木場潟線 | gtfs-data.jp komatsucity/kibagatasen | CC0 1.0 | 2026-10-01〜2027-09-30 |
| 26 | 石川 | 小松市 | 市内循環線南コース | gtfs-data.jp komatsucity/orange | CC0 1.0 | 2026-04-01〜2027-03-31 |
| 27 | 石川 | 野々市市 | コミュニティバス | gtfs-data.jp nonoichicity/communitybus | CC BY 4.0 | 2026-02-05〜2027-03-31 |
| 28 | 石川 | 内灘町 | コミュニティバス | gtfs-data.jp uchinadatown/communitybus | CC BY 4.0 | 2025-11-17〜2026-12-31 |

- ライセンスのURL：CC0 1.0 https://creativecommons.org/publicdomain/zero/1.0/deed.ja ／ CC BY 4.0 https://creativecommons.org/licenses/by/4.0/deed.ja
- （※）木場潟線の `feed_publisher_name` は法人番号「3000020172031」（小松市）と書かれている。表では小松市とした。
- 内灘町コミュニティバスは 2026-12-31 で期限。gtfs-data.jp には次の版（2027-01-01〜2027-12-31）が出ている（`docs-dev/feed-expiry.md` の手順で作り直す）。加越能バス（一般路線）は次の版（2026-12-01〜2027-11-30）が出ている。どちらも作り直したらこの表も直す。

### 取得したが使っていないフィード（11件、出典画面の「対象外としたデータ」と同じ）

| 提供元・データセット名 | 理由 |
|---|---|
| 黒部市 新幹線生地線 | gtfs-data.jp上で廃止済み（2026-04-01） |
| 黒部市 石田・愛本 | gtfs-data.jp上で廃止済み（2026-04-01） |
| 西日本ジェイアールバス 名金線（金沢～福光） | gtfs-data.jp上で廃止済み（2022-06-30） |
| 富山市 上条コミバス | gtfs-data.jp上で廃止済み（2025-09-30、デマンド運行に移行） |
| 富山市 水橋ふれあいコミュニティバス | gtfs-data.jp上で廃止済み（2025-09-30、デマンド運行に移行） |
| 魚津市 おもてなし魚津直行便 | gtfs-data.jpに今の版（rid="current"）が無い |
| 富山地方鉄道 富山地方鉄道市内電車 | 運賃データなし |
| 射水市 きときとバス | 運賃データなし（解決できる運賃ルールが無い） |
| 富山市 堀川南地域コミュニティバス | 運賃データなし |
| 富山市 呉羽いきいきバス | 運賃データなし |
| 小松市 市内循環線北コース | 運賃データなし（解決できる運賃ルールが無い） |

## GTFS以外のデータ

| 提供元 | データセット名 | URL | ライセンス | 使い方 |
|---|---|---|---|---|
| Wikimedia Foundation | Wikidata | https://www.wikidata.org/ | CC0 1.0（構造化データ） | 観光地の名前・分類（P31）・座標（P625）・写真のファイル名（P18）・記事へのサイトリンク。ビルドのときにWDQS（SPARQL）で取得 |
| Wikimedia Foundation | Wikipedia 日本語版 | https://ja.wikipedia.org/ | CC BY-SA 4.0（本文） | 紹介文（記事の冒頭）・記事へのリンク。ビルドのときにMediaWiki APIで取得 |
| Wikimedia Foundation | Wikimedia Commons | https://commons.wikimedia.org/ | ファイルごとに異なる（CC BY-SA・CC BY・パブリックドメインなど） | 観光地の写真（WikidataのP18のファイル）。表示のときに読み込む |
| 国土地理院 | 国土地理院ベクトルタイル提供実験（experimental_bvmap） | https://github.com/gsi-cyberjapan/gsimaps-vector-experiment | 国土地理院コンテンツ利用規約 https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html | 2D・3Dの地図（地図記号を外し、色をアプリに合わせて加工） |
| 国土地理院 | 地理院タイル 標高タイル（dem_png） | https://maps.gsi.go.jp/development/ichiran.html | 国土地理院コンテンツ利用規約 | 3Dの地形（加工して立体にしている） |
| 国土地理院 | 地理院タイル 淡色地図（pale） | https://maps.gsi.go.jp/development/ichiran.html | 国土地理院コンテンツ利用規約 | 地図を読み込む前・WebGLが使えない端末の地図 |
| 国土交通省 | 国土数値情報 行政区域データ（N03） | https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v3_1.html | 国土数値情報ダウンロードサイトコンテンツ利用規約（政府標準利用規約第2.0版準拠） https://nlftp.mlit.go.jp/ksj/other/agreement_01.html | ビルドのときだけ。同じ名前の駅・停留所を市区町村名で区別する |

- アプリの出典画面は Wikipedia・Wikidata をまとめて「CC BY-SA 4.0」と書いている。上の表は実際のライセンス（Wikidata は CC0、写真は Commons のファイルごと）で書いた。
