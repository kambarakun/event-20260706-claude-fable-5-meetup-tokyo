#!/usr/bin/env node
// リバーシアリーナ: 対戦バッチ実行・ログ永続化・集計CLI(依存パッケージなし)
//
//   node tools/arena.mjs run --rounds 500 --workers 12   # 500ラウンド×12局を並列実行し logs/ にJSONL永続化
//   node tools/arena.mjs standings [logsDir...]          # 保存済みログを集計して順位表・直接対決表を表示
//   node tools/arena.mjs verify [logsDir...]             # ログの棋譜をルールエンジンで再生して整合性検証
//
// エンジンは reversi-arena.html の CORE START/END マーカー間を抽出して vm 上で実行する
// (単一ソース。HTML側を更新すればバッチも自動的に追従する)。
//
// シードは起動時刻ミリ秒(Date.now())をベースに採番し、ラウンドkのシードは (base+k)>>>0。
// 各行に実効シードを記録する。ただしAIは実時間の思考打ち切りを持つため、同シード再実行でも
// 探索深度が変わり手順が揺れることがある。ログの moves 列が正本であり、verify はこれを検証する。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_HTML = path.join(ROOT, 'reversi-arena.html');
const SCHEMA_VERSION = 1;

// ---------- エンジン抽出 ----------

function loadEngine() {
  const html = fs.readFileSync(ENGINE_HTML, 'utf8');
  const s = html.indexOf('// ===== CORE START =====');
  const e = html.indexOf('// ===== CORE END =====');
  if (s < 0 || e < 0) throw new Error('reversi-arena.html に CORE START/END マーカーが見つかりません');
  const src = html.slice(s, e);
  const ctx = vm.createContext({});
  const api = vm.runInContext(
    src + '\n;({ BLACK, WHITE, EMPTY, initialBoard, legalMovesFor, applyMove, countStones, opponent, mulberry32, PLAYER_KEYS, MATCHES, simulateMatch, runSelfTests });',
    ctx,
    { filename: 'reversi-arena-core.js' },
  );
  return { api, src };
}

// ---------- 対局結果 → ログレコード ----------

function coord(r, c) { return 'abcdefgh'[c] + (r + 1); }

function buildRecord(api, job, res, ms) {
  const m = api.MATCHES[job.idx];
  let moves = '';
  let passes = 0;
  const foulPlies = [];
  res.history.forEach((h, ply) => {
    if (h.pass) { moves += '--'; passes++; return; }
    moves += coord(h.row, h.col);
    if (h.foul) foulPlies.push({ ply, by: h.color === api.BLACK ? 'black' : 'white', reason: h.reason });
  });
  return {
    v: SCHEMA_VERSION,
    ts: new Date().toISOString(),
    runId: job.runId,
    baseSeed: job.baseSeed,
    round: job.round,
    seed: job.seed,
    idx: job.idx,
    black: m.black,
    white: m.white,
    blackCount: res.black,
    whiteCount: res.white,
    winner: res.winner === api.BLACK ? m.black : res.winner === api.WHITE ? m.white : null,
    fouls: { black: res.fouls[api.BLACK], white: res.fouls[api.WHITE] },
    foulPlies,
    plies: res.history.length,
    passes,
    moves,
    ms,
  };
}

// ---------- ワーカー ----------

if (!isMainThread) {
  const { api } = loadEngine();
  parentPort.on('message', (msg) => {
    if (msg.type === 'job') {
      const t0 = Date.now();
      const res = api.simulateMatch(msg.seed, msg.idx);
      parentPort.postMessage({ type: 'done', record: buildRecord(api, msg, res, Date.now() - t0) });
    } else if (msg.type === 'exit') {
      process.exit(0);
    }
  });
  parentPort.postMessage({ type: 'ready' });
}

// ---------- 集計 ----------

function aggregate(records) {
  const stats = {};
  const h2h = {};
  const stat = (k) => (stats[k] ??= { pts: 0, w: 0, d: 0, l: 0, stones: 0, fouls: 0, games: 0 });
  const vs = (a, b) => ((h2h[a] ??= {})[b] ??= { w: 0, d: 0, l: 0 });
  for (const r of records) {
    if (r.v !== SCHEMA_VERSION) continue;
    const sb = stat(r.black), sw = stat(r.white);
    sb.games++; sw.games++;
    sb.stones += r.blackCount; sw.stones += r.whiteCount;
    sb.fouls += r.fouls.black; sw.fouls += r.fouls.white;
    if (r.winner === null) {
      sb.pts += 1; sw.pts += 1; sb.d++; sw.d++;
      vs(r.black, r.white).d++; vs(r.white, r.black).d++;
    } else {
      const winKey = r.winner, loseKey = r.winner === r.black ? r.white : r.black;
      stat(winKey).pts += 3; stat(winKey).w++; stat(loseKey).l++;
      vs(winKey, loseKey).w++; vs(loseKey, winKey).l++;
    }
  }
  return { stats, h2h };
}

