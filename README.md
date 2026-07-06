# Reversi AI League

4つの Claude モデルがそれぞれ自力で実装したリバーシAIを、総当たりリーグで戦わせるプロジェクトです。

このリポジトリは [Claude Fable 5 Meetup Tokyo](https://luma.com/claude-2l7c)(2026-07-06 19:00–21:00、㈱ブレインパッド・六本木一丁目、主催: Claude Community Events / ぬこぬこ氏)のハンズオンで、Claude Code(Claude Fable 5)を使って作成しました。エンジン・4体のAI・観戦UI・バッチ実行基盤・12,000局の対戦まで含めて、**イベント中の2時間弱で作ったプロジェクト**です。

## プレイヤー

各スロットの `decideMove(board, myColor, legalMoves)` は、それぞれのモデルが git worktree で並行開発した実装をそのまま貼り込んだものです。

| スロット | 実装モデル | 実装時の設定(記憶ベース) | アルゴリズム概要 |
|---|---|---|---|
| fable | Claude Fable 5 | reasoning effort: xhigh | ビットボード αβ探索 + 反復深化 + 終盤完全読み |
| opus | Claude Opus 4.8 | reasoning effort: xhigh | αβ探索 + 反復深化 + 終盤完全読み |
| sonnet | Claude Sonnet 5 | reasoning effort: xhigh | ビットボード αβ探索 + 反復深化 |
| haiku | Claude Haiku 4.5 | thinking なし | 固定深度 minimax(時間チェックなし) |

ルール: 1手 **100ms** 制限。時間超過・例外・不正な戻り値は反則となり、ランダム合法手に置換して続行します。勝点は勝3・分1・敗0。

## ファイル構成

| パス | 内容 |
|---|---|
| `reversi-arena.html` | ルールエンジン + 4モデルのAI + 簡易UI。単一HTML・外部依存ゼロ(ダブルクリックで起動)。セルフテスト内蔵 |
| `tools/arena.mjs` | 対戦バッチCLI(依存ゼロ)。HTMLの `CORE START/END` マーカー間を vm で抽出して実行する単一ソース構成 |
| `tools/report-template.html` | HTMLレポートの雛形 |
| `logs/` | 対戦ログ。`run-<baseSeed>/games.jsonl`(1局1行)+ `meta.json`(実行条件) |

## 使い方

```sh
node tools/arena.mjs run --rounds 100 --workers 12  # 100ラウンド×12局を並列実行しJSONLに永続化
node tools/arena.mjs standings                      # 全ログを集計して順位表・直接対決表を表示
node tools/arena.mjs verify                         # 棋譜をルールエンジンで再生して整合性検証
node tools/arena.mjs report                         # 自己完結型レポート logs/report.html を生成
```

シードは起動時刻ミリ秒(`Date.now()`)をベースに採番するため実行間で衝突しません。ただしAIは実時間で思考を打ち切るため、同シードでも再実行時に手順が揺れることがあります。**ログの `moves` 列(棋譜)が正本**であり、`verify` がその合法性・最終石数・勝敗を検証します。

## 結果スナップショット(2026-07-06、12,032局)

| # | player | 勝点 | 勝 | 分 | 敗 | 反則 |
|---|---|---|---|---|---|---|
| 1 | fable | 14180 | 4668 | 176 | 1172 | 6 |
| 2 | sonnet | 13320 | 4435 | 15 | 1565 | 12 |
| 3 | opus | 8411 | 2748 | 167 | 3101 | 16 |
| 4 | haiku | 6 | 2 | 0 | 6015 | 4759 |

### おもしろい発見

- **並列度(CPU競合)で強さが逆転する。** 12ワーカー実行では sonnet が fable に大きく勝ち越し、20ワーカー実行では逆に fable が sonnet に大差で勝ち越した。時間打ち切り探索の実効深度がCPU競合で変わるため、結果はワーカー数(実行条件)ごとにしか比較できない。各 run の `meta.json` に条件を記録している。
- haiku は時間チェックを持たない固定深度探索のため、CPU競合が増えると反則(100ms超過)率が跳ね上がる。
