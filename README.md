# ラジコ番組ダウンロードスクリプト

radikoの番組をダウンロードできます。（タイムフリーの番組のみです）

## 準備する

以下が必要です。
- nodejs
- pnpm
- ffmpeg

**実行に必要なライブラリのインストール**
```sh
npm i
```

## 実行する

ダウンロードしたい番組のURL(`https://radiko.jp/#!/ts/STATION_ID/YYYYMMDDhhmmss`のような感じ)が必要です。

以下のコマンドでダウンロードが始まります。
```sh
pnpm start 番組のURL
```