function printStandings(records) {
  const { stats, h2h } = aggregate(records);
  const keys = Object.keys(stats).sort((a, b) =>
    stats[b].pts - stats[a].pts || stats[b].stones - stats[a].stones || a.localeCompare(b));

  const rows = [['#', 'player', 'pts', 'W', 'D', 'L', 'stones', 'fouls', 'games']];
  keys.forEach((k, i) => {
    const s = stats[k];
    rows.push([String(i + 1), k, String(s.pts), String(s.w), String(s.d), String(s.l), String(s.stones), String(s.fouls), String(s.games)]);
  });
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const r of rows) console.log('  ' + r.map((v, c) => v.padEnd(widths[c])).join('  '));

  console.log('\n  直接対決 (行プレイヤーから見た W-D-L):');
  const cellW = Math.max(8, ...keys.map((k) => k.length));
  console.log('  ' + ''.padEnd(cellW) + '  ' + keys.map((k) => k.padEnd(cellW)).join('  '));
  for (const a of keys) {
    const cells = keys.map((b) => {
      if (a === b) return '-'.padEnd(cellW);
      const v = h2h[a]?.[b] ?? { w: 0, d: 0, l: 0 };
      return `${v.w}-${v.d}-${v.l}`.padEnd(cellW);
    });
    console.log('  ' + a.padEnd(cellW) + '  ' + cells.join('  '));
  }
  return { stats, h2h, order: keys };
}

// ---------- ログ読み込み ----------

function collectLogFiles(paths) {
  const files = [];
  for (const p of paths) {
    const full = path.resolve(ROOT, p);
    if (!fs.existsSync(full)) { console.error(`警告: ${p} が存在しません`); continue; }
    if (fs.statSync(full).isFile()) { files.push(full); continue; }
    for (const f of fs.readdirSync(full, { recursive: true })) {
      if (String(f).endsWith('.jsonl')) files.push(path.join(full, String(f)));
    }
  }
  return files.sort();
}

function readRecords(files) {
  const records = [];
  let corrupt = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { corrupt++; }
    }
  }
  if (corrupt) console.error(`警告: 破損行 ${corrupt} 行をスキップしました(書き込み中断の残骸の可能性)`);
  return records;
}

// ---------- run ----------

async function cmdRun(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      rounds: { type: 'string', default: '100' },
      workers: { type: 'string' },
      out: { type: 'string', default: 'logs' },
      'base-seed': { type: 'string' },
    },
  });
  const rounds = parseInt(values.rounds, 10);
  const workers = values.workers
    ? parseInt(values.workers, 10)
    : Math.max(1, Math.min(12, os.cpus().length - 4));
  if (!Number.isInteger(rounds) || rounds <= 0) throw new Error('--rounds は正の整数で指定してください');

  const { api, src } = loadEngine();

  // セルフテストゲート: エンジンが壊れた状態で大量実行しない
  const tests = api.runSelfTests();
  const failed = tests.filter((t) => !t.pass);
  if (failed.length) {
    for (const t of failed) console.error(`セルフテスト失敗: ${t.name} — ${t.detail}`);
    process.exit(1);
  }

  // シードは起動時刻ミリ秒ベース(実行のたびに衝突しない)。ラウンドkのシードは (base+k)>>>0
  const baseSeed = values['base-seed'] ? Number(values['base-seed']) : Date.now();
  const runId = `run-${baseSeed}`;
  const outDir = path.resolve(ROOT, values.out, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, 'games.jsonl');
  const metaPath = path.join(outDir, 'meta.json');

  let gitSha = null;
  try { gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch {}
  const meta = {
    runId, baseSeed, rounds,
    gamesTotal: rounds * api.MATCHES.length,
    workers,
    players: api.PLAYER_KEYS,
    schemaVersion: SCHEMA_VERSION,
    node: process.version,
    gitSha,
    engineSha256: crypto.createHash('sha256').update(src).digest('hex').slice(0, 16),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  const jobs = [];
  for (let k = 0; k < rounds; k++) {
    const seed = (baseSeed + k) >>> 0;
    for (let idx = 0; idx < api.MATCHES.length; idx++) jobs.push({ type: 'job', runId, baseSeed, round: k, seed, idx });
  }

  console.log(`${runId}: ${jobs.length}局 (${rounds}ラウンド×${api.MATCHES.length}カード) をワーカー${workers}本で開始`);
  console.log(`ログ: ${path.relative(ROOT, logPath)}`);

  const fd = fs.openSync(logPath, 'a');
  const records = [];
  const t0 = Date.now();
  let next = 0, done = 0, fouls = 0, exited = 0;

  const progress = () => {
    const dt = (Date.now() - t0) / 1000;
    const rate = done / Math.max(dt, 1e-9);
    const eta = rate > 0 ? Math.round((jobs.length - done) / rate) : 0;
    console.log(`  ${done}/${jobs.length}局 (${rate.toFixed(1)}局/s, 残り約${Math.floor(eta / 60)}分${eta % 60}秒, 反則${fouls})`);
  };
  const timer = setInterval(progress, 15000);

  await new Promise((resolve, reject) => {
    const pool = [];
    for (let w = 0; w < workers; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url));
      pool.push(worker);
      const dispatch = () => {
        if (next < jobs.length) worker.postMessage(jobs[next++]);
        else worker.postMessage({ type: 'exit' });
      };
      worker.on('message', (msg) => {
        if (msg.type === 'ready') return dispatch();
        if (msg.type === 'done') {
          const r = msg.record;
          fs.writeSync(fd, JSON.stringify(r) + '\n'); // 1局ごとに追記=途中クラッシュでも完了分は保全
          records.push(r);
          done++;
          fouls += r.fouls.black + r.fouls.white;
          dispatch();
        }
      });
      worker.on('error', (err) => { clearInterval(timer); reject(err); });
      worker.on('exit', () => { if (++exited === pool.length) resolve(); });
    }
  });

  clearInterval(timer);
  fs.closeSync(fd);
  progress();

  const { stats } = aggregate(records);
  meta.finishedAt = new Date().toISOString();
  meta.durationMs = Date.now() - t0;
  meta.gamesDone = done;
  meta.foulsTotal = fouls;
  meta.standings = stats;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`\n完了: ${done}局 / ${(meta.durationMs / 1000 / 60).toFixed(1)}分\n`);
  printStandings(records);
  console.log(`\nログ: ${path.relative(ROOT, logPath)}`);
}

