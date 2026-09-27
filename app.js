/**
 * ブルーアーカイブ リアルタイムガチャ集計 (BA Gacha Live Tracker)
 * Version: v1.0.10
 * Core Application Logic & State Management
 */

const APP_VERSION = 'v1.0.10';
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
  if (urlParams.get('demo') === '1' && AppState.pulls.length === 0) {
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
  let loaded = false;

  // 1. GitHub (roundabout-oxygen/ba_gacha_tabulation) から自動フェッチ
  try {
    const res = await fetch(REMOTE_STUDENT_ICONS_URL, { cache: 'no-cache' });
    if (res.ok) {
      AppState.officialStudents = await res.json();
      loaded = true;
      console.log('Successfully fetched student icons from GitHub roundabout-oxygen/ba_gacha_tabulation.');
    }
  } catch (err) {
    console.warn('Could not fetch student icons from remote GitHub:', err);
  }

  // 2. フォールバック: ローカルの data/student_icons.json
  if (!loaded) {
    try {
      const localRes = await fetch('data/student_icons.json');
      if (localRes.ok) {
        AppState.officialStudents = await localRes.json();
        console.log('Loaded student icons from local fallback.');
      }
    } catch (err) {
      console.warn('Could not load local student_icons.json fallback:', err);
    }
  }

  // 3. ローカルの仮登録データ (data/custom_students.json) があればマージ
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
    renderHistoryTable();
    renderDirectoryGrid();
    renderConvergenceChart();
  } else if (tabId === 'tabGacha') {
    // ガチャタブに切り替わった際、シート行が未生成なら自動でセットアップ
    if (!AppState.currentSession.rows || AppState.currentSession.rows.length === 0) {
      setupInputSheet();
    } else {
      applyPullModeUI();
    }
  }
}

// ==========================================================================
// チャージ計算ロジック
// ==========================================================================

/**
 * 直前までのチャージ数を計算
 * ガチャ1回ごとに+1。ピックアップを引いた時点でリセットされ、次から1になる。
 */
function calculateCurrentCharge() {
  let charge = Number(AppState.config.initCharge) || 0;
  for (const pull of AppState.pulls) {
    charge += 1;
    if (pull.isPick) {
      charge = 0; // 次の引きで1になる
    }
  }
  return charge;
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
  }

  AppState.currentSession.rows = rows;
  renderInputSheetTable();
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
    if (p.isPick) {
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
}

/**
 * 「◁ 前の10連へ」: 前の引きをシートに呼び戻して再編集可能にする
 */
function loadPreviousBatch() {
  const batches = getAllBatches();
  if (batches.length === 0) return;

  let targetBatchId = null;
  const currentEditingId = AppState.currentSession.editingBatchId;

  if (!currentEditingId) {
    // 現在新規引き入力中の場合: 最後のバッチへ
    targetBatchId = batches[batches.length - 1];
  } else {
    // すでに過去のバッチを編集中: さらに1つ前のバッチへ
    const currentIdx = batches.indexOf(currentEditingId);
    if (currentIdx > 0) {
      targetBatchId = batches[currentIdx - 1];
    } else {
      return; // 最古のバッチ
    }
  }

  if (targetBatchId) {
    loadBatchById(targetBatchId);
  }
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
  } else {
    AppState.currentSession.editingBatchId = null;
    setupInputSheet();
  }
}

/**
 * 1連モード・10連モードのUI反映 ＆ ボタン状態更新
 */
