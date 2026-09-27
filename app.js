/**
 * ブルーアーカイブ リアルタイムガチャ集計 (BA Gacha Live Tracker)
 * Version: v1.0.19
 * Core Application Logic & State Management
 */

const APP_VERSION = 'v1.0.19';
const REMOTE_STUDENT_ICONS_URL = 'https://raw.githubusercontent.com/roundabout-oxygen/ba_gacha_tabulation/main/data/student_icons.json';

// 単発 (1連) モードかどうかのフラグ (false = 10連モード, true = 1連モード)
let isSinglePullMode = false;

// アプリケーション全体の状態管理
const AppState = {
  // ガチャ設定
  config: {
    rate: 0.03, // 0.03 (通常) or 0.06 (フェス)
    initCharge: 0, // 開始前の引継ぎチャージ数 (0〜199)
    pickupStudents: [] // ピックアップ対象生徒の配列
  },

  // 履歴データ（1連ごとの記録配列）
  pulls: [],

  // 生徒アイコン辞書 (Wiki正規データ + 仮登録データ)
  officialStudents: {}, // Wiki公式生徒 { "生徒名": "画像URL", ... }
  customStudents: {},   // 新規生徒仮登録 { "生徒名": { icon: "data:image/...", createdAt: "...", wikiSynced: false } }

  // 現在の入力シートセッション
  currentSession: {
    pullCount: 10,
    rows: [],
    editingBatchId: null // 再編集中のバッチID (null のときは新規引き)
  },

  // Chart.js インスタンス
  chartInstance: null,

  // カラーテーマ
  theme: 'theme-cyan-light'
};

// 設定モーダル用の一時退避設定（キャンセル用）
let tempSettingsConfig = null;

// ==========================================================================
// ユーティリティ関数（平仮名・カタカナ変換、正規化）
// ==========================================================================

function hiraganaToKatakana(str) {
  if (!str) return '';
  return str.replace(/[\u3041-\u3096]/g, match => {
    const charCode = match.charCodeAt(0) + 0x60;
    return String.fromCharCode(charCode);
  });
}

function katakanaToHiragana(str) {
  if (!str) return '';
  return str.replace(/[\u30a1-\u30f6]/g, match => {
    const charCode = match.charCodeAt(0) - 0x60;
    return String.fromCharCode(charCode);
  });
}

function normalizeStudentName(name) {
  if (!name) return '';
  let res = name.trim();
  res = res.replace(/\(/g, '（').replace(/\)/g, '）');
  return res;
}

// ==========================================================================
// 初期化 & ライフサイクル
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  // バージョンバッジ更新
  const versionBadge = document.getElementById('appVersionBadge');
  if (versionBadge) versionBadge.textContent = APP_VERSION;

  // ローカルストレージ読込
  loadSavedState();

  // テーマ適用
  applyTheme(AppState.theme);

  // イベントリスナー初期化
  initEventListeners();

  // 切り抜きエンジン初期化
  initCropperEngine();

  // デフォルトでガチャシートの準備（初回10連）
  setupInputSheet(10);

  // 初回ダッシュボード描画
  updateAllStats();
  renderConvergenceChart();

  // URLパラメータの解釈 (テスト・自動検証用)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('demo') === '1') {
    loadDemoGachaData();
  }

  const tabParam = urlParams.get('tab');
  if (tabParam === 'gacha') {
    switchTab('tabGacha');
  } else if (tabParam === 'settings') {
    openSettingsModal();
  } else if (tabParam === 'custom') {
    document.getElementById('modalCustomStudent').showModal();
  }

  // 生徒図鑑データの自動同期取得（バックグラウンド非同期）
  loadStudentDictionaries().then(() => {
    renderDirectoryGrid();
    renderCustomStudentsTableIfOpen();
  });
});

function renderCustomStudentsTableIfOpen() {
  // 必要に応じて図鑑などを更新
}

/**
 * 添付2枚目を完全再現したデモデータ投入（テスト・検証用）
 */
function loadDemoGachaData() {
  AppState.config.rate = 0.03;
  AppState.config.initCharge = 94; // 添付2枚目: 累計1〜10、チャージ95〜104
  AppState.config.pickupStudents = ['ココロ'];

  // 30連分のガチャ履歴（1〜30連）
  // 10連目: 6人目にヒナ(100連目50%すり抜け)、10人目にココロ(PU獲得)
  // 20連目: 5人目にネル（制服）(新規獲得)
  // 30連目: 3人目にネル（制服）(2回目被り)、9人目にヒナ(2回目被り)
  const names = [
    '', '', '', '', '', 'ヒナ', '', '', '', 'ココロ',
    '', '', '', '', 'ネル（制服）', '', '', '', '', '',
    '', '', 'ネル（制服）', '', '', '', '', '', 'ヒナ', ''
  ];

  let runningCharge = 94;
  const demoPulls = [];

  for (let i = 0; i < names.length; i++) {
    const seqInBatch = (i % 10) + 1;
    const batchIndex = Math.floor(i / 10) + 1;
    const totalIndex = i + 1;
    runningCharge += 1;

    const name = names[i];
    const isPick = (name === 'ココロ');
    const isThreeStar = Boolean(name);
    const isGuaranteed50 = (runningCharge === 100);

    // 過去に登場したか判定
    const isAlreadyPulled = demoPulls.some(p => p.studentName === name);

    demoPulls.push({
      id: totalIndex,
      pullType: '10',
      batchId: `demo_batch_${batchIndex}`,
      seqInBatch: seqInBatch,
      totalPullIndex: totalIndex,
      charge: runningCharge,
      studentName: name,
      isThreeStar: isThreeStar,
      isPick: isPick,
      isNew: isThreeStar && !isAlreadyPulled,
      isGuaranteed50: isGuaranteed50,
      isGuaranteed100: false,
      createdAt: new Date().toISOString()
    });

    if (isPick) runningCharge = 0;
  }

  AppState.pulls = demoPulls;
  persistState();
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
  setupInputSheet(10);
}

// ==========================================================================
// ストレージ保存・読み込み
// ==========================================================================

function loadSavedState() {
  try {
    const savedConfig = localStorage.getItem('ba_gacha_config');
    if (savedConfig) {
      AppState.config = Object.assign(AppState.config, JSON.parse(savedConfig));
    }
    const savedPulls = localStorage.getItem('ba_gacha_pulls');
    if (savedPulls) {
      AppState.pulls = JSON.parse(savedPulls);
    }
    const savedCustom = localStorage.getItem('ba_custom_students');
    if (savedCustom) {
      AppState.customStudents = JSON.parse(savedCustom);
    }
    const savedTheme = localStorage.getItem('ba_gacha_theme');
    if (savedTheme) {
      AppState.theme = savedTheme;
    }
  } catch (err) {
    console.error('Failed to load state from localStorage:', err);
  }
}

function persistState() {
  try {
    localStorage.setItem('ba_gacha_config', JSON.stringify(AppState.config));
    localStorage.setItem('ba_gacha_pulls', JSON.stringify(AppState.pulls));
    localStorage.setItem('ba_custom_students', JSON.stringify(AppState.customStudents));
    localStorage.setItem('ba_gacha_theme', AppState.theme);
  } catch (err) {
    console.error('Failed to persist state:', err);
  }
}

function applyTheme(themeName) {
  AppState.theme = themeName;
  if (themeName === 'theme-tactical-dark') {
    document.body.classList.remove('theme-cyan-light');
    document.body.classList.add('theme-tactical-dark');
  } else {
    document.body.classList.remove('theme-tactical-dark');
    document.body.classList.add('theme-cyan-light');
  }
  const btnCyan = document.getElementById('btnThemeCyan');
  const btnDark = document.getElementById('btnThemeDark');
  if (btnCyan && btnDark) {
    if (themeName === 'theme-tactical-dark') {
      btnDark.classList.add('active');
      btnCyan.classList.remove('active');
    } else {
      btnCyan.classList.add('active');
      btnDark.classList.remove('active');
    }
  }
}

// ==========================================================================
// 生徒図鑑データの自動同期取得（GitHub Raw優先）
// ==========================================================================

async function loadStudentDictionaries() {
  // 1. ローカルの data/student_icons.json を即座に先行読み込み（即時サジェスト可能にする）
  try {
    const localRes = await fetch('data/student_icons.json');
    if (localRes.ok) {
      AppState.officialStudents = await localRes.json();
      console.log('Loaded student icons from local.');
    }
  } catch (err) {
    console.warn('Could not load local student_icons.json fallback:', err);
  }

  // 2. ローカルの仮登録データ (data/custom_students.json) があればマージ
  try {
    const resCustom = await fetch('data/custom_students.json');
    if (resCustom.ok) {
      const remoteCustom = await resCustom.json();
      if (remoteCustom && remoteCustom.students) {
        AppState.customStudents = Object.assign({}, remoteCustom.students, AppState.customStudents);
      }
    }
  } catch (e) {
    // 省略可
  }

  // 3. バックグラウンドで GitHub (roundabout-oxygen/ba_gacha_tabulation) から最新差分を自動フェッチ
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(REMOTE_STUDENT_ICONS_URL, { cache: 'no-cache', signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      AppState.officialStudents = await res.json();
      console.log('Updated student icons from GitHub.');
    }
  } catch (err) {
    // オフラインまたはタイムアウト時はローカル辞書をそのまま継続利用
  }

  // 4. 重複自動クリーンアップ
  cleanupSyncedCustomStudents(false);
}

function cleanupSyncedCustomStudents(showNotification = false) {
  const removedNames = [];
  const customKeys = Object.keys(AppState.customStudents);

  customKeys.forEach(name => {
    const norm = normalizeStudentName(name);
    if (AppState.officialStudents[norm] || AppState.officialStudents[name]) {
      removedNames.push(name);
      delete AppState.customStudents[name];
    }
  });

  if (removedNames.length > 0) {
    persistState();
    if (showNotification) {
      alert(`【図鑑同期】公式図鑑に追加されたため、以下の仮登録生徒が自動移行されました：\n\n・${removedNames.join('\n・')}`);
    }
  } else if (showNotification) {
    alert('【図鑑同期】図鑑データは最新です。重複している仮登録生徒はありませんでした。');
  }
}

function getStudentIconUrl(studentName) {
  if (!studentName) return '';
  const norm = normalizeStudentName(studentName);

  if (AppState.customStudents[norm] && AppState.customStudents[norm].icon) {
    return AppState.customStudents[norm].icon;
  }
  if (AppState.customStudents[studentName] && AppState.customStudents[studentName].icon) {
    return AppState.customStudents[studentName].icon;
  }
  if (AppState.officialStudents[norm]) {
    return AppState.officialStudents[norm];
  }
  if (AppState.officialStudents[studentName]) {
    return AppState.officialStudents[studentName];
  }
  return '';
}

function searchStudents(query) {
  if (!query || !query.trim()) return [];
  const q = query.trim();
  const qKatakana = hiraganaToKatakana(q);
  const qHiragana = katakanaToHiragana(q);

  const allNames = Array.from(new Set([
    ...Object.keys(AppState.customStudents),
    ...Object.keys(AppState.officialStudents)
  ]));

  const startsWithMatches = [];
  const includesMatches = [];

  allNames.forEach(name => {
    const normName = normalizeStudentName(name);
    const nameHiragana = katakanaToHiragana(normName);

    if (
      normName.startsWith(q) ||
      normName.startsWith(qKatakana) ||
      nameHiragana.startsWith(qHiragana)
    ) {
      startsWithMatches.push(normName);
    } else if (
      normName.includes(q) ||
      normName.includes(qKatakana) ||
      nameHiragana.includes(qHiragana)
    ) {
      includesMatches.push(normName);
    }
  });

  return [...startsWithMatches, ...includesMatches].slice(0, 15);
}

// ==========================================================================
// タブ切り替え & ナビゲーション
// ==========================================================================