// ---------- standings ----------

function cmdStandings(argv) {
  const files = collectLogFiles(argv.length ? argv : ['logs']);
  if (!files.length) { console.error('ログファイル(.jsonl)が見つかりません'); process.exit(1); }
  const records = readRecords(files);
  console.log(`${files.length}ファイル / ${records.length}局を集計:\n`);
  printStandings(records);
}

// ---------- verify ----------

function cmdVerify(argv) {
  const { api } = loadEngine();
  const files = collectLogFiles(argv.length ? argv : ['logs']);
  if (!files.length) { console.error('ログファイル(.jsonl)が見つかりません'); process.exit(1); }
  const records = readRecords(files);
  let bad = 0;
  for (const r of records) {
    const fail = (msg) => { bad++; console.error(`NG ${r.runId} seed=${r.seed} idx=${r.idx}: ${msg}`); };
    try {
      const board = api.initialBoard();
      let cur = api.BLACK;
      const tokens = r.moves.match(/.{2}/g) ?? [];
      for (const tk of tokens) {
        if (tk === '--') {
          if (api.legalMovesFor(board, cur).length !== 0) { fail('合法手があるのにパスが記録されている'); break; }
        } else {
          const row = Number(tk[1]) - 1, col = 'abcdefgh'.indexOf(tk[0]);
          if (!api.legalMovesFor(board, cur).some((m) => m.row === row && m.col === col)) { fail(`非合法手 ${tk}`); break; }
          api.applyMove(board, cur, row, col);
        }
        cur = api.opponent(cur);
      }
      const s = api.countStones(board);
      if (s.black !== r.blackCount || s.white !== r.whiteCount) fail(`石数不一致 記録${r.blackCount}-${r.whiteCount} 再生${s.black}-${s.white}`);
      if (api.legalMovesFor(board, api.BLACK).length || api.legalMovesFor(board, api.WHITE).length) fail('終局していない棋譜');
      const w = s.black > s.white ? r.black : s.white > s.black ? r.white : null;
      if (w !== r.winner) fail(`勝者不一致 記録${r.winner} 再生${w}`);
    } catch (e) {
      fail(`再生中に例外: ${e.message}`);
    }
  }
  console.log(bad === 0 ? `OK: ${records.length}局すべて棋譜再生・石数・勝敗が一致` : `NG: ${bad}/${records.length}局に不整合`);
  if (bad) process.exit(1);
}

// ---------- エントリポイント ----------

if (isMainThread) {
  const [cmd, ...rest] = process.argv.slice(2);
  const usage = 'usage: node tools/arena.mjs <run|standings|verify> [options]';
  try {
    if (cmd === 'run') await cmdRun(rest);
    else if (cmd === 'standings') cmdStandings(rest);
    else if (cmd === 'verify') cmdVerify(rest);
    else { console.error(usage); process.exit(cmd ? 1 : 0); }
  } catch (e) {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  }
}