function applyPullModeUI() {
  const btnPrev = document.getElementById('btnPrevPull');
  const btnToggle = document.getElementById('btnTogglePullCount');
  const btnNext = document.getElementById('btnSheetSubmitNext');
  const btnDelete = document.getElementById('btnDeleteCurrentPull');
  const tbody = document.getElementById('gachaSheetTbody');

  const batches = getAllBatches();
  const currentEditingId = AppState.currentSession.editingBatchId;

  // ボタンテキスト更新 (1連モード時は「前の1連へ」「この1連を削除」「次の1連へ」に連動)
  if (btnPrev) {
    btnPrev.textContent = isSinglePullMode ? '◁ 前の1連へ' : '◁ 前の10連へ';
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

  if (btnNext) {
    btnNext.textContent = isSinglePullMode ? '次の1連へ ▶' : '次の10連へ ▶';
  }

  if (btnDelete) {
    btnDelete.textContent = isSinglePullMode ? 'この1連を削除' : 'この10連を削除';
    if (batches.length === 0 && !currentEditingId) {
      btnDelete.disabled = true;
    } else {
      btnDelete.disabled = false;
    }
  }

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
    if (row.charge === 200) chargeLabel += ' (天井)';
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
    // 新規バッチ追加
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
  }

  // 編集モードをリセット
  AppState.currentSession.editingBatchId = null;

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

function updateAllStats() {
  const pulls = AppState.pulls;
  const totalPulls = pulls.length;
  const pyroxene = totalPulls * 120;

  // ☆３集計
  const threeStarPulls = pulls.filter(p => p.isThreeStar);
  const threeStarCount = threeStarPulls.length;
  const threeStarRate = totalPulls > 0 ? (threeStarCount / totalPulls) * 100 : 0;

  const expectedRate = AppState.config.rate || 0.03;
  const expectedCount = totalPulls * expectedRate;
  const diffCount = threeStarCount - expectedCount;

  // ピックアップ集計
  const pickupPulls = pulls.filter(p => p.isPick);
  const pickupCount = pickupPulls.length;
  const pickupRate = totalPulls > 0 ? (pickupCount / totalPulls) * 100 : 0;
  const expectedPickup = totalPulls * 0.007;

  // 50%勝率集計 (charge === 100 のときの勝敗)
  const fiftyPulls = pulls.filter(p => p.charge === 100);
  const fiftyWins = fiftyPulls.filter(p => p.isPick).length;
  const fiftyLosses = fiftyPulls.length - fiftyWins;
  const fiftyWinRate = fiftyPulls.length > 0 ? (fiftyWins / fiftyPulls.length) * 100 : 0;

  // 現在チャージ
  const currentCharge = calculateCurrentCharge();
  const chargePercent = Math.min(100, (currentCharge % 100));
  const remainingTo100 = 100 - (currentCharge % 100);

  // 1. トップ簡易集計バー反映
  setText('liveStatTotalPulls', totalPulls);
  setText('liveStatPyroxene', pyroxene.toLocaleString());
  setText('liveStatThreeStarRate', threeStarRate.toFixed(2));
  setText('liveStatThreeStarCount', threeStarCount);
  setText('liveStatThreeStarDiff', (diffCount >= 0 ? '+' : '') + diffCount.toFixed(1));
  setText('liveStatPickupRate', pickupRate.toFixed(2));
  setText('liveStatPickupCount', pickupCount);
  setText('liveStatPickupExpected', expectedPickup.toFixed(1));
  setText('liveStatWinRate', fiftyWinRate.toFixed(1));
  setText('liveStatWinCount', fiftyWins);
  setText('liveStatLossCount', fiftyLosses);
  setText('liveStatFiftyTotal', fiftyPulls.length);

  const chargeTextEl = document.getElementById('liveStatChargeText');
  if (chargeTextEl) chargeTextEl.textContent = `${currentCharge} / 100`;
  const chargeFillEl = document.getElementById('liveChargeProgressFill');
  if (chargeFillEl) chargeFillEl.style.width = `${chargePercent}%`;
  const chargeSubEl = document.getElementById('liveChargeSub');
  if (chargeSubEl) chargeSubEl.textContent = `あと ${remainingTo100}連`;

  // 2. ダッシュボードカード反映
  setText('dashTotalPulls', totalPulls);
  setText('dashTotalPyroxene', pyroxene.toLocaleString());
  const tenPulls = pulls.filter(p => p.pullType === '10').length / 10;
  setText('dashTenPullsCount', Math.floor(tenPulls));
  setText('dashSinglePullsCount', pulls.filter(p => p.pullType === '1').length);

  setText('dashThreeStarRate', threeStarRate.toFixed(2));
  setText('dashThreeStarCount', threeStarCount);
  setText('dashThreeStarDiffVal', (diffCount >= 0 ? '+' : '') + diffCount.toFixed(1));

  const luckEvaluation = diffCount > 1.5 ? '大勝利！' : diffCount < -1.5 ? '下振れ中' : '期待値通り';
  setText('dashLuckEvaluation', luckEvaluation);

  setText('dashPickupRate', pickupRate.toFixed(2));
  setText('dashPickupCount', pickupCount);
  setText('dashPickupExpected', expectedPickup.toFixed(1));
  setText('dashNaturalPickupCount', pickupPulls.filter(p => p.charge !== 200).length);
  setText('dashCeilingPickupCount', pickupPulls.filter(p => p.charge === 200).length);

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

  setText('dashCurrentChargeVal', `${currentCharge} `);
  setText('dashChargeRemainingText', `あと ${remainingTo100}連`);

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
      const { ctx, chartArea: { left, right, top, bottom } } = chart;
      if (!chart.scales || !chart.scales.y || !chart.scales.x) return;

      const isDark = document.body.classList.contains('theme-tactical-dark');

      // 最下段 (-100%) のすり抜け生徒用背景帯（ba_gacha_tabulation準拠）
      const yMinus100 = chart.scales.y.getPixelForValue(-100);
      if (yMinus100 >= top && yMinus100 <= bottom + 25) {
        const boxHeight = 34;
        const boxTop = yMinus100 - boxHeight / 2;

        ctx.save();
        ctx.fillStyle = isDark ? 'rgba(22, 36, 54, 0.65)' : 'rgba(228, 236, 246, 0.55)';
        ctx.fillRect(left, boxTop, right - left, boxHeight);

        ctx.strokeStyle = isDark ? 'rgba(0, 174, 239, 0.25)' : 'rgba(0, 174, 239, 0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(left, boxTop, right - left, boxHeight);
        ctx.restore();
      }
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
        // 相対誤差0%の上方にピックアップ(Y=35%)、最下段にピックアップ以外(Y=-100%)
        const targetYVal = isPick ? 35 : -100;
        const centerY = chart.scales.y.getPixelForValue(targetYVal);

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
  pulls.forEach((p, idx) => {
    if (p.isThreeStar) threeCount++;
    const currentN = idx + 1;
    if (currentN % 10 === 0 || currentN === totalPulls || p.isThreeStar) {
      const actRate = (threeCount / currentN);
      const dev = ((actRate - targetRate) / targetRate) * 100;
      points.push({ x: currentN, y: Number(dev.toFixed(2)) });
      actualRatesMap[currentN] = Number((actRate * 100).toFixed(2));
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

  // Y軸の最大値計算（きれいな50刻み丸め）
  const deviations = uniquePoints.map(p => p.y);
  const maxDev = deviations.length > 0 ? Math.max(...deviations) : 0;
  const absMax = Math.max(60, Math.ceil(maxDev * 1.15));
  const yMaxRounded = Math.ceil(absMax / 50) * 50;

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
          min: -120,
          max: yMaxRounded,
          ticks: {
            stepSize: 50,
            color: textColor,
            font: { size: 10 },
            callback: (val) => (val % 50 === 0 ? `${val}%` : '')
          },
          grid: { color: gridColor },
          title: {
            display: true,
            text: '理論値からの相対誤差 (%)',
            color: textColor,
            font: { size: 10 }
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
    } else if (pull.isNew || currentCount === 1) {
      typeText = '新規獲得';
      borderClass = 'border-new';
    } else {
      typeText = 'すり抜け(被り)';
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
    if (p.charge === 200) tdCharge.textContent += ' (天井)';
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
// ⚙ 設定モーダル（キャンセルボタン付き・仮登録・テーマ・確率・引継ぎ）
// ==========================================================================

function openSettingsModal() {
  const modal = document.getElementById('modalSettings');
  if (!modal) return;

  // 現在の設定を一時退避（ディープコピー）
  tempSettingsConfig = JSON.parse(JSON.stringify(AppState.config));

  // UIに反映
  const rateRadio = AppState.config.rate === 0.06
    ? document.getElementById('settingsRate6')
    : document.getElementById('settingsRate3');
  if (rateRadio) rateRadio.checked = true;

  const initChargeInput = document.getElementById('settingsInitChargeInput');
  if (initChargeInput) initChargeInput.value = AppState.config.initCharge || 0;

  renderSettingsPickupTags();

  modal.showModal();
}

function cancelSettingsModal() {
  const modal = document.getElementById('modalSettings');
  if (!modal) return;

  // 変更破棄: 一時退避から復元
  if (tempSettingsConfig) {
    AppState.config = JSON.parse(JSON.stringify(tempSettingsConfig));
  }
  modal.close();
}

function saveSettingsModal() {
  const modal = document.getElementById('modalSettings');
  if (!modal) return;

  // 1. 確率
  const rate6 = document.getElementById('settingsRate6');
  AppState.config.rate = (rate6 && rate6.checked) ? 0.06 : 0.03;

  // 2. チャージ引継ぎ
  const chargeInput = document.getElementById('settingsInitChargeInput');
  if (chargeInput) {
    let val = parseInt(chargeInput.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    if (val > 199) val = 199;
    AppState.config.initCharge = val;
  }

  persistState();
  updateAllStats();
  modal.close();
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
      if (tabId === 'tabSettings') {
        openSettingsModal();
      } else {
        switchTab(tabId);
      }
    });
  });

  // 2. シート操作ボタン（2行構成: 1行目=前の10連/1連切替/次の10連, 2行目=この10連削除/確定）
  const btnPrevPull = document.getElementById('btnPrevPull');
  const btnToggleCount = document.getElementById('btnTogglePullCount');
  const btnSubmitNext = document.getElementById('btnSheetSubmitNext');
  const btnDeleteCurrent = document.getElementById('btnDeleteCurrentPull');
  const btnSubmitOk = document.getElementById('btnSheetSubmitOk');

  if (btnPrevPull) {
    btnPrevPull.addEventListener('click', () => {
      loadPreviousBatch();
    });
  }

  if (btnToggleCount) {
    btnToggleCount.addEventListener('click', () => {
      isSinglePullMode = !isSinglePullMode;
      applyPullModeUI();
    });
  }

  if (btnSubmitNext) {
    btnSubmitNext.addEventListener('click', () => {
      const currentEditingId = AppState.currentSession.editingBatchId;
      commitCurrentSheet();
      if (currentEditingId) {
        const batches = getAllBatches();
        const currentIdx = batches.indexOf(currentEditingId);
        if (currentIdx !== -1 && currentIdx < batches.length - 1) {
          loadBatchById(batches[currentIdx + 1]);
          return;
        }
      }
      setupInputSheet();
    });
  }

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

  if (btnSubmitOk) {
    btnSubmitOk.addEventListener('click', () => {
      commitCurrentSheet();
      setupInputSheet();
      switchTab('tabDashboard');
    });
  }

  // 4. 設定モーダル
  const btnCloseX = document.getElementById('btnCloseSettingsX');
  const btnCancel = document.getElementById('btnCancelSettings');
  const btnSave = document.getElementById('btnSaveSettings');

  if (btnCloseX) btnCloseX.addEventListener('click', cancelSettingsModal);
  if (btnCancel) btnCancel.addEventListener('click', cancelSettingsModal);
  if (btnSave) btnSave.addEventListener('click', saveSettingsModal);

  // ピックアップ追加
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

  // テーマ切り替え
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
      document.getElementById('modalCustomStudent').showModal();
    });
  }
  const btnCloseCustom = document.getElementById('btnCloseCustomModal');
  if (btnCloseCustom) {
    btnCloseCustom.addEventListener('click', () => {
      document.getElementById('modalCustomStudent').close();
    });
  }

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

  // データ初期化
  const btnReset = document.getElementById('btnResetAllData');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      if (confirm('ガチャ履歴を全て初期化しますか？（この操作は取り消せません）')) {
        AppState.pulls = [];
        persistState();
        updateAllStats();
        renderHistoryTable();
        renderDirectoryGrid();
        renderConvergenceChart();
        setupInputSheet(10);
        document.getElementById('modalSettings').close();
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