function switchTab(tabId) {
  const tabBtns = document.querySelectorAll('#mainTabsNav .nav-tab-btn');
  tabBtns.forEach(btn => {
    if (btn.getAttribute('data-tab') === tabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  const tabContents = document.querySelectorAll('.tab-view-content');
  tabContents.forEach(content => {
    if (content.id === tabId) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });

  if (tabId === 'tabDashboard') {
    updateAllStats();
    renderDirectoryGrid();
    renderConvergenceChart();
  } else if (tabId === 'tabGacha') {
    const batches = getAllBatches();
    if (batches.length > 0) {
      if (!AppState.currentSession.editingBatchId || !batches.includes(AppState.currentSession.editingBatchId)) {
        loadBatchById(batches[batches.length - 1]);
      } else {
        applyPullModeUI();
      }
    } else {
      if (!AppState.currentSession.rows || AppState.currentSession.rows.length === 0) {
        setupInputSheet();
      } else {
        applyPullModeUI();
      }
    }
  } else if (tabId === 'tabHistory') {
    renderHistoryTable();
  } else if (tabId === 'tabSettings') {
    syncSettingsTabInputs();
  }
}

// ==========================================================================
// チャージ計算ロジック
// ==========================================================================

/**
 * 全ての引き（確定済み履歴 ＋ 現在編集中または新規のシート内容）を時系列順にシミュレートし、
 * 正確に再計算された pulls 配列を返す。
 * これにより、過去のバッチを再編集中に pick を変更した場合でも、
 * その後の全バッチおよび最終ページの最下段チャージまで即座に正確に反映される。
 */
function getSimulatedAllPulls() {
  const pulls = [];
  const currentEditingId = AppState.currentSession ? AppState.currentSession.editingBatchId : null;
  const currentRows = (AppState.currentSession && AppState.currentSession.rows) ? AppState.currentSession.rows : [];
  const validCurrentRows = isSinglePullMode ? (currentRows[0] ? [currentRows[0]] : []) : currentRows;

  if (currentEditingId) {
    // 過去のバッチを再編集・閲覧中
    const batches = getAllBatches();
    batches.forEach(bId => {
      if (bId === currentEditingId) {
        validCurrentRows.forEach(r => {
          if (r) {
            pulls.push({
              totalPullIndex: r.total,
              isPick: Boolean(r.isPick),
              studentName: r.studentName ? normalizeStudentName(r.studentName) : '',
              isThreeStar: Boolean(r.studentName && r.studentName.trim()),
              isNew: Boolean(r.isNew)
            });
          }
        });
      } else {
        const batchItems = AppState.pulls.filter(p => p.batchId === bId);
        batchItems.forEach(p => pulls.push({ ...p }));
      }
    });
  } else {
    // editingBatchId がない場合: 確定済みの AppState.pulls のみをクローン
    // 未確定の空シート行を勝手に末尾に追加してはならない！
    AppState.pulls.forEach(p => pulls.push({ ...p }));

    // まだ pulls が0件で、かつシートに入力（生徒名またはpick）がある場合のみ反映
    if (AppState.pulls.length === 0) {
      const hasInput = validCurrentRows.some(r => r && ((r.studentName && r.studentName.trim()) || r.isPick));
      if (hasInput) {
        validCurrentRows.forEach(r => {
          if (r) {
            pulls.push({
              totalPullIndex: r.total,
              isPick: Boolean(r.isPick),
              studentName: r.studentName ? normalizeStudentName(r.studentName) : '',
              isThreeStar: Boolean(r.studentName && r.studentName.trim()),
              isNew: Boolean(r.isNew)
            });
          }
        });
      }
    }
  }

  // もし引きが一切なければ空配列
  if (pulls.length === 0) return [];

  // チャージと連番を時系列順に完全再計算
  let runningCharge = Number(AppState.config.initCharge) || 0;
  pulls.forEach((p, idx) => {
    p.totalPullIndex = idx + 1;
    runningCharge += 1;
    p.charge = runningCharge;
    if (p.isPick || runningCharge === 200) {
      runningCharge = 0;
    }
  });

  return pulls;
}

/**
 * 直前までのチャージ数を計算
 */
function calculateCurrentCharge() {
  const simulatedPulls = getSimulatedAllPulls();
  if (simulatedPulls.length > 0) {
    return simulatedPulls[simulatedPulls.length - 1].charge;
  }
  return Number(AppState.config.initCharge) || 0;
}

/**
 * 最終ページの最下段（最新の引きの最終行）におけるチャージ数を取得
 * ユーザー要望: 「上に表示されているチャージは最終ページの最下段のチャージを表示してください。
 * 前の10連へで表示を前に戻すと変化しますがそうならないようにお願いします」
 */
function getActiveDisplayCharge() {
  const simulatedPulls = getSimulatedAllPulls();
  if (simulatedPulls.length > 0) {
    return simulatedPulls[simulatedPulls.length - 1].charge;
  }
  return Number(AppState.config.initCharge) || 0;
}

/**
 * 現在のシート内のチャージ数・50%天井行のハイライト・上部集計バーを即時再計算
 * pickチェックボックスの変更時や生徒名入力時に即座に呼ばれる
 */
function recalculateCurrentSessionCharges() {
  if (!AppState.currentSession.rows || AppState.currentSession.rows.length === 0) return;

  // 開始直前のチャージ数を取得
  let startCharge = 0;
  const currentEditingId = AppState.currentSession.editingBatchId;
  if (currentEditingId) {
    const batches = getAllBatches();
    const currentIdx = batches.indexOf(currentEditingId);
    if (currentIdx > 0) {
      const prevBatchId = batches[currentIdx - 1];
      const prevPulls = AppState.pulls.filter(p => p.batchId === prevBatchId);
      if (prevPulls.length > 0) {
        startCharge = prevPulls[prevPulls.length - 1].charge;
      }
    } else {
      startCharge = Number(AppState.config.initCharge) || 0;
    }
  } else {
    if (AppState.pulls.length > 0) {
      startCharge = AppState.pulls[AppState.pulls.length - 1].charge;
    } else {
      startCharge = Number(AppState.config.initCharge) || 0;
    }
  }

  let runningCharge = startCharge;
  const tbody = document.getElementById('gachaSheetTbody');
  const trList = tbody ? tbody.querySelectorAll('tr') : [];

  AppState.currentSession.rows.forEach((row, idx) => {
    runningCharge += 1;
    row.charge = runningCharge;
    row.isGuaranteed50 = (runningCharge === 100);
    row.isGuaranteed100 = (runningCharge === 200);

    // DOM更新
    if (trList[idx]) {
      const tr = trList[idx];
      const tdCharge = tr.querySelector('.col-charge');
      if (tdCharge) {
        let label = runningCharge;
        if (runningCharge === 100) label += ' (50%)';
        else if (runningCharge === 200) label = '200天井';
        tdCharge.textContent = label;

        if (runningCharge > 100) {
          tdCharge.classList.add('charge-danger');
        } else {
          tdCharge.classList.remove('charge-danger');
        }
      }

      if (runningCharge === 100 || runningCharge === 200) {
        tr.classList.add('row-charge-100');
      } else {
        tr.classList.remove('row-charge-100');
      }
    }

    // pickに☑が入っていれば、次の行のガチャはチャージ1から開始！
    if (row.isPick || runningCharge === 200) {
      runningCharge = 0;
    }
  });

  // 上部の集計データ（☆3確率、PU確率、最終ページ最下段チャージ数等）も即時反映！
  updateAllStats();
}

// ==========================================================================
// 作戦記録シート (タブ2: ガチャを引く) & バッチ再編集・削除
// ==========================================================================

/**
 * pulls 内のバッチID一覧を時系列順に取得
 */
function getAllBatches() {
  const batches = [];
  const seen = new Set();
  AppState.pulls.forEach(p => {
    if (p.batchId && !seen.has(p.batchId)) {
      seen.add(p.batchId);
      batches.push(p.batchId);
    }
  });
  return batches;
}

/**
 * 入力シートの初期セットアップ (常に10行生成し、1連モード時は2〜10連目をグレーアウト)
 * 新規入力セッションを開始
 */
function setupInputSheet() {
  AppState.currentSession.editingBatchId = null;
  AppState.currentSession.pullCount = isSinglePullMode ? 1 : 10;
  const currentTotal = AppState.pulls.length;
  let runningCharge = calculateCurrentCharge();

  const rows = [];
  for (let i = 0; i < 10; i++) {
    const seq = i + 1;
    const total = currentTotal + seq;
    runningCharge += 1;
    const chargeVal = runningCharge;
    const isGuaranteed50 = (chargeVal === 100);
    const isGuaranteed100 = (chargeVal === 200);

    rows.push({
      seq: seq,
      total: total,
      charge: chargeVal,
      studentName: '',
      isPick: false,
      isNew: false,
      isGuaranteed50: isGuaranteed50,
      isGuaranteed100: isGuaranteed100
    });

    if (chargeVal === 200) {
      runningCharge = 0;
    }
  }

  AppState.currentSession.rows = rows;
  renderInputSheetTable();
  updateAllStats();
  updateSheetPageIndicator();
}

/**
 * =========================================================================
 * 視覚的タイムライン＆ページナビゲーター (添付画像準拠: 節目クリックでジャンプ・☆3ドット表示)
 * =========================================================================
 */


/**
 * バッチインデックス (0, 1, 2... targetIdx) へ直接ジャンプする処理
 * 青いレールをクリックした際や、目盛りクリック時に直接該当ページへ移動
 */
function jumpToBatchByIndex(targetIdx) {
  // 現在シートに入力があれば自動保存
  const rows = AppState.currentSession.rows || [];
  const hasInput = rows.some(r => (r.studentName && r.studentName.trim()) || r.isPick);
  if (AppState.currentSession.editingBatchId || hasInput) {
    commitCurrentSheet();
  }

  const batches = getAllBatches();
  if (batches.length === 0) return;

  const currentEditingId = AppState.currentSession.editingBatchId;
  const currentIdx = currentEditingId ? batches.indexOf(currentEditingId) : (batches.length - 1);
  const clampedIdx = Math.max(0, Math.min(batches.length - 1, targetIdx));

  const targetBatchId = batches[clampedIdx];
  if (targetBatchId) {
    loadBatchById(targetBatchId);
    triggerSheetSlideAnimation(clampedIdx >= currentIdx ? 'right' : 'left');
    renderSheetTimelineNav();
  }
}

/**
 * 指定した連番 (targetPullNumber) を含むバッチへジャンプする処理
 */
function jumpToPullBatch(targetPullNumber) {
  // 現在シートに入力があれば自動保存
  const rows = AppState.currentSession.rows || [];
  const hasInput = rows.some(r => (r.studentName && r.studentName.trim()) || r.isPick);
  if (AppState.currentSession.editingBatchId || hasInput) {
    commitCurrentSheet();
  }

  const batches = getAllBatches();
  const currentEditingId = AppState.currentSession.editingBatchId;
  const currentIdx = currentEditingId ? batches.indexOf(currentEditingId) : batches.length;

  // targetPullNumber を含むバッチを探す
  const targetPull = AppState.pulls.find(p => p.totalPullIndex === targetPullNumber);
  if (targetPull && targetPull.batchId) {
    const targetIdx = batches.indexOf(targetPull.batchId);
    if (targetIdx !== -1) {
      loadBatchById(targetPull.batchId);
      triggerSheetSlideAnimation(targetIdx >= currentIdx ? 'right' : 'left');
      renderSheetTimelineNav();
      return;
    }
  }

  // もしターゲットが pulls の最大連数以上なら最新バッチへ
  if (targetPullNumber > AppState.pulls.length || batches.length === 0) {
    if (batches.length > 0) {
      loadBatchById(batches[batches.length - 1]);
    } else {
      setupInputSheet();
    }
    triggerSheetSlideAnimation('right');
    renderSheetTimelineNav();
    return;
  }

  // バッチが見つからない場合、もっとも近いバッチを探す
  let closestBatchId = batches[0];
  let minDiff = Infinity;
  batches.forEach(bId => {
    const bPulls = AppState.pulls.filter(p => p.batchId === bId);
    if (bPulls.length > 0) {
      const avg = (bPulls[0].totalPullIndex + bPulls[bPulls.length - 1].totalPullIndex) / 2;
      const diff = Math.abs(avg - targetPullNumber);
      if (diff < minDiff) {
        minDiff = diff;
        closestBatchId = bId;
      }
    }
  });

  if (closestBatchId) {
    const targetIdx = batches.indexOf(closestBatchId);
    loadBatchById(closestBatchId);
    triggerSheetSlideAnimation(targetIdx >= currentIdx ? 'right' : 'left');
    renderSheetTimelineNav();
  }
}

/**
 * ページ位置＆タイムライン更新 (updateSheetPageIndicator の完全上位互換)
 */
function updateSheetPageIndicator() {
  renderSheetTimelineNav();
}

function renderSheetTimelineNav() {
  const navContainer = document.getElementById('sheetTimelineNav');
  if (!navContainer) return;

  const minBoundEl = document.getElementById('timelineMinBound');
  const maxBoundEl = document.getElementById('timelineMaxBound');
  const badgeEl = document.getElementById('sheetPageIndicator');
  const trackWrap = document.getElementById('timelineTrackWrap');
  const activeRangeEl = document.getElementById('timelineActiveRange');
  const pinEl = document.getElementById('timelineCurrentPin');
  const ticksLayer = document.getElementById('timelineTicksLayer');
  const starsLayer = document.getElementById('timelineStarsLayer');

  const batches = getAllBatches();
  const currentEditingId = AppState.currentSession.editingBatchId;
  const isSingle = isSinglePullMode;
  const unitLabel = isSingle ? '連' : 'ページ';

  // 1. 現在の編集ページ番号と総ページ数の算出
  let totalPages = batches.length;
  let currentPage = 1;
  let currentBatchIdx = -1;

  if (currentEditingId) {
    const idx = batches.indexOf(currentEditingId);
    currentPage = idx !== -1 ? (idx + 1) : 1;
    currentBatchIdx = idx !== -1 ? idx : 0;
    if (totalPages === 0) totalPages = 1;
  } else {
    // 新規入力中（最新ページ）
    totalPages = batches.length + 1;
    currentPage = totalPages;
    currentBatchIdx = batches.length; // 末尾
  }

  if (badgeEl) {
    badgeEl.textContent = `${currentPage} / ${totalPages} ${unitLabel}`;
  }

  // 2. タイムラインの最大連数 (timelineMaxLimit) の算出
  // 履歴の最大連数、または現在入力中の最大連数
  let maxPulls = AppState.pulls.length;
  if (!currentEditingId && AppState.currentSession && AppState.currentSession.rows && AppState.currentSession.rows.length > 0) {
    const validRows = isSingle ? [AppState.currentSession.rows[0]] : AppState.currentSession.rows;
    if (validRows[validRows.length - 1]) {
      maxPulls = Math.max(maxPulls, validRows[validRows.length - 1].total);
    }
  }
  maxPulls = Math.max(10, maxPulls);
  // 10の倍数に切り上げ（例: 63連なら70連、10連なら10連、30連なら30連）
  const timelineMaxLimit = Math.max(10, Math.ceil(maxPulls / 10) * 10);

  if (minBoundEl) minBoundEl.textContent = '0';
  if (maxBoundEl) maxBoundEl.textContent = `${timelineMaxLimit}`;

  // 3. 現在表示中の範囲ハイライト & 赤いピン位置の計算
  let currentStartTotal = 0;
  let currentEndTotal = 10;
  if (AppState.currentSession && AppState.currentSession.rows && AppState.currentSession.rows.length > 0) {
    const validRows = isSingle ? [AppState.currentSession.rows[0]] : AppState.currentSession.rows;
    currentStartTotal = Math.max(0, validRows[0].total - 1);
    currentEndTotal = validRows[validRows.length - 1].total;
  } else {
    currentStartTotal = Math.max(0, currentBatchIdx * 10);
    currentEndTotal = currentStartTotal + (isSingle ? 1 : 10);
  }

  const startPct = Math.max(0, Math.min(100, (currentStartTotal / timelineMaxLimit) * 100));
  const endPct = Math.max(0, Math.min(100, (currentEndTotal / timelineMaxLimit) * 100));
  const widthPct = Math.max(2, endPct - startPct);
  const centerPct = (startPct + endPct) / 2;

  if (activeRangeEl) {
    activeRangeEl.style.left = `${startPct}%`;
    activeRangeEl.style.width = `${widthPct}%`;
  }
  if (pinEl) {
    pinEl.style.left = `${centerPct}%`;
  }

  // 4. オレンジの節目（10連毎の区切り目盛り）を描画
  if (ticksLayer) {
    ticksLayer.innerHTML = '';
    const numSteps = Math.floor(timelineMaxLimit / 10);
    for (let step = 1; step <= numSteps; step++) {
      const pullNum = step * 10;
      const pct = (pullNum / timelineMaxLimit) * 100;
      const tick = document.createElement('div');
      tick.className = 'timeline-tick';
      tick.style.left = `${pct}%`;
      tick.setAttribute('data-pull', pullNum);

      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToBatchByIndex(step - 1);
      });

      ticksLayer.appendChild(tick);
    }
  }

  // トラック全体（青いレール部分や区間余白）のクリックでも該当の10連へジャンプ
  if (trackWrap) {
    trackWrap.onclick = (e) => {
      if (e.target.classList.contains('timeline-star-dot')) {
        return;
      }
      const rect = trackWrap.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(0.999, clickX / rect.width));

      const batches = getAllBatches();
      if (batches.length > 0) {
        const targetIdx = Math.floor(ratio * batches.length);
        jumpToBatchByIndex(targetIdx);
      }
    };
  }

  // 5. 下側の☆３出現位置ドット (〇印) を描画
  if (starsLayer) {
    starsLayer.innerHTML = '';
    const threeStarPulls = [];

    // 確定済みの履歴から☆3を抽出
    AppState.pulls.forEach(p => {
      if (p.isThreeStar && p.studentName) {
        threeStarPulls.push(p);
      }
    });

    // 現在入力中のシートで入力されている☆3（未確定分も反映）
    if (AppState.currentSession && AppState.currentSession.rows) {
      const validRows = isSingle ? [AppState.currentSession.rows[0]] : AppState.currentSession.rows;
      validRows.forEach(r => {
        if (r.studentName && r.studentName.trim()) {
          const isAlreadyInHistory = currentEditingId && AppState.pulls.some(p => p.batchId === currentEditingId && p.totalPullIndex === r.total);
          if (!isAlreadyInHistory) {
            threeStarPulls.push({
              totalPullIndex: r.total,
              studentName: r.studentName,
              isPick: r.isPick,
              isNew: r.isNew,
              batchId: currentEditingId || 'current_unsaved'
            });
          }
        }
      });
    }

    threeStarPulls.forEach(p => {
      const dot = document.createElement('div');
      dot.className = 'timeline-star-dot';

      if (p.isPick) {
        dot.classList.add('dot-pickup');
      } else if (p.isNew) {
        dot.classList.add('dot-new');
      } else {
        dot.classList.add('dot-standard');
      }

      const pIdx = p.totalPullIndex || 1;
      const pct = Math.max(0, Math.min(100, (pIdx / timelineMaxLimit) * 100));
      dot.style.left = `${pct}%`;

      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToPullBatch(pIdx);
      });

      starsLayer.appendChild(dot);
    });
  }
}

