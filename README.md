# 逆引き旅行アプリ（Reverse Travel）

**コンセプト**：「予算を入れたら、行ける場所が出てくる」旅行アプリ

通常の旅行検索（行き先→費用を調べる）とは逆に、**予算を起点に行き先を提案**する。バスと電車の組み合わせで行ける、知られていない景勝地の発見を価値とします。

---

## フェーズ1（現在の実装）

### 対応エリア・事業者
- **香川県**：琴電（鉄道）+ ことでんバス
- 同一グループで地理的に接続している2社で、実際の乗り継ぎユースケースを再現

### 技術スタック
- **単一HTMLファイル**（バックエンドなし）
- **GTFSデータ**：公共交通の運賃・ルート情報
- **Wikidata/Wikipedia API**：観光スポット情報
- **静的JSON**：ビルド時にデータを生成、実行時にブラウザで動作

### 開発環境セットアップ

#### 1. 依存パッケージをインストール
```bash
npm install
```

#### 2. ビルド実行（GTFSデータ取得 + 派生JSON生成）
```bash
npm run build
```

このコマンドで：
- `data/raw-gtfs/` に琴電・ことでんバスのGTFSファイルをダウンロード
- `data/derived/` に派生JSON（運賃ルックアップテーブル、駅メタデータ、スポット情報）を生成

#### 3. 開発サーバー起動
```bash
# VS Code の Live Server 拡張を使用
# index.html を右クリック → "Open with Live Server"
# または
npx live-server
```

**重要**：`file://` スキームで直接開くとCORSエラーになるため、必ずローカルサーバー経由で開いてください

#### 4. 最終提出版を生成（単一ファイル化）
```bash
npm run bundle
```

このコマンドで `dist/index.html` が生成されます（すべてのスクリプト・データを組み込んだ単一HTMLファイル）

---

## ファイル構成

```
reverse-travel/
├── index.html                          # 開発用（ES6モジュール形式）
├── assets/
│   ├── css/style.css                   # UIスタイル
│   └── js/
│       ├── main.js                     # UIロジック
│       ├── gtfs-loader.js              # GTFS読み込み・パース
│       ├── fare-calculator.js          # 運賃計算（簡易版：OD表検索＋ラストワンマイル）
│       └── spot-finder.js              # スポット検索・絞り込み
├── data/
│   ├── raw-gtfs/                       # ビルド時に自動取得（Git管理外）
│   │   ├── kotoden/
│   │   └── kotoden-bus/
│   └── derived/                        # ビルド時に生成（Git管理外）
│       ├── fare-lookup-tables.json
│       ├── stops-metadata.json
│       ├── route-info.json
│       └── spots-by-station.json
├── scripts/
│   ├── build-pipeline/
│   │   ├── fetch-gtfs.js               # GTFS自動ダウンロード
│   │   ├── parse-and-transform.js      # GTFS → 派生JSON変換
│   │   └── generate-spots.json.js      # Wikidata/Wikipedia → スポット情報生成
│   ├── fetch-and-build.js              # ビルド統合実行
│   └── bundle-html.js                  # 単一HTMLへ結合
├── config/
│   ├── target-operators.json           # 対象事業者・GTFS URL
│   ├── spot-ranking-config.json        # ページビュー閾値（知名度判定）
│   └── spot-config.json                # Wikidataクラスフィルタ
├── dist/                               # 最終提出版（Git管理対象）
│   └── index.html
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

---

## 運賃計算ロジック（フェーズ1：簡易版）

### スコープ
1. OD運賃表から「出発駅から¥X以内の到達駅」を直接検索
2. 各到達駅から、予算の残額で乗り継げるバス（均一運賃型）を追加
3. 乗り継ぎは最大1回（ラストワンマイル）に限定

### 運賃方式の自動判定
- configの `fare_type` は「参考値」に過ぎない
- 実装では常に `fare_rules.txt` の実データから判定
- 判定ロジック：
  - `origin_id` と `destination_id` が両方埋まっている → **OD運賃表型**
  - `route_id` のみで両者が空欄 → **均一運賃型**
- 想定値と実データが食い違ったら警告をログ出力

### フェーズ2以降
任意の乗換回数・任意の事業者組み合わせに対応した汎用グラフ探索（ダイクストラ法）へ移行予定

---

## スポット検索・知名度判定

### データ取得フロー
1. Wikidata SPARQL で駅周辺（半径3km）のスポットを検索
2. Wikipedia REST API で説明文・画像を取得
3. Wikimedia Pageviews API で直近12ヶ月のアクセス数を取得

### 「知られていない」判定（相対順位＋絶対値のハイブリッド方式）
- **基本**：検索結果内でページビュー数が低い順に優先表示（相対順位）
- **例外**：月間ページビュー数が25000を超えるスポットは除外（絶対値）
  - 暫定値。実データを見ながら 10000-50000PV の範囲で調整予定
- **データなし**：ページビューデータが存在しない場合は優先表示

---

## カラーデザイン

| 役割 | 色 | カラーコード |
|---|---|---|
| メインカラー | 黄緑 | `#72B01D` |
| メインDeep | 深緑 | `#4E7D0E` |
| メインLight | 薄黄緑 | `#EEF7DC` |
| アクセント | オレンジ | `#FF6B2B` |
| テキスト | ダークグレー | `#1F2937` |
| 背景 | 薄緑白 | `#F6FAF0` |

---

## デプロイ（GitHub Pages）

1. `npm run bundle` で `dist/index.html` を生成
2. GitHub にプッシュ
3. リポジトリの Settings → Pages で以下を設定：
   - Source: Deploy from a branch
   - Branch: main
   - Folder: / (root)
4. `https://ユーザー名.github.io/reverse-travel` にデプロイ完了

---

## ライセンス

MIT

## 今後の展開

- **フェーズ2**：複数事業者対応、汎用グラフ探索（ダイクストラ法）
- **フェーズ3**：全国対応、ユーザー評価システム、アフィリエイト連携
