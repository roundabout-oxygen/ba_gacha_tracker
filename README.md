# ブルーアーカイブ リアルタイムガチャ集計 (BA Gacha Live Tracker)

🌐 **Webアプリ (v1.0.43)**: [https://roundabout-oxygen.github.io/ba_gacha_tracker/](https://roundabout-oxygen.github.io/ba_gacha_tracker/)

『ブルーアーカイブ（ブルアカ）』のガチャを引きながら、リアルタイムに結果を記録・集計できるWebアプリケーションです。

## 主な特徴
- **リアルタイム集計**: 累計連数、☆3確率、ピックアップ確率、仮天井（100連50%枠）勝率、チャージ状況を即座に算出・表示
- **快適な入力シート**: 10連/単発の入力切替、生徒名入力サジェスト、新規獲得・ピックアップのワンタッチ記録
- **確率収束グラフ**: 基準確率に対する実測確率の推移と獲得生徒アイコンを折れ線グラフで可視化
- **OBS Studio 直接連携**: カスタムブラウザドックで入力した結果を、透明背景のブラウザソースへゼロ遅延で自動同期
- **生徒アイコンの仮登録**: 未実装の最新生徒アイコンを画像切り抜きで即時追加・共有可能

## ブルアカ ガチャ集計ツール（OBS設定）

### ① 表示用（配信画面に出す）
OBSのソース「＋」→「ブラウザ」→

- URL：
```text
https://roundabout-oxygen.github.io/ba_gacha_tracker/?mode=overlay#overlay
```
- 横（幅）：`505`　縦（高さ）：`700`

### ② 入力用（手元で操作する）
OBS上メニュー「ドック」→「カスタムブラウザドック」→

- ドック名：`ブルアカガチャ操作`
- URL：
```text
https://roundabout-oxygen.github.io/ba_gacha_tracker/
```
→「適用」を押す