/**
 * 行部分の横スライドアニメーションを実行 (direction: 'left' | 'right')
 */
function triggerSheetSlideAnimation(direction) {
  const tbody = document.getElementById('gachaSheetTbody');
  if (!tbody) return;
  tbody.classList.remove('slide-from-left', 'slide-from-right');
  void tbody.offsetWidth; // 強制リフローでアニメーションを再トリガー
  tbody.classList.add(direction === 'left' ? 'slide-from-left' : 'slide-from-right');
}

/**
 * 全 pull の totalPullIndex と charge を時系列順に再計算して整合性を維持
 */
function recalculatePullsIndexAndCharge() {
  let runningCharge = Number(AppState.config.initCharge) || 0;
  AppState.pulls.forEach((p, idx) => {
    p.totalPullIndex = idx + 1;
    runningCharge += 1;
    p.charge = runningCharge;
    if (p.isPick || runningCharge === 200) {
      runningCharge = 0;
    }
  });
}

/**
 * 指定した batchId のデータをシートに読み込む
 */
function loadBatchById(targetBatchId) {
  if (!targetBatchId) return;

  const batchPulls = AppState.pulls.filter(p => p.batchId === targetBatchId);
  if (batchPulls.length === 0) return;

  AppState.currentSession.editingBatchId = targetBatchId;
  AppState.currentSession.pullCount = batchPulls.length;
  isSinglePullMode = (batchPulls.length === 1);

  // シート行構築 (常に10行)
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const pullData = batchPulls[i];
    if (pullData) {
      rows.push({
        seq: pullData.seqInBatch || (i + 1),
        total: pullData.totalPullIndex,
        charge: pullData.charge,
        studentName: pullData.studentName || '',
        isPick: Boolean(pullData.isPick),
        isNew: Boolean(pullData.isNew),
        isGuaranteed50: Boolean(pullData.isGuaranteed50),
        isGuaranteed100: Boolean(pullData.isGuaranteed100)
      });
    } else {
      rows.push({
        seq: i + 1,
        total: (batchPulls[0] ? batchPulls[0].totalPullIndex + i : i + 1),
        charge: (batchPulls[0] ? batchPulls[0].charge + i : i + 1),
        studentName: '',
        isPick: false,
        isNew: false,
        isGuaranteed50: false,
        isGuaranteed100: false
      });
    }
  }

  AppState.currentSession.rows = rows;
  renderInputSheetTable();
  updateSheetPageIndicator();
  updateAllStats();
}

/**
 * 「◁ 前の10連へ」: 現在の入力を保存した上で、前の引きをシートに呼び戻して再編集可能にする
 */
function loadPreviousBatch() {
  const currentEditingId = AppState.currentSession.editingBatchId;
  const rows = AppState.currentSession.rows || [];
  const hasInput = rows.some(r => (r.studentName && r.studentName.trim()) || r.isPick);

  // 入力がある場合、または既存バッチ編集中なら確実に保存する！
  if (currentEditingId || hasInput) {
    commitCurrentSheet();
  }

  const batches = getAllBatches();
  if (batches.length === 0) return false;

  let targetBatchId = null;
  if (!currentEditingId) {
    // 新規入力から保存された場合、末尾が今保存したバッチなので、その前へ
    if (hasInput && batches.length >= 2) {
      targetBatchId = batches[batches.length - 2];
    } else {
      targetBatchId = batches[batches.length - 1];
    }
  } else {
    // すでに過去のバッチを編集中: さらに1つ前のバッチへ
    const currentIdx = batches.indexOf(currentEditingId);
    if (currentIdx > 0) {
      targetBatchId = batches[currentIdx - 1];
    } else {
      return false; // 最古のバッチ
    }
  }

  if (targetBatchId) {
    loadBatchById(targetBatchId);
    return true;
  }
  return false;
}

/**
 * 「10連追加」: 押した時点で即座に10連（または1連）引いた状態（履歴確定・累計加算）にする
 * ユーザー要望: 「真ん中の画面では40連まで表示されているのに上の集計では累計30連になっている。
 * 10連追加を押した時点で10連引いた状態にしてください」
 */
function addNewBatchImmediately() {
  // 現在シートに入力中の内容があればまずコミット保存
  const rows = AppState.currentSession.rows || [];
  const hasInput = rows.some(r => (r.studentName && r.studentName.trim()) || r.isPick);
  if (AppState.currentSession.editingBatchId || hasInput) {
    commitCurrentSheet();
  }

  const count = isSinglePullMode ? 1 : 10;
  const pullType = isSinglePullMode ? '1' : '10';
  const batchId = 'batch_' + Date.now();
  const currentTotal = AppState.pulls.length;
  let runningCharge = calculateCurrentCharge();

  for (let i = 0; i < count; i++) {
    const seq = i + 1;
    const total = currentTotal + seq;
    runningCharge += 1;
    const chargeVal = runningCharge;
    const isGuaranteed50 = (chargeVal === 100);
    const isGuaranteed100 = (chargeVal === 200);

    AppState.pulls.push({
      id: total,
      pullType: pullType,
      batchId: batchId,
      seqInBatch: seq,
      totalPullIndex: total,
      charge: chargeVal,
      studentName: '',
      isThreeStar: false,
      isPick: false,
      isNew: false,
      isGuaranteed50: isGuaranteed50,
      isGuaranteed100: isGuaranteed100,
      createdAt: new Date().toISOString()
    });

    if (chargeVal === 200) {
      runningCharge = 0;
    }
  }

  // 整合性再計算＆永続化
  recalculatePullsIndexAndCharge();
  persistState();

  // 作成した最新のバッチをシートに読み込んで表示
  loadBatchById(batchId);
  triggerSheetSlideAnimation('right');
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
  renderSheetTimelineNav();
}

/**
 * 「この10連を削除」: 表示されているバッチを履歴から削除し、前の引きに戻る
 */
function deleteCurrentBatch() {
  const batches = getAllBatches();
  if (batches.length === 0 && !AppState.currentSession.editingBatchId) return;

  let targetBatchId = AppState.currentSession.editingBatchId;
  if (!targetBatchId) {
    // 新規入力中なら直前のバッチを削除
    targetBatchId = batches[batches.length - 1];
  }

  if (!targetBatchId) return;

  // 対象バッチの削除
  AppState.pulls = AppState.pulls.filter(p => p.batchId !== targetBatchId);
  recalculatePullsIndexAndCharge();
  persistState();
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();

  // 削除後の再表示: 残りのバッチがあれば直前を表示、なければ新規初期化
  const remainingBatches = getAllBatches();
  if (remainingBatches.length > 0) {
    AppState.currentSession.editingBatchId = null;
    loadPreviousBatch();
    triggerSheetSlideAnimation('left');
  } else {
    AppState.currentSession.editingBatchId = null;
    setupInputSheet();
    triggerSheetSlideAnimation('left');
  }
  updateSheetPageIndicator();
}

/**
 * 1連モード・10連モードのUI反映 ＆ ボタン状態更新
 */
function applyPullModeUI() {
  const btnPrev = document.getElementById('btnPrevPull');
  const btnToggle = document.getElementById('btnTogglePullCount');
  const btnNext = document.getElementById('btnSheetSubmitNext');
  const btnAddBatch = document.getElementById('btnAddNextBatch');
  const btnDelete = document.getElementById('btnDeleteCurrentPull');
  const tbody = document.getElementById('gachaSheetTbody');

  const batches = getAllBatches();
  const currentEditingId = AppState.currentSession.editingBatchId;

  // ボタンテキスト更新
  if (btnPrev) {
    btnPrev.textContent = '◁ 前ページ';
    if (batches.length === 0 || (currentEditingId && batches.indexOf(currentEditingId) === 0)) {
      btnPrev.disabled = true;
    } else {
      btnPrev.disabled = false;
    }
  }

  if (btnToggle) {
    btnToggle.textContent = isSinglePullMode ? '10連に切替' : '1連に切替';
    if (isSinglePullMode) {
      btnToggle.classList.add('active-single');
    } else {
      btnToggle.classList.remove('active-single');
    }
  }

  if (btnAddBatch) {
    btnAddBatch.textContent = isSinglePullMode ? '1連追加' : '10連追加';
  }

  if (btnNext) {
    btnNext.textContent = '次ページ ▷';
  }

  if (btnDelete) {
    btnDelete.textContent = isSinglePullMode ? 'この1連を削除' : 'この10連を削除';
    if (batches.length === 0 && !currentEditingId) {
      btnDelete.disabled = true;
    } else {
      btnDelete.disabled = false;
    }
  }

  updateSheetPageIndicator();

  if (!tbody) return;

  const trList = tbody.querySelectorAll('tr');
  trList.forEach((tr, idx) => {
    const inputs = tr.querySelectorAll('input');
    if (idx === 0) {
      // 1連目: 常に有効
      tr.classList.remove('row-disabled');
      inputs.forEach(inp => inp.disabled = false);
    } else {
      // 2連〜10連目
      if (isSinglePullMode) {
        tr.classList.add('row-disabled');
        inputs.forEach(inp => inp.disabled = true);

        // 値をリセット
        if (AppState.currentSession.rows[idx]) {
          AppState.currentSession.rows[idx].studentName = '';
          AppState.currentSession.rows[idx].isPick = false;
          AppState.currentSession.rows[idx].isNew = false;
        }
        const textInp = tr.querySelector('.sheet-student-input');
        if (textInp) {
          textInp.value = '';
          textInp.classList.remove('has-value', 'is-pickup');
        }
        const chks = tr.querySelectorAll('.col-chk input');
        chks.forEach(c => c.checked = false);
        const avatarSlot = tr.querySelector('.sheet-student-avatar-slot');
        if (avatarSlot) avatarSlot.classList.remove('visible');
      } else {
        tr.classList.remove('row-disabled');
        inputs.forEach(inp => inp.disabled = false);
      }
    }
  });
}

/**
 * 入力シートテーブルのレンダリング
 */
function renderInputSheetTable() {
  const tbody = document.getElementById('gachaSheetTbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  const rows = AppState.currentSession.rows;

  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    if (row.charge === 100 || row.charge === 200) {
      tr.classList.add('row-charge-100');
    }

    // 1. 連番
    const tdSeq = document.createElement('td');
    tdSeq.className = 'col-num';
    tdSeq.textContent = row.seq;
    tr.appendChild(tdSeq);

    // 2. 累計
    const tdTotal = document.createElement('td');
    tdTotal.className = 'col-total';
    tdTotal.textContent = row.total;
    tr.appendChild(tdTotal);

    // 3. チャージ
    const tdCharge = document.createElement('td');
    tdCharge.className = 'col-charge';
    let chargeLabel = row.charge;
    if (row.charge === 100) chargeLabel += ' (50%)';
    if (row.charge === 200) chargeLabel = '200天井';
    tdCharge.textContent = chargeLabel;
    tr.appendChild(tdCharge);

    // 4. 生徒名入力欄 (プレースホルダーなし・枠色と形で入力欄と明示・左側に生徒アイコン表示)
    const tdName = document.createElement('td');
    tdName.className = 'col-name';
    const inputWrap = document.createElement('div');
    inputWrap.className = 'sheet-student-input-wrap';

    // 確定時に名前の左に表示される生徒アイコンサムネイル枠
    const avatarSlot = document.createElement('div');
    avatarSlot.className = 'sheet-student-avatar-slot';
    avatarSlot.id = `avatarSlot_${idx}`;
    const avatarImg = document.createElement('img');
    avatarImg.className = 'sheet-student-avatar-img';
    avatarImg.alt = '';
    avatarSlot.appendChild(avatarImg);
    inputWrap.appendChild(avatarSlot);

    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.className = 'sheet-student-input';
    inputName.value = row.studentName;
    // ブラウザの検索履歴・オートコンプリート候補の徹底無効化
    inputName.autocomplete = 'off';
    inputName.setAttribute('autocomplete', 'new-password');
    inputName.setAttribute('autocorrect', 'off');
    inputName.setAttribute('autocapitalize', 'off');
    inputName.setAttribute('spellcheck', 'false');
    inputName.setAttribute('data-lpignore', 'true');
    inputName.setAttribute('data-form-type', 'other');
    inputName.setAttribute('aria-autocomplete', 'none');
    inputName.name = `student_pull_${idx}_${Date.now()}`;
    inputName.dataset.rowIndex = idx;

    // 生徒アイコン表示更新関数
    function updateRowAvatar(val) {
      if (!val || !val.trim()) {
        avatarSlot.classList.remove('visible');
        avatarImg.src = '';
        return;
      }
      const iconUrl = getStudentIconUrl(val.trim());
      if (iconUrl) {
        avatarImg.src = iconUrl;
        avatarSlot.classList.add('visible');
      } else {
        avatarSlot.classList.remove('visible');
        avatarImg.src = '';
      }
    }

    if (row.studentName) {
      inputName.classList.add('has-value');
      if (row.isPick) inputName.classList.add('is-pickup');
      updateRowAvatar(row.studentName);
    }

    // 入力イベント
    inputName.addEventListener('input', (e) => {
      onStudentInputChange(idx, e.target.value);
      updateRowAvatar(e.target.value);
    });
    inputName.addEventListener('focus', (e) => {
      showStudentGuidePopup(inputName, idx);
    });
    inputName.addEventListener('blur', (e) => {
      updateRowAvatar(e.target.value);
    });
    inputName.addEventListener('keydown', (e) => {
      handleSuggestKeyNavigation(e, idx);
    });

    inputWrap.appendChild(inputName);
    tdName.appendChild(inputWrap);
    tr.appendChild(tdName);

    // 5. pick チェックボックス
    const tdPick = document.createElement('td');
    tdPick.className = 'col-chk';
    const labelPick = document.createElement('label');
    labelPick.className = 'sheet-chk-label chk-pick';
    const chkPick = document.createElement('input');
    chkPick.type = 'checkbox';
    chkPick.checked = row.isPick;
    chkPick.dataset.rowIndex = idx;
    chkPick.addEventListener('change', (e) => {
      row.isPick = e.target.checked;
      if (row.isPick) {
        inputName.classList.add('is-pickup');
      } else {
        inputName.classList.remove('is-pickup');
      }
      recalculateCurrentSessionCharges();
    });
    const boxPick = document.createElement('span');
    boxPick.className = 'custom-chk-box';
    boxPick.textContent = '✔';
    labelPick.appendChild(chkPick);
    labelPick.appendChild(boxPick);
    tdPick.appendChild(labelPick);
    tr.appendChild(tdPick);

    // 6. 新 チェックボックス
    const tdNew = document.createElement('td');
    tdNew.className = 'col-chk';
    const labelNew = document.createElement('label');
    labelNew.className = 'sheet-chk-label';
    const chkNew = document.createElement('input');
    chkNew.type = 'checkbox';
    chkNew.checked = row.isNew;
    chkNew.dataset.rowIndex = idx;
    chkNew.addEventListener('change', (e) => {
      row.isNew = e.target.checked;
      updateAllStats();
    });
    const boxNew = document.createElement('span');
    boxNew.className = 'custom-chk-box';
    boxNew.textContent = '✔';
    labelNew.appendChild(chkNew);
    labelNew.appendChild(boxNew);
    tdNew.appendChild(labelNew);
    tr.appendChild(tdNew);

    tbody.appendChild(tr);
  });

  // 1連モード・10連モードの表示状態（グレーアウト等）を適用
  applyPullModeUI();
}

/**
 * 生徒名の手入力・サジェスト変更時の処理
 */
function onStudentInputChange(rowIndex, value) {
  const row = AppState.currentSession.rows[rowIndex];
  if (!row) return;

  row.studentName = value;
  const inputEl = document.querySelector(`.sheet-student-input[data-row-index="${rowIndex}"]`);
  const chkPick = document.querySelector(`.col-chk input[data-row-index="${rowIndex}"]`);

  if (value.trim()) {
    if (inputEl) inputEl.classList.add('has-value');

    // ピックアップ生徒と一致するか判定
    const isPickMatch = AppState.config.pickupStudents.some(pu =>
      normalizeStudentName(pu) === normalizeStudentName(value)
    );
    row.isPick = isPickMatch;
    if (chkPick) chkPick.checked = isPickMatch;

    if (inputEl) {
      if (isPickMatch) inputEl.classList.add('is-pickup');
      else inputEl.classList.remove('is-pickup');
    }

  } else {
    if (inputEl) {
      inputEl.classList.remove('has-value');
      inputEl.classList.remove('is-pickup');
    }
    row.isPick = false;
    row.isNew = false;
    if (chkPick) chkPick.checked = false;
    const chkNew = document.querySelectorAll(`.col-chk input[data-row-index="${rowIndex}"]`)[1];
    if (chkNew) chkNew.checked = false;
  }

  // チャージ数の再計算および集計即時反映！
  recalculateCurrentSessionCharges();

  // サジェストリスト更新
  updateStudentGuidePopup(inputEl, value, rowIndex);
}

// ==========================================================================
// 生徒名サジェストポップアップ (前方一致・平仮名カタカナ)
// ==========================================================================

let activePopupRowIndex = -1;
let currentSuggestCandidates = [];
let highlightedSuggestIndex = 0;

function showStudentGuidePopup(inputEl, rowIndex) {
  activePopupRowIndex = rowIndex;
  updateStudentGuidePopup(inputEl, inputEl.value, rowIndex);
}

function updateStudentGuidePopup(inputEl, query, rowIndex) {
  const popup = document.getElementById('studentInputGuidePopup');
  const listEl = document.getElementById('guidePopupList');
  if (!popup || !listEl) return;

  const candidates = searchStudents(query);
  currentSuggestCandidates = candidates;
  highlightedSuggestIndex = 0;

  if (candidates.length === 0) {
    popup.style.display = 'none';
    return;
  }

  listEl.innerHTML = '';
  candidates.forEach((name, cIdx) => {
    const item = document.createElement('div');
    item.className = 'suggest-item' + (cIdx === 0 ? ' highlighted' : '');
    item.dataset.index = cIdx;

    const iconUrl = getStudentIconUrl(name);
    if (iconUrl) {
      const img = document.createElement('img');
      img.className = 'suggest-item-icon';
      img.src = iconUrl;
      item.appendChild(img);
    }

    const span = document.createElement('span');
    span.textContent = name;
    item.appendChild(span);

    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectSuggestStudent(rowIndex, name);
    });

    listEl.appendChild(item);
  });

  // ポップアップ位置計算 (ユーザー要望: 検索・IME予測窓と被らないよう左側に縦長表示)
  popup.style.display = 'flex';
  const rect = inputEl.getBoundingClientRect();
  const popupWidth = 175;
  const popupHeight = Math.min(310, popup.scrollHeight || 260);

  // 1. 水平位置 (左右) の決定: 入力枠の左側に配置
  let leftPos = rect.left - popupWidth - 4;
  // 画面左端からはみ出さないよう安全クランプ
  leftPos = Math.max(6, leftPos);

  // 2. 垂直位置 (上下) の決定 (position: fixed なのでビューポート基準)
  // 通常は入力欄の上端 (rect.top) に合わせる
  // 画面下端をはみ出る場合（下側の行など）は、ポップアップの下端を入力欄の下端に合わせて上方向に展開
  let topPos = rect.top;
  const maxAllowedBottom = window.innerHeight - 8;
  if (rect.top + popupHeight > maxAllowedBottom) {
    topPos = Math.max(8, rect.bottom - popupHeight);
  }

  popup.style.top = `${topPos}px`;
  popup.style.left = `${leftPos}px`;
  popup.style.width = `${popupWidth}px`;
}

function selectSuggestStudent(rowIndex, name) {
  const inputEl = document.querySelector(`.sheet-student-input[data-row-index="${rowIndex}"]`);
  if (inputEl) {
    inputEl.value = name;
  }
  onStudentInputChange(rowIndex, name);

  // 左側の生徒アイコンを即時更新！
  const avatarSlot = document.getElementById(`avatarSlot_${rowIndex}`);
  if (avatarSlot) {
    const avatarImg = avatarSlot.querySelector('.sheet-student-avatar-img');
    const iconUrl = getStudentIconUrl(name);
    if (iconUrl && avatarImg) {
      avatarImg.src = iconUrl;
      avatarSlot.classList.add('visible');
    } else {
      avatarSlot.classList.remove('visible');
    }
  }

  const popup = document.getElementById('studentInputGuidePopup');
  if (popup) popup.style.display = 'none';
  activePopupRowIndex = -1;
}

function handleSuggestKeyNavigation(e, rowIndex) {
  const popup = document.getElementById('studentInputGuidePopup');
  if (!popup || popup.style.display === 'none') return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (highlightedSuggestIndex < currentSuggestCandidates.length - 1) {
      highlightedSuggestIndex++;
      updateSuggestHighlight();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (highlightedSuggestIndex > 0) {
      highlightedSuggestIndex--;
      updateSuggestHighlight();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (currentSuggestCandidates[highlightedSuggestIndex]) {
      selectSuggestStudent(rowIndex, currentSuggestCandidates[highlightedSuggestIndex]);
    }
  } else if (e.key === 'Escape') {
    popup.style.display = 'none';
  }
}

function updateSuggestHighlight() {
  const listEl = document.getElementById('guidePopupList');
  if (!listEl) return;
  const items = listEl.querySelectorAll('.suggest-item');
  items.forEach((item, idx) => {
    if (idx === highlightedSuggestIndex) {
      item.classList.add('highlighted');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('highlighted');
    }
  });
}

// ドキュメントクリックでサジェストを閉じる
document.addEventListener('click', (e) => {
  const popup = document.getElementById('studentInputGuidePopup');
  if (!popup) return;
  if (!popup.contains(e.target) && !e.target.classList.contains('sheet-student-input')) {
    popup.style.display = 'none';
  }
});

// ==========================================================================
// シート確定・コミット処理
// ==========================================================================

function commitCurrentSheet() {
  const rows = AppState.currentSession.rows;
  if (!rows || rows.length === 0) return;

  const pullType = isSinglePullMode ? '1' : '10';
  const targetRows = isSinglePullMode ? [rows[0]] : rows;
  const editingBatchId = AppState.currentSession.editingBatchId;

  if (editingBatchId) {
    // 既存バッチの再編集・上書き
    const firstIdx = AppState.pulls.findIndex(p => p.batchId === editingBatchId);
    if (firstIdx !== -1) {
      const existingInBatch = AppState.pulls.filter(p => p.batchId === editingBatchId);
      const originalCount = existingInBatch.length;
      const createdAt = existingInBatch[0] ? existingInBatch[0].createdAt : new Date().toISOString();

      const updatedPulls = targetRows.map((r, i) => {
        const isThreeStar = Boolean(r.studentName && r.studentName.trim());
        return {
          id: existingInBatch[i] ? existingInBatch[i].id : (AppState.pulls.length + i + 1),
          pullType: pullType,
          batchId: editingBatchId,
          seqInBatch: r.seq,
          totalPullIndex: r.total,
          charge: r.charge,
          studentName: r.studentName ? normalizeStudentName(r.studentName) : '',
          isThreeStar: isThreeStar,
          isPick: Boolean(r.isPick),
          isNew: Boolean(r.isNew),
          isGuaranteed50: Boolean(r.isGuaranteed50),
          isGuaranteed100: Boolean(r.isGuaranteed100),
          createdAt: createdAt
        };
      });

      AppState.pulls.splice(firstIdx, originalCount, ...updatedPulls);
    }
  } else {
    // 新規バッチ追加：入力（生徒名またはpick）がある場合のみ正式追加！
    const hasAnyContent = targetRows.some(r => (r.studentName && r.studentName.trim()) || r.isPick);
    if (!hasAnyContent) {
      // 完全な空シートならAppState.pullsにゴミを追加せず終了
      return;
    }

    const batchId = 'batch_' + Date.now();
    targetRows.forEach(r => {
      const isThreeStar = Boolean(r.studentName && r.studentName.trim());
      AppState.pulls.push({
        id: AppState.pulls.length + 1,
        pullType: pullType,
        batchId: batchId,
        seqInBatch: r.seq,
        totalPullIndex: r.total,
        charge: r.charge,
        studentName: r.studentName ? normalizeStudentName(r.studentName) : '',
        isThreeStar: isThreeStar,
        isPick: Boolean(r.isPick),
        isNew: Boolean(r.isNew),
        isGuaranteed50: Boolean(r.isGuaranteed50),
        isGuaranteed100: Boolean(r.isGuaranteed100),
        createdAt: new Date().toISOString()
      });
    });
    // 作成したバッチIDを編集対象として保持
    AppState.currentSession.editingBatchId = batchId;
  }

  recalculatePullsIndexAndCharge();
  persistState();
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
}

// ==========================================================================
// 統計計算 & 画面更新
// ==========================================================================

/**
 * シート入力中の内容も加味したリアルタイム集計用 pulls リストを取得
 */
function getCombinedLivePulls() {
  const simulated = getSimulatedAllPulls();
  if (simulated.length > 0) return simulated;
  return AppState.pulls;
}

function updateAllStats() {
  const pulls = getCombinedLivePulls();
  const totalPulls = pulls.length;
  const pyroxene = totalPulls * 120;

  // ☆３集計 (チャージ100連目および200連目は☆3確率100%枠のため、通常確率の集計から除外)
  const guaranteedPulls = pulls.filter(p => Number(p.charge) === 100 || Number(p.charge) === 200);
  const guaranteedThreeStarPulls = guaranteedPulls.filter(p => p.isThreeStar);

  const effectiveTotalPulls = totalPulls - guaranteedPulls.length;
  const allThreeStarPulls = pulls.filter(p => p.isThreeStar);
  const effectiveThreeStarCount = allThreeStarPulls.length - guaranteedThreeStarPulls.length;

  const threeStarRate = effectiveTotalPulls > 0 ? (effectiveThreeStarCount / effectiveTotalPulls) * 100 : 0;
  const expectedRate = AppState.config.rate || 0.03;
  const expectedCount = effectiveTotalPulls * expectedRate;
  const diffCount = effectiveThreeStarCount - expectedCount;

  // ピックアップ集計 (チャージ100連目[50%枠]および200連目[100%天井枠]は除外して通常枠のみで計算)
  const normalPickupPulls = pulls.filter(p => p.isPick && Number(p.charge) !== 100 && Number(p.charge) !== 200);
  const normalPickupCount = normalPickupPulls.length;
  const pickupRate = effectiveTotalPulls > 0 ? (normalPickupCount / effectiveTotalPulls) * 100 : 0;
  const expectedPickup = effectiveTotalPulls * 0.007;

  // 50%勝率集計 (charge === 100 のときの勝敗: pickなら勝ち、すり抜けなら負け)
  const fiftyPulls = pulls.filter(p => Number(p.charge) === 100);
  const fiftyWins = fiftyPulls.filter(p => p.isPick).length;
  const fiftyLosses = fiftyPulls.length - fiftyWins;
  const fiftyWinRate = fiftyPulls.length > 0 ? (fiftyWins / fiftyPulls.length) * 100 : 0;

  // 現在チャージ判定（最新10連の最終行の分子が100を超えていたら分母200＆赤色表示）
  const activeCharge = getActiveDisplayCharge();
  let chargeDenominator = 100;
  let isDanger200 = false;

  if (activeCharge > 100) {
    chargeDenominator = 200;
    isDanger200 = true;
  }

  const remainingToTarget = Math.max(0, chargeDenominator - activeCharge);
  const chargePercent = Math.min(100, (activeCharge / chargeDenominator) * 100);

  // 1. トップ簡易集計バー反映
  setText('liveStatTotalPulls', totalPulls);
  setText('liveStatPyroxene', pyroxene.toLocaleString());
  setText('liveStatThreeStarRate', threeStarRate.toFixed(2));
  setText('liveStatThreeStarCount', effectiveThreeStarCount);
  setText('liveStatThreeStarDiff', (diffCount >= 0 ? '+' : '') + diffCount.toFixed(1));
  setText('liveStatPickupRate', pickupRate.toFixed(2));
  setText('liveStatPickupCount', normalPickupCount);
  setText('liveStatPickupExpected', expectedPickup.toFixed(1));
  setText('liveStatWinRate', fiftyWinRate.toFixed(1));
  setText('liveStatWinCount', fiftyWins);
  setText('liveStatLossCount', fiftyLosses);
  setText('liveStatFiftyTotal', fiftyPulls.length);

  const chargeTextEl = document.getElementById('liveStatChargeText');
  if (chargeTextEl) {
    chargeTextEl.textContent = `${activeCharge} / ${chargeDenominator}`;
    if (isDanger200) {
      chargeTextEl.classList.add('charge-danger');
    } else {
      chargeTextEl.classList.remove('charge-danger');
    }
  }

  const chargeFillEl = document.getElementById('liveChargeProgressFill');
  if (chargeFillEl) {
    chargeFillEl.style.width = `${chargePercent}%`;
    if (isDanger200) {
      chargeFillEl.classList.add('charge-danger');
    } else {
      chargeFillEl.classList.remove('charge-danger');
    }
  }

  const chargeSubEl = document.getElementById('liveChargeSub');
  if (chargeSubEl) {
    chargeSubEl.textContent = `あと ${remainingToTarget}連`;
  }

  // 2. ダッシュボードカード反映
  setText('dashTotalPulls', totalPulls);
  setText('dashTotalPyroxene', pyroxene.toLocaleString());
  const tenPulls = pulls.filter(p => p.pullType === '10').length / 10;
  setText('dashTenPullsCount', Math.floor(tenPulls));
  setText('dashSinglePullsCount', pulls.filter(p => p.pullType === '1').length);

  setText('dashThreeStarRate', threeStarRate.toFixed(2));
  setText('dashThreeStarCount', effectiveThreeStarCount);
  setText('dashThreeStarDiffVal', (diffCount >= 0 ? '+' : '') + diffCount.toFixed(1));

  const luckEvaluation = diffCount > 1.5 ? '大勝利！' : diffCount < -1.5 ? '下振れ中' : '期待値通り';
  setText('dashLuckEvaluation', luckEvaluation);

  setText('dashPickupRate', pickupRate.toFixed(2));
  setText('dashPickupCount', normalPickupCount);
  setText('dashPickupExpected', expectedPickup.toFixed(1));
  setText('dashNaturalPickupCount', normalPickupCount);
  setText('dashCeilingPickupCount', pulls.filter(p => p.isPick && (Number(p.charge) === 100 || Number(p.charge) === 200)).length);

  setText('dashWinRate', fiftyWinRate.toFixed(1));
  setText('dashWinsCount', fiftyWins);
  setText('dashLossesCount', fiftyLosses);
  setText('dashFiftyTotalCount', fiftyPulls.length);

  // 分析サマリー
  let maxStreak = 0;
  let curStreak = 0;
  pulls.forEach(p => {
    if (p.isThreeStar) {
      curStreak = 0;
    } else {
      curStreak++;
      if (curStreak > maxStreak) maxStreak = curStreak;
    }
  });
  setText('dashMaxStreak', maxStreak);
  setText('dashCurrentStreak', curStreak);

  const ceilingCount = pulls.filter(p => p.charge === 200).length;
  setText('dashCeilingCount', ceilingCount);
  const ceilingRate = totalPulls >= 200 ? ((ceilingCount * 200 / totalPulls) * 100).toFixed(1) : '0.0';
  setText('dashCeilingRate', ceilingRate);

  setText('dashCurrentChargeVal', `${activeCharge} `);
  setText('dashChargeRemainingText', `あと ${remainingToTarget}連`);

  // バッジ更新
  const rateBadge = document.getElementById('dashThreeStarBadge');
  if (rateBadge) rateBadge.textContent = AppState.config.rate === 0.06 ? '6% フェス' : '3% 通常';
  const targetPercent = document.getElementById('chartTargetPercent');
  if (targetPercent) targetPercent.textContent = (AppState.config.rate * 100).toFixed(1);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ==========================================================================
// Chart.js 確率収束 ＆ 相対誤差マトリクスグラフ (ba_gacha_tabulation 準拠)
// ==========================================================================

const convergenceAvatarCache = {};

const convergenceRelativeMatrixPlugin = {
  id: 'convergenceRelativeMatrixPlugin',
  beforeDatasetsDraw(chart) {
    try {
      const { ctx, chartArea: { left, right, bottom } } = chart;
      if (!chart.scales || !chart.scales.y || !chart.scales.x) return;

      const isDark = document.body.classList.contains('theme-tactical-dark');

      // 最下段のすり抜け生徒用背景帯（プロットエリア最下部、ba_gacha_tabulation準拠）
      const boxHeight = 32;
      const boxTop = bottom - boxHeight;

      ctx.save();
      ctx.fillStyle = isDark ? 'rgba(22, 36, 54, 0.65)' : 'rgba(228, 236, 246, 0.55)';
      ctx.fillRect(left, boxTop, right - left, boxHeight);

      ctx.strokeStyle = isDark ? 'rgba(0, 174, 239, 0.25)' : 'rgba(0, 174, 239, 0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(left, boxTop, right - left, boxHeight);
      ctx.restore();
    } catch (e) {
      console.error('Error in beforeDatasetsDraw:', e);
    }
  },

  afterDatasetsDraw(chart) {
    try {
      const { ctx, chartArea: { left, right, top, bottom } } = chart;
      if (!chart.scales || !chart.scales.y || !chart.scales.x) return;

      const threeStarPulls = AppState.pulls.filter(p => p.isThreeStar);
      if (threeStarPulls.length === 0) return;

      // X座標が近い場合のオフセット計算（カスケード表示）
      const placedPositions = [];

      threeStarPulls.forEach((pull) => {
        const pullTotal = pull.totalPullIndex;
        let baseX = chart.scales.x.getPixelForValue(pullTotal);
        if (baseX < left || baseX > right) return;

        const isPick = Boolean(pull.isPick);
        // ピックアップ生徒は中央の基準線(0%)より上部（top + 24px）、すり抜け生徒は最下段（bottom - 16px）
        const centerY = isPick ? (top + 24) : (bottom - 16);

        // 重なり検出とカスケードずらし (ba_gacha_tabulation再現)
        let finalX = baseX;
        const overlapGroup = placedPositions.filter(p => 
          p.isPick === isPick && Math.abs(p.x - baseX) < 24
        );
        if (overlapGroup.length > 0) {
          finalX = baseX + overlapGroup.length * 16;
          if (finalX > right - 15) finalX = right - 15;
        }
        placedPositions.push({ x: finalX, isPick: isPick });

        const iconUrl = getStudentIconUrl(pull.studentName);
        if (!iconUrl) return;

        let img = convergenceAvatarCache[iconUrl];
        if (!img) {
          img = new Image();
          img.onload = () => chart.draw();
          img.src = iconUrl;
          convergenceAvatarCache[iconUrl] = img;
        }

        if (img.complete && img.naturalWidth !== 0) {
          const size = 28;
          const r = size / 2;
          const imgX = finalX - r;
          const imgY = centerY - r;

          ctx.save();
          // 円形クリップ
          ctx.beginPath();
          ctx.arc(finalX, centerY, r, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(img, imgX, imgY, size, size);
          ctx.restore();

          // 金色丸枠ボーダー (ba_gacha_tabulation忠実再現)
          ctx.save();
          ctx.strokeStyle = '#c5a059';
          ctx.lineWidth = 2.5;
          ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
          ctx.shadowBlur = 4;
          ctx.shadowOffsetY = 1.5;
          ctx.beginPath();
          ctx.arc(finalX, centerY, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      });
    } catch (e) {
      console.error('Error in afterDatasetsDraw:', e);
    }
  }
};

function renderConvergenceChart() {
  const canvas = document.getElementById('gachaConvergenceChart');
  if (!canvas) return;

  const pulls = AppState.pulls;
  const targetRate = AppState.config.rate || 0.03;
  const isFest = (targetRate === 0.06);
  const lineColor = isFest ? '#ff3e6c' : '#00aeef';
  const totalPulls = pulls.length;

  // 凡例表示の同期
  const rateLabelEl = document.getElementById('chartRateLabel');
  if (rateLabelEl) rateLabelEl.textContent = isFest ? '6% 乖離率' : '3% 乖離率';
  const rateDotEl = document.getElementById('chartRateDot');
  if (rateDotEl) rateDotEl.style.backgroundColor = lineColor;

  // X軸の最大値 (多くても400連程度を想定)
  let maxPulls = 100;
  if (totalPulls > 300) {
    maxPulls = Math.min(400, Math.ceil(totalPulls / 50) * 50);
  } else if (totalPulls > 200) {
    maxPulls = 300;
  } else if (totalPulls > 100) {
    maxPulls = 200;
  } else {
    maxPulls = 100;
  }
  if (totalPulls > 400) {
    maxPulls = Math.ceil(totalPulls / 50) * 50;
  }

  // データポイント構築
  const points = [];
  const actualRatesMap = {};

  // 0連目は実測0%なので偏差 -100% からスタート
  points.push({ x: 0, y: -100 });
  actualRatesMap[0] = 0;

  let threeCount = 0;
  let normalPullsCount = 0;
  pulls.forEach((p, idx) => {
    const isGuaranteed = (Number(p.charge) === 100 || Number(p.charge) === 200);
    if (!isGuaranteed) {
      normalPullsCount++;
      if (p.isThreeStar) threeCount++;
    }
    const currentN = idx + 1;
    if (currentN % 10 === 0 || currentN === totalPulls || p.isThreeStar) {
      if (normalPullsCount > 0) {
        const actRate = (threeCount / normalPullsCount);
        const dev = ((actRate - targetRate) / targetRate) * 100;
        points.push({ x: currentN, y: Number(dev.toFixed(2)) });
        actualRatesMap[currentN] = Number((actRate * 100).toFixed(2));
      }
    }
  });

  // 重複 x の除去
  const uniquePoints = [];
  const seenX = new Set();
  points.forEach(pt => {
    if (!seenX.has(pt.x)) {
      seenX.add(pt.x);
      uniquePoints.push(pt);
    }
  });

  // 理論値基準線 (0%)
  const baselinePoints = [
    { x: 0, y: 0 },
    { x: maxPulls, y: 0 }
  ];

  // Y軸の最大値・最小値計算（中心点 0% をグラフの中央に配置するため、正負対称にする）
  const deviations = uniquePoints.map(p => p.y);
  let maxAbsDev = 100;
  deviations.forEach(d => {
    if (Math.abs(d) > maxAbsDev) maxAbsDev = Math.abs(d);
  });
  const yLimit = Math.max(120, Math.ceil((maxAbsDev * 1.15) / 50) * 50);

  if (AppState.chartInstance) {
    AppState.chartInstance.destroy();
  }

  const isDark = document.body.classList.contains('theme-tactical-dark');
  const textColor = isDark ? '#94a3b8' : '#5e6b77';
  const gridColor = isDark ? 'rgba(0, 174, 239, 0.12)' : 'rgba(0, 174, 239, 0.08)';

  AppState.chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: '理論値基準線 (0%)',
          data: baselinePoints,
          borderColor: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(31, 41, 55, 0.35)',
          borderDash: [5, 5],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false
        },
        {
          label: isFest ? '6% 乖離率' : '3% 乖離率',
          data: uniquePoints,
          borderColor: lineColor,
          backgroundColor: isFest ? 'rgba(255, 62, 108, 0.06)' : 'rgba(0, 174, 239, 0.06)',
          borderWidth: 2.5,
          tension: 0.15,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointBackgroundColor: lineColor
        }
      ]
    },
    plugins: [convergenceRelativeMatrixPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'nearest',
        axis: 'x'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'nearest',
          intersect: false,
          callbacks: {
            title: (items) => `${items[0].parsed.x}連目`,
            label: (ctx) => {
              if (ctx.dataset.label.includes('基準線')) return null;
              const xVal = ctx.parsed.x;
              const yVal = ctx.parsed.y;
              const sign = yVal >= 0 ? '+' : '';
              const act = actualRatesMap[xVal] !== undefined ? actualRatesMap[xVal] : null;
              const rateLabel = isFest ? '6% フェス' : '3% 通常';
              if (act !== null) {
                return `${rateLabel}: 実測 ${act.toFixed(2)}% (偏差: ${sign}${yVal.toFixed(1)}%)`;
              }
              return `${rateLabel}: ${sign}${yVal.toFixed(1)}%`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: maxPulls,
          ticks: {
            stepSize: maxPulls <= 100 ? 20 : 50,
            color: textColor,
            font: { size: 10 },
            callback: (val) => `${val}連`
          },
          grid: { color: gridColor }
        },
        y: {
          min: -yLimit,
          max: yLimit,
          ticks: {
            display: false
          },
          grid: { color: gridColor },
          title: {
            display: false
          }
        }
      }
    }
  });
}

// ==========================================================================
// 生徒図鑑 & 履歴テーブル
// ==========================================================================

// ==========================================================================
// 排出された☆３生徒一覧 (添付2枚目準拠: 横3列・古い順・日付なし・省スペース)
// ==========================================================================

function renderDirectoryGrid() {
  const container = document.getElementById('threeStarCardsGrid') || document.getElementById('dashStudentsGrid');
  if (!container) return;

  const emptyHint = document.getElementById('threeStarEmptyHint') || document.getElementById('dashStudentsEmpty');
  const countEl = document.getElementById('dashStudentsTotalCount');

  // 時系列順 (古いものが左上、新しいものは右下に追加される昇順)
  const threeStarPulls = AppState.pulls.filter(p => p.isThreeStar);
  if (countEl) countEl.textContent = threeStarPulls.length;

  if (threeStarPulls.length === 0) {
    if (emptyHint) emptyHint.style.display = 'block';
    container.innerHTML = '';
    if (emptyHint) container.appendChild(emptyHint);
    return;
  }

  if (emptyHint) emptyHint.style.display = 'none';
  container.innerHTML = '';

  // 生徒名ごとの累積出現回数マップ
  const studentOccurrenceCounts = {};

  threeStarPulls.forEach(pull => {
    const sName = pull.studentName;
    const norm = normalizeStudentName(sName);
    studentOccurrenceCounts[norm] = (studentOccurrenceCounts[norm] || 0) + 1;
    const currentCount = studentOccurrenceCounts[norm];

    // カード生成 (添付2枚目完全再現)
    const card = document.createElement('div');
    card.className = 'three-star-item-card';

    // 種別テキスト & 枠線クラス判定 (添付2枚目準拠)
    let typeText = 'すり抜け(被り)';
    let borderClass = 'border-regular';

    if (pull.charge === 200) {
      typeText = '交換';
      borderClass = 'border-exchange';
    } else if (pull.isPick) {
      typeText = 'ピックアップ';
      borderClass = 'border-pickup';
    } else if (pull.isGuaranteed50) {
      typeText = 'すり抜け(50%)';
      borderClass = 'border-fifty';
    } else if (pull.isNew) {
      typeText = '新規獲得';
      borderClass = 'border-new';
    } else {
      typeText = currentCount > 1 ? 'すり抜け(被り)' : 'すり抜け';
      borderClass = 'border-regular';
    }

    card.classList.add(borderClass);

    // 1. アイコンラッパー
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'ts-card-avatar-wrap';

    const iconUrl = getStudentIconUrl(sName);
    const img = document.createElement('img');
    img.className = 'ts-card-avatar';
    img.src = iconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="%2300aeef"><rect width="100%" height="100%" fill="%23e6f7fd"/><text x="50%" y="58%" font-size="12" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="%2300aeef">★3</text></svg>';
    avatarWrap.appendChild(img);

    // 2回目・3回目バッジ (添付2枚目再現)
    if (currentCount > 1) {
      const countBadge = document.createElement('span');
      countBadge.className = 'ts-card-count-badge';
      countBadge.textContent = `${currentCount}回目`;
      avatarWrap.appendChild(countBadge);
    }

    card.appendChild(avatarWrap);

    // 2. 生徒名 (太字・中央)
    const nameEl = document.createElement('div');
    nameEl.className = 'ts-card-name';
    nameEl.textContent = sName;
    nameEl.title = sName;
    card.appendChild(nameEl);

    // 3. 種別テキスト (日付は削除して高さを詰める)
    const typeEl = document.createElement('div');
    typeEl.className = 'ts-card-type-text';
    typeEl.textContent = typeText;
    card.appendChild(typeEl);

    container.appendChild(card);
  });
}

function renderHistoryTable() {
  const tbody = document.getElementById('historyTableTbody');
  const countEl = document.getElementById('historyRowCount');
  if (!tbody) return;

  tbody.innerHTML = '';
  const pulls = AppState.pulls;
  if (countEl) countEl.textContent = pulls.length;

  // 最新順（逆順）で表示
  const reversed = [...pulls].reverse();
  reversed.forEach(p => {
    const tr = document.createElement('tr');

    const tdSeq = document.createElement('td');
    tdSeq.textContent = p.seqInBatch || 1;
    tr.appendChild(tdSeq);

    const tdTotal = document.createElement('td');
    tdTotal.textContent = p.totalPullIndex;
    tr.appendChild(tdTotal);

    const tdCharge = document.createElement('td');
    tdCharge.textContent = p.charge;
    if (p.charge === 100) tdCharge.textContent += ' (50%)';
    if (p.charge === 200) tdCharge.textContent = '200天井';
    tr.appendChild(tdCharge);

    const tdName = document.createElement('td');
    tdName.textContent = p.studentName || '-';
    if (p.isPick) tdName.style.color = 'var(--gold)';
    tr.appendChild(tdName);

    const tdType = document.createElement('td');
    tdType.textContent = p.isThreeStar ? '☆3' : '☆1/2';
    tr.appendChild(tdType);

    const tdPick = document.createElement('td');
    tdPick.textContent = p.isPick ? '✔' : '-';
    tr.appendChild(tdPick);

    const tdNew = document.createElement('td');
    tdNew.textContent = p.isNew ? '✔' : '-';
    tr.appendChild(tdNew);

    const tdRemark = document.createElement('td');
    let remark = '';
    if (p.charge === 100) remark = '100連50%枠';
    if (p.charge === 200) remark = '200連天井';
    tdRemark.textContent = remark;
    tr.appendChild(tdRemark);

    tbody.appendChild(tr);
  });
}

// ==========================================================================
// ⚙ 設定タブ（タブ内インライン表示）
// ==========================================================================

function syncSettingsTabInputs() {
  const isFest = AppState.config.rate === 0.06;
  const btn3 = document.getElementById('btnRate3');
  const btn6 = document.getElementById('btnRate6');
  if (btn3 && btn6) {
    if (isFest) {
      btn6.classList.add('active');
      btn3.classList.remove('active');
    } else {
      btn3.classList.add('active');
      btn6.classList.remove('active');
    }
  }

  const initChargeInput = document.getElementById('settingsInitChargeInput');
  if (initChargeInput) initChargeInput.value = AppState.config.initCharge || 0;

  renderSettingsPickupTags();
}

function cancelSettingsFromTab() {
  syncSettingsTabInputs();
  switchTab('tabDashboard');
}

function saveSettingsFromTab() {
  // 1. 確率 (左右分割ボタンの active 状態で判定)
  const btn6 = document.getElementById('btnRate6');
  AppState.config.rate = (btn6 && btn6.classList.contains('active')) ? 0.06 : 0.03;

  // 2. チャージ引継ぎ
  const chargeInput = document.getElementById('settingsInitChargeInput');
  if (chargeInput) {
    let val = parseInt(chargeInput.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    if (val > 199) val = 199;
    AppState.config.initCharge = val;
  }

  recalculatePullsIndexAndCharge();
  persistState();
  updateAllStats();
  switchTab('tabDashboard');
}

function renderSettingsPickupTags() {
  const container = document.getElementById('settingsPickupTags');
  if (!container) return;

  container.innerHTML = '';
  AppState.config.pickupStudents.forEach((student, idx) => {
    const pill = document.createElement('span');
    pill.className = 'pickup-tag-pill';
    pill.textContent = student;

    const btnRemove = document.createElement('button');
    btnRemove.className = 'pickup-tag-remove';
    btnRemove.textContent = '✕';
    btnRemove.addEventListener('click', () => {
      AppState.config.pickupStudents.splice(idx, 1);
      renderSettingsPickupTags();
    });

    pill.appendChild(btnRemove);
    container.appendChild(pill);
  });
}

function addPickupStudent(name) {
  if (!name || !name.trim()) return;
  const norm = normalizeStudentName(name);
  if (!AppState.config.pickupStudents.includes(norm)) {
    AppState.config.pickupStudents.push(norm);
    renderSettingsPickupTags();
  }
  const input = document.getElementById('settingsPickupInput');
  if (input) input.value = '';
  const dropdown = document.getElementById('settingsSuggestDropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function initSettingsPickupSuggest() {
  const inputEl = document.getElementById('settingsPickupInput');
  const dropdownEl = document.getElementById('settingsSuggestDropdown');
  if (!inputEl || !dropdownEl) return;

  inputEl.addEventListener('input', () => {
    const val = inputEl.value.trim();
    if (!val) {
      dropdownEl.style.display = 'none';
      dropdownEl.innerHTML = '';
      return;
    }

    const matches = searchStudents(val).slice(0, 10);
    if (matches.length === 0) {
      dropdownEl.style.display = 'none';
      dropdownEl.innerHTML = '';
      return;
    }

    dropdownEl.innerHTML = '';
    matches.forEach(name => {
      const item = document.createElement('div');
      item.className = 'dropup-item';

      const iconUrl = getStudentIconUrl(name);
      const img = document.createElement('img');
      img.className = 'dropup-avatar';
      img.src = iconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="%2300aeef"><rect width="100%" height="100%" fill="%23e6f7fd"/><text x="50%" y="58%" font-size="10" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="%2300aeef">★3</text></svg>';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'dropup-name';
      nameSpan.textContent = name;

      item.appendChild(img);
      item.appendChild(nameSpan);

      item.addEventListener('click', () => {
        addPickupStudent(name);
        dropdownEl.style.display = 'none';
        dropdownEl.innerHTML = '';
      });

      dropdownEl.appendChild(item);
    });

    dropdownEl.style.display = 'block';
  });

  document.addEventListener('click', (e) => {
    if (!dropdownEl.contains(e.target) && e.target !== inputEl) {
      dropdownEl.style.display = 'none';
    }
  });
}

// ==========================================================================
// イベントリスナー一括登録
// ==========================================================================

function initEventListeners() {
  // 1. タブナビゲーション
  const tabBtns = document.querySelectorAll('#mainTabsNav .nav-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  // 2. シート操作ボタン（2行構成: 1行目=前の10連/1連切替/次の10連, 2行目=この10連削除/10連追加/確定）
  const btnPrevPull = document.getElementById('btnPrevPull');
  const btnToggleCount = document.getElementById('btnTogglePullCount');
  const btnSubmitNext = document.getElementById('btnSheetSubmitNext');
  const btnAddNextBatch = document.getElementById('btnAddNextBatch');
  const btnDeleteCurrent = document.getElementById('btnDeleteCurrentPull');
  const btnSubmitOk = document.getElementById('btnSheetSubmitOk');

  // ◁ 前の10連へ
  if (btnPrevPull) {
    btnPrevPull.addEventListener('click', () => {
      const moved = loadPreviousBatch();
      if (moved) {
        triggerSheetSlideAnimation('left');
        updateSheetPageIndicator();
      }
    });
  }

  // 1連に切替 / 10連に切替
  if (btnToggleCount) {
    btnToggleCount.addEventListener('click', () => {
      isSinglePullMode = !isSinglePullMode;
      applyPullModeUI();
    });
  }

  // 次の10連へ ▶（次の10連がある場合のみ移動、最終ページで押した時はシェイクアニメーション）
  if (btnSubmitNext) {
    btnSubmitNext.addEventListener('click', () => {
      const currentEditingId = AppState.currentSession.editingBatchId;
      const batches = getAllBatches();

      if (currentEditingId) {
        const currentIdx = batches.indexOf(currentEditingId);
        if (currentIdx !== -1 && currentIdx < batches.length - 1) {
          commitCurrentSheet();
          loadBatchById(batches[currentIdx + 1]);
          triggerSheetSlideAnimation('right');
          updateSheetPageIndicator();
          return;
        }
      }

      // 最終ページ（これ以上先の10連がない）の場合: シェイクアニメーションを実行
      btnSubmitNext.classList.remove('btn-shake');
      void btnSubmitNext.offsetWidth; // リフロー強制
      btnSubmitNext.classList.add('btn-shake');
      setTimeout(() => {
        btnSubmitNext.classList.remove('btn-shake');
      }, 400);
    });
  }

  // ＋ 10連追加（押した時点で即座に10連引いた状態にする）
  if (btnAddNextBatch) {
    btnAddNextBatch.addEventListener('click', () => {
      addNewBatchImmediately();
    });
  }

  // この10連を削除
  if (btnDeleteCurrent) {
    btnDeleteCurrent.addEventListener('click', () => {
      const isSingle = isSinglePullMode;
      const confirmMsg = isSingle
        ? '表示中の1連を削除して前の引きに戻しますか？（累計・チャージも巻き戻ります）'
        : '表示中の10連を削除して前の10連に戻しますか？（累計・チャージも巻き戻ります）';
      if (confirm(confirmMsg)) {
        deleteCurrentBatch();
      }
    });
  }

  // ✔ 確定して集計へ
  if (btnSubmitOk) {
    btnSubmitOk.addEventListener('click', () => {
      commitCurrentSheet();
      switchTab('tabDashboard');
    });
  }

  // 4. 設定タブ操作ボタン
  const btnCancel = document.getElementById('btnCancelSettings');
  const btnSave = document.getElementById('btnSaveSettings');

  if (btnCancel) btnCancel.addEventListener('click', cancelSettingsFromTab);
  if (btnSave) btnSave.addEventListener('click', saveSettingsFromTab);

  // 左右分割確率ボタン (3% / 6%)
  const btnRate3 = document.getElementById('btnRate3');
  const btnRate6 = document.getElementById('btnRate6');
  if (btnRate3 && btnRate6) {
    btnRate3.addEventListener('click', () => {
      btnRate3.classList.add('active');
      btnRate6.classList.remove('active');
    });
    btnRate6.addEventListener('click', () => {
      btnRate6.classList.add('active');
      btnRate3.classList.remove('active');
    });
  }

  // ピックアップ追加 & サジェスト初期化
  const btnAddPu = document.getElementById('btnSettingsAddPickup');
  const inputPu = document.getElementById('settingsPickupInput');
  if (btnAddPu && inputPu) {
    btnAddPu.addEventListener('click', () => addPickupStudent(inputPu.value));
    inputPu.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addPickupStudent(inputPu.value);
      }
    });
  }
  initSettingsPickupSuggest();

  // テーマ切り替え (存在する場合のみ)
  const btnThemeCyan = document.getElementById('btnThemeCyan');
  const btnThemeDark = document.getElementById('btnThemeDark');
  if (btnThemeCyan) {
    btnThemeCyan.addEventListener('click', () => applyTheme('theme-cyan-light'));
  }
  if (btnThemeDark) {
    btnThemeDark.addEventListener('click', () => applyTheme('theme-tactical-dark'));
  }

  // 設定から仮登録モーダル起動
  const btnOpenCustom = document.getElementById('btnOpenCustomModalFromSettings');
  if (btnOpenCustom) {
    btnOpenCustom.addEventListener('click', () => {
      const modal = document.getElementById('modalCustomStudent');
      if (modal && typeof modal.showModal === 'function') modal.showModal();
    });
  }
  const btnCloseCustom = document.getElementById('btnCloseCustomModal');
  if (btnCloseCustom) {
    btnCloseCustom.addEventListener('click', () => {
      const modal = document.getElementById('modalCustomStudent');
      if (modal && typeof modal.close === 'function') modal.close();
    });
  }

  // 設定から仮登録エディタ起動
  const btnOpenEditor = document.getElementById('btnOpenCustomEditorFromSettings');
  if (btnOpenEditor) {
    btnOpenEditor.addEventListener('click', () => {
      const modal = document.getElementById('modalCustomEditor');
      if (modal && typeof modal.showModal === 'function') {
        modal.showModal();
        renderCustomStudentsTableIfOpen();
      }
    });
  }
  const btnCloseEditorModal = document.getElementById('btnCloseEditorModal');
  const btnCloseEditor = document.getElementById('btnCloseEditor');
  [btnCloseEditorModal, btnCloseEditor].forEach(btn => {
    if (btn) {
      btn.addEventListener('click', () => {
        const modal = document.getElementById('modalCustomEditor');
        if (modal && typeof modal.close === 'function') modal.close();
      });
    }
  });

  // 生徒図鑑自動同期ボタン
  const btnSync = document.getElementById('btnSyncWikiDirect');
  if (btnSync) {
    btnSync.addEventListener('click', async () => {
      await loadStudentDictionaries();
      cleanupSyncedCustomStudents(true);
      updateAllStats();
      renderDirectoryGrid();
    });
  }

  // データ初期化（全て初期化）: GitHubアップ済みデータ保持 ＆ チャージ0リセット
  const btnReset = document.getElementById('btnResetAllData');
  if (btnReset) {
    btnReset.addEventListener('click', async () => {
      if (confirm('ガチャ履歴を全て初期化しますか？\n（チャージも0にリセットされます）')) {
        AppState.pulls = [];
        AppState.config.initCharge = 0;
        const initChargeInput = document.getElementById('settingsInitChargeInput');
        if (initChargeInput) initChargeInput.value = 0;

        // GitHubにアップロード済みの仮登録データ(data/custom_students.json)を保持/再読み込み
        try {
          const resCustom = await fetch('data/custom_students.json');
          if (resCustom.ok) {
            const remoteCustom = await resCustom.json();
            if (remoteCustom && remoteCustom.students) {
              AppState.customStudents = Object.assign({}, remoteCustom.students);
            }
          }
        } catch (e) {
          console.warn('Could not reload remote custom students on reset:', e);
        }

        recalculatePullsIndexAndCharge();
        persistState();
        updateAllStats();
        renderHistoryTable();
        renderDirectoryGrid();
        renderConvergenceChart();
        setupInputSheet();
        switchTab('tabDashboard');
      }
    });
  }

  // 5. 履歴アクション (TSVコピー, CSV保存, 取消)
  const btnTsv = document.getElementById('btnCopyTsv');
  if (btnTsv) {
    btnTsv.addEventListener('click', copyHistoryTsv);
  }
  const btnCsv = document.getElementById('btnDownloadCsv');
  if (btnCsv) {
    btnCsv.addEventListener('click', downloadHistoryCsv);
  }
  const btnUndo = document.getElementById('btnUndoLastPull');
  if (btnUndo) {
    btnUndo.addEventListener('click', undoLastPulls);
  }

  // 6. 小窓化 & 配信UIボタン
  const btnPopout = document.getElementById('btnPopoutWindow');
  if (btnPopout) {
    btnPopout.addEventListener('click', () => {
      window.open(window.location.href, 'SchaleGachaTracker', 'width=460,height=760,menubar=no,toolbar=no');
    });
  }
  const btnStream = document.getElementById('btnToggleStreamMode');
  if (btnStream) {
    btnStream.addEventListener('click', () => {
      document.body.classList.toggle('stream-mode');
    });
  }
}

function copyHistoryTsv() {
  if (AppState.pulls.length === 0) {
    alert('コピーする履歴データがありません。');
    return;
  }
  const lines = ['連番\t累計\tチャージ\t生徒名\t種別\tpick\t新\t備考'];
  AppState.pulls.forEach(p => {
    lines.push([
      p.seqInBatch || 1,
      p.totalPullIndex,
      p.charge,
      p.studentName || '',
      p.isThreeStar ? '☆3' : '☆1/2',
      p.isPick ? '1' : '0',
      p.isNew ? '1' : '0',
      p.charge === 100 ? '100連50%枠' : p.charge === 200 ? '200連天井' : ''
    ].join('\t'));
  });
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => alert('スプレッドシート用TSVデータをクリップボードにコピーしました！'))
    .catch(err => console.error(err));
}

function downloadHistoryCsv() {
  if (AppState.pulls.length === 0) {
    alert('保存する履歴データがありません。');
    return;
  }
  const lines = ['連番,累計,チャージ,生徒名,種別,pick,新,備考'];
  AppState.pulls.forEach(p => {
    lines.push([
      p.seqInBatch || 1,
      p.totalPullIndex,
      p.charge,
      `"${p.studentName || ''}"`,
      p.isThreeStar ? '☆3' : '☆1/2',
      p.isPick ? 1 : 0,
      p.isNew ? 1 : 0,
      `"${p.charge === 100 ? '100連50%枠' : p.charge === 200 ? '200連天井' : ''}"`
    ].join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ba_gacha_live_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function undoLastPulls() {
  if (AppState.pulls.length === 0) return;
  const lastBatchId = AppState.pulls[AppState.pulls.length - 1].batchId;
  if (!lastBatchId) {
    AppState.pulls.pop();
  } else {
    // 直前のバッチ（10連または1連）を一括取り消し
    AppState.pulls = AppState.pulls.filter(p => p.batchId !== lastBatchId);
  }
  persistState();
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
}

// ==========================================================================
// 新規生徒仮登録・切り抜きエンジン (□と〇のプレビュー・添付1枚目再現)
// ==========================================================================

const CropperState = {
  img: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0
};

function initCropperEngine() {
  const canvas = document.getElementById('cropCanvas');
  const dropzone = document.getElementById('cropDropzone');
  const fileInput = document.getElementById('cropFileInput');
  if (!canvas || !dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      loadCropperImageFile(e.target.files[0]);
    }
  });

  // ドラッグ＆ドロップ
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadCropperImageFile(e.dataTransfer.files[0]);
    }
  });

  // Ctrl+V クリップボード画像ペースト
  window.addEventListener('paste', (e) => {
    const modal = document.getElementById('modalCustomStudent');
    if (!modal || !modal.open) return;
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const blob = item.getAsFile();
        loadCropperImageFile(blob);
        break;
      }
    }
  });

  // キャンバスドラッグ操作
  canvas.addEventListener('mousedown', (e) => {
    CropperState.isDragging = true;
    CropperState.dragStartX = e.clientX - CropperState.offsetX;
    CropperState.dragStartY = e.clientY - CropperState.offsetY;
  });
  window.addEventListener('mousemove', (e) => {
    if (!CropperState.isDragging) return;
    CropperState.offsetX = e.clientX - CropperState.dragStartX;
    CropperState.offsetY = e.clientY - CropperState.dragStartY;
    drawCropper();
  });
  window.addEventListener('mouseup', () => {
    CropperState.isDragging = false;
  });

  // ズーム操作
  const slider = document.getElementById('cropZoomSlider');
  if (slider) {
    slider.addEventListener('input', (e) => {
      CropperState.scale = parseFloat(e.target.value);
      drawCropper();
    });
  }
  const btnZoomIn = document.getElementById('btnCropZoomIn');
  const btnZoomOut = document.getElementById('btnCropZoomOut');
  const btnReset = document.getElementById('btnCropReset');
  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', () => {
      CropperState.scale = Math.min(3, CropperState.scale + 0.1);
      if (slider) slider.value = CropperState.scale;
      drawCropper();
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', () => {
      CropperState.scale = Math.max(0.5, CropperState.scale - 0.1);
      if (slider) slider.value = CropperState.scale;
      drawCropper();
    });
  }
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      CropperState.scale = 1;
      CropperState.offsetX = 0;
      CropperState.offsetY = 0;
      if (slider) slider.value = 1;
      drawCropper();
    });
  }

  // 保存ボタン
  const btnSaveStudent = document.getElementById('btnSaveCustomStudent');
  const nameInput = document.getElementById('customStudentName');
  if (btnSaveStudent && nameInput) {
    nameInput.addEventListener('input', () => {
      const sampleName = document.getElementById('previewCardName');
      if (sampleName) sampleName.textContent = nameInput.value || '生徒名';
    });
    btnSaveStudent.addEventListener('click', saveCustomStudent);
  }
}

function loadCropperImageFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      CropperState.img = img;
      CropperState.scale = 1;
      CropperState.offsetX = 0;
      CropperState.offsetY = 0;
      const tools = document.getElementById('cropperTools');
      if (tools) tools.style.display = 'flex';
      drawCropper();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function drawCropper() {
  const canvas = document.getElementById('cropCanvas');
  if (!canvas || !CropperState.img) return;
  const ctx = canvas.getContext('2d');

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const img = CropperState.img;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const cropSize = 140;

  // 画像描画
  ctx.save();
  ctx.translate(cx + CropperState.offsetX, cy + CropperState.offsetY);
  ctx.scale(CropperState.scale, CropperState.scale);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();

  // 暗幕オーバーレイ
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 切り抜き範囲クリア
  ctx.clearRect(cx - cropSize / 2, cy - cropSize / 2, cropSize, cropSize);

  // ガイド枠線
  ctx.strokeStyle = '#00aeef';
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - cropSize / 2, cy - cropSize / 2, cropSize, cropSize);

  // プレビュー生成
  generateCroppedPreviews(cx, cy, cropSize);
}

function generateCroppedPreviews(cx, cy, cropSize) {
  const sqCanvas = document.getElementById('previewSquareCanvas');
  const ciCanvas = document.getElementById('previewCircleCanvas');
  const cardImg = document.getElementById('previewCardImg');
  if (!sqCanvas || !ciCanvas || !CropperState.img) return;

  const sqCtx = sqCanvas.getContext('2d');
  const ciCtx = ciCanvas.getContext('2d');

  sqCanvas.width = 120;
  sqCanvas.height = 120;
  ciCanvas.width = 120;
  ciCanvas.height = 120;

  const img = CropperState.img;
  const scale = CropperState.scale;
  const sx = (img.width / 2) - ((cx - (cx - cropSize / 2) - CropperState.offsetX) / scale);
  const sy = (img.height / 2) - ((cy - (cy - cropSize / 2) - CropperState.offsetY) / scale);
  const sWidth = cropSize / scale;
  const sHeight = cropSize / scale;

  // 四角形
  sqCtx.clearRect(0, 0, 120, 120);
  sqCtx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, 120, 120);

  // 円形
  ciCtx.clearRect(0, 0, 120, 120);
  ciCtx.save();
  ciCtx.beginPath();
  ciCtx.arc(60, 60, 60, 0, Math.PI * 2);
  ciCtx.clip();
  ciCtx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, 120, 120);
  ciCtx.restore();

  // カードプレビュー
  if (cardImg) {
    cardImg.src = sqCanvas.toDataURL('image/png');
  }
}

function saveCustomStudent() {
  const nameInput = document.getElementById('customStudentName');
  const sqCanvas = document.getElementById('previewSquareCanvas');
  if (!nameInput || !nameInput.value.trim() || !sqCanvas) {
    alert('生徒名を入力し、画像をアップロードしてください。');
    return;
  }

  const name = normalizeStudentName(nameInput.value.trim());
  const iconDataUrl = sqCanvas.toDataURL('image/png');

  AppState.customStudents[name] = {
    icon: iconDataUrl,
    createdAt: new Date().toISOString(),
    wikiSynced: false
  };

  persistState();
  alert(`生徒「${name}」のアイコンを仮登録しました！ガチャ入力で利用可能です。`);
  document.getElementById('modalCustomStudent').close();
}

// グローバルAPI公開 (デバッグ・外部連携・自動検証用)
if (typeof window !== 'undefined') {
  window.AppState = AppState;
  window.switchTab = switchTab;
  window.loadDemoGachaData = loadDemoGachaData;
  window.setupInputSheet = setupInputSheet;
  window.updateAllStats = updateAllStats;
  window.renderDirectoryGrid = renderDirectoryGrid;
  window.renderConvergenceChart = renderConvergenceChart;
  window.recalculateCurrentSessionCharges = recalculateCurrentSessionCharges;
  window.loadPreviousBatch = loadPreviousBatch;
  window.commitCurrentSheet = commitCurrentSheet;
  window.addNewBatchImmediately = addNewBatchImmediately;
  window.updateSheetPageIndicator = updateSheetPageIndicator;
  window.renderSheetTimelineNav = renderSheetTimelineNav;
  window.jumpToPullBatch = jumpToPullBatch;
  window.jumpToBatchByIndex = jumpToBatchByIndex;
  window.triggerSheetSlideAnimation = triggerSheetSlideAnimation;
}
