/**
 * ブルアカ リアルタイムガチャ集計 (BA Gacha Live Tracker)
 * Version: v1.0.3
 * Core Application Logic
 */

const APP_VERSION = 'v1.0.3';

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
  
  // 現在の入力中シート状態
  currentInputSession: null,

  // Chart.js インスタンス
  chartInstance: null,

  // GitHub連携設定
  github: {
    repoOwner: 'roundabout-oxygen',
    repoName: 'ba-gacha-live-tracker',
    token: ''
  }
};

// ==========================================================================
// ユーティリティ関数（平仮名・カタカナ変換、正規化）
// ==========================================================================

/**
 * 平仮名をカタカナに変換する
 */
function hiraganaToKatakana(str) {
  if (!str) return '';
  return str.replace(/[\u3041-\u3096]/g, match => {
    const charCode = match.charCodeAt(0) + 0x60;
    return String.fromCharCode(charCode);
  });
}

/**
 * カタカナを平仮名に変換する
 */
function katakanaToHiragana(str) {
  if (!str) return '';
  return str.replace(/[\u30a1-\u30f6]/g, match => {
    const charCode = match.charCodeAt(0) - 0x60;
    return String.fromCharCode(charCode);
  });
}

/**
 * 生徒名の表記揺れを正規化する（半角カッコを全角カッコに統一、前後トリム）
 */
function normalizeStudentName(name) {
  if (!name) return '';
  let res = name.trim();
  res = res.replace(/\(/g, '（').replace(/\)/g, '）');
  return res;
}

// ==========================================================================
// 初期化とイベントリスナー
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // バージョン表示更新
  const versionBadge = document.getElementById('appVersionBadge');
  if (versionBadge) versionBadge.textContent = APP_VERSION;

  // ローカルストレージから設定とデータを読み込み
  loadSavedState();

  // 生徒アイコンデータの読み込み
  await loadStudentDictionaries();

  // UIイベントの初期化
  initUIEventListeners();

  // トリミング機能の初期化
  initCropperEngine();

  // 画面状態の復元
  const urlParams = new URLSearchParams(window.location.search);
  const requestedView = urlParams.get('view');
  const isDemo = urlParams.get('demo');

  // デモデータ注入（テスト用）
  if (isDemo && AppState.pulls.length === 0) {
    loadDemoGachaData();
  }

  if (requestedView === 'sheet') {
    showGachaInputView(10);
  } else if (requestedView === 'custom') {
    setTimeout(() => {
      document.getElementById('btnOpenCustomModal').click();
      loadDefaultSampleImageForCropper();
    }, 200);
  } else if (requestedView === 'editor') {
    setTimeout(() => {
      openCustomEditorModal();
    }, 200);
  } else if (requestedView === 'dashboard' || AppState.pulls.length > 0) {
    showDashboardView();
  } else {
    showWelcomeView();
  }

  // 統計とヘッダーの初回更新
  updateAllStats();
});

/**
 * テスト・デモ用のガチャデータ生成
 */
function loadDemoGachaData() {
  AppState.config.rate = 0.03;
  AppState.config.initCharge = 94; // 添付2枚目の例（95連目スタート）
  AppState.config.pickupStudents = ['ココロ'];

  const demoPulls = [];
  // 1〜10連目（累計1〜10、チャージ95〜104）
  const names = ['', '', '', '', '', 'ヒナ', '', '', '', 'ココロ'];
  let charge = 94;
  for (let i = 0; i < 10; i++) {
    charge += 1;
    const name = names[i];
    const isPick = name === 'ココロ';
    const isThreeStar = Boolean(name);
    const isGuaranteed50 = (charge === 100);
    demoPulls.push({
      id: i + 1,
      pullType: '10',
      batchId: 'demo_batch_1',
      seqInBatch: i + 1,
      totalPullIndex: i + 1,
      charge: charge,
      studentName: name,
      isThreeStar: isThreeStar,
      isPick: isPick,
      isNew: isThreeStar,
      isGuaranteed50: isGuaranteed50,
      isGuaranteed100: false,
      createdAt: new Date().toISOString()
    });
    if (isPick) charge = 0;
  }

  AppState.pulls = demoPulls;
  persistState();
}

/**
 * クロッパーに初期サンプル画像（ココロ）をロード
 */
function loadDefaultSampleImageForCropper() {
  const img = new Image();
  img.onload = () => {
    CropperState.img = img;
    resetCropperPosition();
    const tools = document.getElementById('cropperTools');
    if (tools) tools.style.display = 'flex';
    const ph = document.getElementById('cropPlaceholder');
    if (ph) ph.style.display = 'none';
    const nameInput = document.getElementById('customStudentName');
    if (nameInput) nameInput.value = 'ココロ';
    drawCropCanvas();
    checkCustomSaveButtonState();
  };
  img.src = 'data/temp_students/kokoro_sample.png';
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
    const savedGh = localStorage.getItem('ba_github_token');
    if (savedGh) {
      AppState.github.token = savedGh;
      const tokenInput = document.getElementById('githubTokenInput');
      if (tokenInput) tokenInput.value = savedGh;
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
  } catch (err) {
    console.error('Failed to persist state:', err);
  }
}

// ==========================================================================
// 生徒アイコン辞書のロード & Wiki同期クリーンアップ
// ==========================================================================

async function loadStudentDictionaries() {
  // 1. 公式Wikiデータ (data/student_icons.json) をフェッチ
  try {
    const res = await fetch('data/student_icons.json');
    if (res.ok) {
      AppState.officialStudents = await res.json();
    }
  } catch (e) {
    console.warn('Could not fetch data/student_icons.json:', e);
  }

  // 2. 共有の仮登録データ (data/custom_students.json) をフェッチしてマージ
  try {
    const resCustom = await fetch('data/custom_students.json');
    if (resCustom.ok) {
      const remoteCustom = await resCustom.json();
      if (remoteCustom && remoteCustom.students) {
        AppState.customStudents = Object.assign({}, remoteCustom.students, AppState.customStudents);
      }
    }
  } catch (e) {
    console.warn('Could not fetch data/custom_students.json:', e);
  }

  // 3. Wiki公式更新時の自動クリーンアップ判定
  cleanupSyncedCustomStudents(false);
}

/**
 * Wiki公式データに同名生徒が登録された場合、仮登録から自動削除・移行する
 */
function cleanupSyncedCustomStudents(showNotification = true) {
  const removedNames = [];
  const customKeys = Object.keys(AppState.customStudents);

  customKeys.forEach(name => {
    const norm = normalizeStudentName(name);
    // 公式Wiki図鑑に存在するか確認
    if (AppState.officialStudents[norm] || AppState.officialStudents[name]) {
      removedNames.push(name);
      delete AppState.customStudents[name];
    }
  });

  if (removedNames.length > 0) {
    persistState();
    renderCustomStudentsTable();
    if (showNotification) {
      alert(`【Wikiデータ同期】以下の生徒がWiki公式図鑑に追加されたため、仮登録から正規データへと移行・自動整理されました：\n\n・${removedNames.join('\n・')}`);
    }
  } else if (showNotification) {
    alert('【Wikiデータ同期】仮登録の生徒の中に、現在Wiki公式に追加された重複生徒はありませんでした。すべて最新です。');
  }
}

/**
 * 生徒名からアイコン画像URLを取得（仮登録優先 → Wiki公式）
 */
function getStudentIconUrl(studentName) {
  if (!studentName) return '';
  const norm = normalizeStudentName(studentName);
  
  // 仮登録にあるか確認
  if (AppState.customStudents[norm] && AppState.customStudents[norm].icon) {
    return AppState.customStudents[norm].icon;
  }
  if (AppState.customStudents[studentName] && AppState.customStudents[studentName].icon) {
    return AppState.customStudents[studentName].icon;
  }

  // Wiki公式図鑑にあるか確認
  if (AppState.officialStudents[norm]) {
    return AppState.officialStudents[norm];
  }
  if (AppState.officialStudents[studentName]) {
    return AppState.officialStudents[studentName];
  }

  return '';
}

/**
 * 生徒名サジェスト検索（平仮名・カタカナ前方一致 & あいまい検索）
 */
function searchStudents(query) {
  if (!query || !query.trim()) return [];
  const q = query.trim();
  const qKatakana = hiraganaToKatakana(q);
  const qHiragana = katakanaToHiragana(q);

  // 全生徒名リスト（公式 + 仮登録）
  const allNames = Array.from(new Set([
    ...Object.keys(AppState.customStudents),
    ...Object.keys(AppState.officialStudents)
  ]));

  const startsWithMatches = [];
  const includesMatches = [];

  allNames.forEach(name => {
    const normName = normalizeStudentName(name);
    const nameHiragana = katakanaToHiragana(normName);

    // 前方一致
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

  // 前方一致を優先して結合
  return [...startsWithMatches, ...includesMatches].slice(0, 20);
}

// ==========================================================================
// 画面切り替え (Welcome, GachaInput, Dashboard)
// ==========================================================================

function showWelcomeView() {
  document.getElementById('viewWelcome').style.display = 'block';
  document.getElementById('viewGachaInput').style.display = 'none';
  document.getElementById('viewDashboard').style.display = 'none';
  renderWelcomeForm();
}

function showDashboardView() {
  document.getElementById('viewWelcome').style.display = 'none';
  document.getElementById('viewGachaInput').style.display = 'none';
  document.getElementById('viewDashboard').style.display = 'block';
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
}

function showGachaInputView(pullCount = 10) {
  document.getElementById('viewWelcome').style.display = 'none';
  document.getElementById('viewGachaInput').style.display = 'block';
  document.getElementById('viewDashboard').style.display = 'none';

  // 10連または1連の入力シートを構築
  setupInputSession(pullCount);
}

// ==========================================================================
// ガチャ進行＆チャージ計算ロジック
// ==========================================================================

/**
 * 現在の累積ガチャ回数を取得
 */
function getTotalPullsCount() {
  return AppState.pulls.length;
}

/**
 * 直前までのチャージ数を計算
 * ガチャ1回ごとに+1。ピックアップを引いた時点でリセットされ、次から1になる。
 */
function calculateCurrentCharge() {
  let charge = Number(AppState.config.initCharge) || 0;
  for (const pull of AppState.pulls) {
    charge += 1;
    if (pull.isPick) {
      charge = 0; // 引いた時点でリセット（次の引きは1からスタート）
    }
  }
  return charge;
}

/**
 * 10連/1連の入力シートセッションを開始
 */
function setupInputSession(count = 10) {
  const currentTotal = getTotalPullsCount();
  const startCharge = calculateCurrentCharge();

  AppState.currentInputSession = {
    count: count,
    startTotal: currentTotal,
    startCharge: startCharge,
    rows: []
  };

  // 行データの初期化
  let runningCharge = startCharge;
  for (let i = 1; i <= count; i++) {
    runningCharge += 1;
    AppState.currentInputSession.rows.push({
      seq: i,
      total: currentTotal + i,
      charge: runningCharge,
      studentName: '',
      isPick: false,
      isNew: false
    });
  }

  // シートUIの表示更新
  const sheetTitle = document.getElementById('sheetPullTitle');
  const sheetSub = document.getElementById('sheetPullSubtitle');
  const btnNext = document.getElementById('btnSheetSubmitNext');

  if (count === 10) {
    sheetTitle.textContent = '✨ 10連 ガチャ入力シート';
    sheetSub.textContent = `累計 ${currentTotal + 1} 〜 ${currentTotal + 10} 連目`;
    btnNext.textContent = '次の10連 →';
  } else {
    sheetTitle.textContent = '⚡ 1連 ガチャ入力シート';
    sheetSub.textContent = `累計 ${currentTotal + 1} 連目`;
    btnNext.textContent = '次の1連 →';
  }

  const modeText = AppState.config.rate === 0.06 ? '6% フェス' : '3% 通常';
  document.getElementById('sheetModeBadge').textContent = modeText;
  document.getElementById('sheetCurrentChargeBadge').textContent = `開始チャージ: ${startCharge}`;

  renderInputSheetTable();
}

/**
 * 入力シートテーブルの再描画＆チャージ動的再計算
 */
function renderInputSheetTable() {
  const tbody = document.getElementById('gachaSheetTbody');
  if (!tbody || !AppState.currentInputSession) return;

  const session = AppState.currentInputSession;
  tbody.innerHTML = '';

  // 動的チャージ再計算
  // ユーザーが途中の行で pick にチェックを入れたら、その次の行のチャージは1からリスタート！
  let runningCharge = session.startCharge;

  session.rows.forEach((row, idx) => {
    runningCharge += 1;
    row.charge = runningCharge;

    const tr = document.createElement('tr');
    tr.dataset.rowIndex = idx;

    // ☆3が入力されているか
    if (row.studentName.trim()) {
      tr.classList.add('row-three-star');
    }

    // チャージセルのクラス判定 (100は薄黄色ハイライト、200は天井)
    let chargeClass = 'col-charge';
    if (row.charge === 100) {
      chargeClass += ' charge-cell-100';
    } else if (row.charge >= 200) {
      chargeClass += ' charge-cell-200';
    }

    tr.innerHTML = `
      <td class="col-seq">${row.seq}</td>
      <td class="col-total">${row.total}</td>
      <td class="${chargeClass}">${row.charge}</td>
      <td class="col-name sheet-name-input-cell">
        <input type="text" class="sheet-name-input" data-index="${idx}" value="${escapeHtml(row.studentName)}" placeholder="☆3生徒名を手打ち..." autocomplete="off">
      </td>
      <td class="col-pick">
        <input type="checkbox" class="sheet-checkbox check-pick" data-index="${idx}" ${row.isPick ? 'checked' : ''}>
      </td>
      <td class="col-new">
        <input type="checkbox" class="sheet-checkbox check-new" data-index="${idx}" ${row.isNew ? 'checked' : ''}>
      </td>
    `;

    tbody.appendChild(tr);

    // もしこの行で pick が true なら、次の引きからチャージは 0 にリセット（次の行は +1 されて 1 からスタート）
    if (row.isPick) {
      runningCharge = 0;
    }
  });

  // テーブル内イベントハンドラを設定
  attachInputSheetEvents();
}

/**
 * 入力シート内のイベントリスナー
 */
function attachInputSheetEvents() {
  const tbody = document.getElementById('gachaSheetTbody');
  if (!tbody) return;

  // 生徒名インプット
  const nameInputs = tbody.querySelectorAll('.sheet-name-input');
  nameInputs.forEach(input => {
    const idx = parseInt(input.dataset.index, 10);

    input.addEventListener('focus', (e) => {
      openStudentGuidePopup(input, idx);
    });

    input.addEventListener('input', (e) => {
      const val = normalizeStudentName(e.target.value);
      AppState.currentInputSession.rows[idx].studentName = val;
      updatePopupSuggestions(val, input, idx);
    });

    input.addEventListener('blur', (e) => {
      // 少しディレイしてポップアップクリックを許容
      setTimeout(() => {
        closeStudentGuidePopup();
        // 生徒名確定処理
        handleStudentNameCommit(idx);
      }, 200);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        selectFirstPopupSuggestion(idx);
      }
    });
  });

  // pick チェックボックス
  const pickBoxes = tbody.querySelectorAll('.check-pick');
  pickBoxes.forEach(box => {
    box.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      AppState.currentInputSession.rows[idx].isPick = e.target.checked;
      // ピックアップのチェック変更により後続のチャージ数が変わるため再描画
      refreshSheetChargeOnly();
    });
  });

  // new チェックボックス
  const newBoxes = tbody.querySelectorAll('.check-new');
  newBoxes.forEach(box => {
    box.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      AppState.currentInputSession.rows[idx].isNew = e.target.checked;
    });
  });
}

/**
 * 生徒名確定時の自動判定（PU自動チェック、新規自動判定、チャージ再計算）
 */
function handleStudentNameCommit(idx) {
  if (!AppState.currentInputSession) return;
  const row = AppState.currentInputSession.rows[idx];
  const name = row.studentName.trim();

  if (name) {
    // 1. ピックアップ対象生徒なら自動で pick チェックON
    const isPu = AppState.config.pickupStudents.includes(name);
    if (isPu) {
      row.isPick = true;
    }

    // 2. 過去の獲得履歴および現在のセッション内に同一生徒が未所持なら自動で new チェックON
    const previouslyOwned = AppState.pulls.some(p => p.studentName === name);
    const earlierInSession = AppState.currentInputSession.rows.slice(0, idx).some(r => r.studentName === name);
    if (!previouslyOwned && !earlierInSession) {
      row.isNew = true;
    }
  } else {
    // 生徒名が空になったらチェックを外す
    row.isPick = false;
    row.isNew = false;
  }

  // チャージを再計算してシートを更新
  refreshSheetChargeOnly();
}

/**
 * シートのチャージ列とチェックボックスの整合性を崩さずに再計算して反映
 */
function refreshSheetChargeOnly() {
  if (!AppState.currentInputSession) return;
  const session = AppState.currentInputSession;
  let runningCharge = session.startCharge;

  session.rows.forEach((row, idx) => {
    runningCharge += 1;
    row.charge = runningCharge;

    const tr = document.querySelector(`#gachaSheetTbody tr[data-row-index="${idx}"]`);
    if (tr) {
      const chargeTd = tr.querySelector('.col-charge');
      if (chargeTd) {
        chargeTd.textContent = row.charge;
        chargeTd.className = 'col-charge';
        if (row.charge === 100) chargeTd.classList.add('charge-cell-100');
        if (row.charge >= 200) chargeTd.classList.add('charge-cell-200');
      }

      const pickCb = tr.querySelector('.check-pick');
      if (pickCb) pickCb.checked = row.isPick;

      const newCb = tr.querySelector('.check-new');
      if (newCb) newCb.checked = row.isNew;

      if (row.studentName.trim()) {
        tr.classList.add('row-three-star');
      } else {
        tr.classList.remove('row-three-star');
      }
    }

    if (row.isPick) {
      runningCharge = 0;
    }
  });
}

// ==========================================================================
// 生徒名オートコンプリート・ポップアップ（ガイド）
// ==========================================================================

let activePopupRowIndex = -1;

function openStudentGuidePopup(inputEl, rowIndex) {
  activePopupRowIndex = rowIndex;
  const popup = document.getElementById('studentInputGuidePopup');
  if (!popup) return;

  const rect = inputEl.getBoundingClientRect();
  popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
  popup.style.left = `${rect.left + window.scrollX}px`;
  popup.style.display = 'flex';

  updatePopupSuggestions(inputEl.value, inputEl, rowIndex);
}

function closeStudentGuidePopup() {
  const popup = document.getElementById('studentInputGuidePopup');
  if (popup) popup.style.display = 'none';
  activePopupRowIndex = -1;
}

function updatePopupSuggestions(query, inputEl, rowIndex) {
  const listEl = document.getElementById('guidePopupList');
  const countEl = document.getElementById('guideResultCount');
  if (!listEl || !countEl) return;

  // 検索または全☆3生徒一覧
  let matches = [];
  if (query && query.trim()) {
    matches = searchStudents(query);
  } else {
    // 空欄時はピックアップ生徒および代表的な生徒を表示
    matches = [
      ...AppState.config.pickupStudents,
      ...Object.keys(AppState.customStudents),
      ...Object.keys(AppState.officialStudents).slice(0, 15)
    ];
    matches = Array.from(new Set(matches)).slice(0, 15);
  }

  countEl.textContent = `${matches.length} 件`;
  listEl.innerHTML = '';

  if (matches.length === 0) {
    listEl.innerHTML = '<div style="padding: 10px; font-size:12px; color:#64748b;">候補が見つかりません（手打ちのまま確定できます）</div>';
    return;
  }

  matches.forEach((name, i) => {
    const item = document.createElement('div');
    item.className = 'guide-item';
    if (i === 0) item.classList.add('selected');

    const iconUrl = getStudentIconUrl(name);
    const isPu = AppState.config.pickupStudents.includes(name);

    item.innerHTML = `
      <img src="${iconUrl}" class="guide-avatar" onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 32 32\\'><circle cx=\\'16\\' cy=\\'16\\' r=\\'15\\' fill=\\'%23e2e8f0\\'/></svg>'">
      <div class="guide-info">
        <span class="guide-name">${escapeHtml(name)}</span>
        <span class="guide-tag">${isPu ? '🟡 ピックアップ生徒' : '☆3生徒'}</span>
      </div>
    `;

    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // blur防止
      applyStudentSelection(name, rowIndex);
    });

    listEl.appendChild(item);
  });
}

function selectFirstPopupSuggestion(rowIndex) {
  const listEl = document.getElementById('guidePopupList');
  if (!listEl) return;
  const firstItem = listEl.querySelector('.guide-item');
  if (firstItem) {
    const nameEl = firstItem.querySelector('.guide-name');
    if (nameEl) {
      applyStudentSelection(nameEl.textContent, rowIndex);
    }
  }
}

function applyStudentSelection(studentName, rowIndex) {
  if (!AppState.currentInputSession) return;
  const row = AppState.currentInputSession.rows[rowIndex];
  row.studentName = studentName;

  const input = document.querySelector(`.sheet-name-input[data-index="${rowIndex}"]`);
  if (input) {
    input.value = studentName;
  }

  handleStudentNameCommit(rowIndex);
  closeStudentGuidePopup();
}

// ==========================================================================
// シート入力の確定（OK / 次の10連）
// ==========================================================================

function commitCurrentInputSession() {
  if (!AppState.currentInputSession) return;
  const session = AppState.currentInputSession;
  const batchId = 'batch_' + Date.now();

  session.rows.forEach(r => {
    const isThreeStar = Boolean(r.studentName.trim());
    const isGuaranteed50 = (r.charge === 100);
    const isGuaranteed100 = (r.charge >= 200);

    AppState.pulls.push({
      id: AppState.pulls.length + 1,
      pullType: session.count === 10 ? '10' : '1',
      batchId: batchId,
      seqInBatch: r.seq,
      totalPullIndex: r.total,
      charge: r.charge,
      studentName: r.studentName.trim(),
      isThreeStar: isThreeStar,
      isPick: r.isPick,
      isNew: r.isNew,
      isGuaranteed50: isGuaranteed50,
      isGuaranteed100: isGuaranteed100,
      createdAt: new Date().toISOString()
    });
  });

  persistState();
  AppState.currentInputSession = null;
}

// ==========================================================================
// 統計計算ロジック
// ==========================================================================

function calculateStats() {
  const totalPulls = AppState.pulls.length;
  const pyroxene = totalPulls * 120;

  let threeStarCount = 0;
  let pickupCount = 0;
  let naturalPickupCount = 0;
  let ceilingPickupCount = 0;

  let fiftyWins = 0;
  let fiftyLosses = 0;
  let ceilingCount = 0;

  let maxStreak = 0;
  let currentStreak = 0;

  // ガチャ履歴を走査
  for (let i = 0; i < totalPulls; i++) {
    const pull = AppState.pulls[i];

    if (pull.isThreeStar) {
      threeStarCount++;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
      currentStreak = 0;
    } else {
      currentStreak++;
    }

    if (pull.isPick) {
      pickupCount++;
      if (pull.isGuaranteed100) {
        ceilingPickupCount++;
      } else {
        naturalPickupCount++;
      }
    }

    // 100連目（50%枠）の勝敗判定
    if (pull.charge === 100) {
      if (pull.isPick) {
        fiftyWins++;
      } else {
        fiftyLosses++;
      }
    }

    // 200連目（天井到達）判定
    if (pull.charge >= 200) {
      ceilingCount++;
    }
  }

  if (currentStreak > maxStreak) maxStreak = currentStreak;

  // 実測確率
  const targetRate = AppState.config.rate; // 0.03 or 0.06
  const threeStarRate = totalPulls > 0 ? (threeStarCount / totalPulls) * 100 : 0;
  const pickupRate = totalPulls > 0 ? (pickupCount / totalPulls) * 100 : 0;
  const fiftyTotal = fiftyWins + fiftyLosses;
  const winRate = fiftyTotal > 0 ? (fiftyWins / fiftyTotal) * 100 : 0;

  // 期待値と過不足
  const expectedThreeStar = totalPulls * targetRate;
  const threeStarDiff = threeStarCount - expectedThreeStar;
  const expectedPickup = totalPulls * 0.007; // ブルアカのピックアップ公表期待値 0.7%

  // 現在のチャージ数
  const currentCharge = calculateCurrentCharge();

  // ガチャ運評価
  let luckRank = '普通';
  if (totalPulls >= 10) {
    if (threeStarDiff >= 2.0) luckRank = '神引き (大上振れ)';
    else if (threeStarDiff >= 0.5) luckRank = '上振れ';
    else if (threeStarDiff <= -2.0) luckRank = '大爆死 (大下振れ)';
    else if (threeStarDiff <= -0.5) luckRank = '下振れ';
  }

  return {
    totalPulls,
    pyroxene,
    threeStarCount,
    threeStarRate,
    targetRate,
    expectedThreeStar,
    threeStarDiff,
    pickupCount,
    pickupRate,
    expectedPickup,
    naturalPickupCount,
    ceilingPickupCount,
    fiftyWins,
    fiftyLosses,
    fiftyTotal,
    winRate,
    ceilingCount,
    currentCharge,
    maxStreak,
    currentStreak,
    luckRank
  };
}

/**
 * 全ての統計表示とヘッダーを同期更新
 */
function updateAllStats() {
  const stats = calculateStats();

  // 1. トップ固定ヘッダー (常時表示ステータスバー)
  document.getElementById('liveStatTotalPulls').textContent = stats.totalPulls;
  document.getElementById('liveStatPyroxene').textContent = stats.pyroxene.toLocaleString();

  const isFest = stats.targetRate === 0.06;
  const modeText = isFest ? '6% フェス募集' : '3% 通常募集';
  document.getElementById('headerGachaModeText').textContent = modeText;
  document.getElementById('liveThreeStarLabel').textContent = `☆3確率 (${isFest ? '6%' : '3%'}枠)`;
  document.getElementById('liveStatThreeStarRate').textContent = stats.threeStarRate.toFixed(2);
  document.getElementById('liveStatThreeStarCount').textContent = stats.threeStarCount;
  
  const diffSign = stats.threeStarDiff >= 0 ? `+${stats.threeStarDiff.toFixed(1)}` : stats.threeStarDiff.toFixed(1);
  document.getElementById('liveStatThreeStarDiff').textContent = diffSign;

  document.getElementById('liveStatPickupRate').textContent = stats.pickupRate.toFixed(2);
  document.getElementById('liveStatPickupCount').textContent = stats.pickupCount;
  document.getElementById('liveStatPickupExpected').textContent = stats.expectedPickup.toFixed(1);

  document.getElementById('liveStatWinRate').textContent = stats.winRate.toFixed(1);
  document.getElementById('liveStatWinCount').textContent = stats.fiftyWins;
  document.getElementById('liveStatLossCount').textContent = stats.fiftyLosses;
  document.getElementById('liveStatFiftyTotal').textContent = stats.fiftyTotal;

  // チャージプログレス
  const chargeTarget = stats.currentCharge < 100 ? 100 : 200;
  const chargePercent = Math.min(100, (stats.currentCharge / chargeTarget) * 100);
  document.getElementById('liveStatChargeText').textContent = `${stats.currentCharge} / ${chargeTarget}`;
  document.getElementById('liveChargeProgressFill').style.width = `${chargePercent}%`;
  const remaining = chargeTarget - stats.currentCharge;
  document.getElementById('liveChargeSub').textContent = `${chargeTarget}連まであと ${remaining}連`;

  // 2. ダッシュボード画面カード
  document.getElementById('dashTotalPulls').textContent = stats.totalPulls;
  document.getElementById('dashTotalPyroxene').textContent = stats.pyroxene.toLocaleString();
  const tenPulls = AppState.pulls.filter(p => p.pullType === '10').length / 10;
  const singlePulls = AppState.pulls.filter(p => p.pullType === '1').length;
  document.getElementById('dashTenPullsCount').textContent = tenPulls;
  document.getElementById('dashSinglePullsCount').textContent = singlePulls;

  document.getElementById('dashThreeStarTitle').textContent = `☆3確率 (${isFest ? '6%フェス枠' : '3%通常枠'})`;
  document.getElementById('dashThreeStarBadge').textContent = isFest ? 'フェス6%' : '通常3%';
  document.getElementById('dashThreeStarRate').textContent = stats.threeStarRate.toFixed(2);
  document.getElementById('dashThreeStarCount').textContent = stats.threeStarCount;
  document.getElementById('dashThreeStarDiffVal').textContent = diffSign;
  document.getElementById('dashLuckEvaluation').textContent = stats.luckRank;

  document.getElementById('dashPickupRate').textContent = stats.pickupRate.toFixed(2);
  document.getElementById('dashPickupCount').textContent = stats.pickupCount;
  document.getElementById('dashPickupExpected').textContent = stats.expectedPickup.toFixed(1);
  document.getElementById('dashNaturalPickupCount').textContent = stats.naturalPickupCount;
  document.getElementById('dashCeilingPickupCount').textContent = stats.ceilingPickupCount;

  document.getElementById('dashWinRate').textContent = stats.winRate.toFixed(1);
  document.getElementById('dashWinsCount').textContent = stats.fiftyWins;
  document.getElementById('dashLossesCount').textContent = stats.fiftyLosses;
  document.getElementById('dashFiftyTotalCount').textContent = stats.fiftyTotal;

  document.getElementById('chartTargetPercent').textContent = (stats.targetRate * 100).toFixed(1);

  document.getElementById('dashMaxStreak').innerHTML = `${stats.maxStreak} <span class="unit">連</span>`;
  document.getElementById('dashCurrentStreak').textContent = stats.currentStreak;
  document.getElementById('dashCeilingCount').innerHTML = `${stats.ceilingCount} <span class="unit">回</span>`;
  const ceilingRate = stats.totalPulls >= 200 ? ((stats.ceilingCount * 200) / stats.totalPulls * 100).toFixed(1) : '0.0';
  document.getElementById('dashCeilingRate').textContent = ceilingRate;
  document.getElementById('dashLuckRank').textContent = stats.luckRank;

  document.getElementById('dashCurrentChargeVal').innerHTML = `${stats.currentCharge} <span class="unit">/ ${chargeTarget}</span>`;
  document.getElementById('dashChargeRemainingText').textContent = `次の${chargeTarget === 100 ? '50%枠' : '天井'}まで あと ${remaining}連`;

  // 3. 配信HUDオーバーレイ
  document.getElementById('streamTotalPulls').textContent = stats.totalPulls;
  document.getElementById('streamThreeStarRate').textContent = `${stats.threeStarRate.toFixed(2)}%`;
  document.getElementById('streamPickupRate').textContent = `${stats.pickupRate.toFixed(2)}%`;
  document.getElementById('streamWinRate').textContent = `${stats.winRate.toFixed(1)}%`;
  document.getElementById('streamCharge').textContent = `${stats.currentCharge}/${chargeTarget}`;
  document.getElementById('streamModeBadge').textContent = modeText;
}

// ==========================================================================
// Chart.js 確率収束グラフ（単一確率線に最適化）
// ==========================================================================

function renderConvergenceChart() {
  const canvas = document.getElementById('gachaConvergenceChart');
  if (!canvas) return;

  const targetRatePercent = AppState.config.rate * 100;
  const labels = [];
  const actualRates = [];
  const targetRates = [];

  let cumThreeStar = 0;

  // 10連ごと、または5連ごとにサンプリングしてグラフ化
  for (let i = 0; i < AppState.pulls.length; i++) {
    const p = AppState.pulls[i];
    if (p.isThreeStar) cumThreeStar++;

    // 10連の区切りまたは最終引きでプロット
    if ((i + 1) % 10 === 0 || i === AppState.pulls.length - 1) {
      const pullNum = i + 1;
      labels.push(`${pullNum}連`);
      const currentRate = (cumThreeStar / pullNum) * 100;
      actualRates.push(parseFloat(currentRate.toFixed(2)));
      targetRates.push(targetRatePercent);
    }
  }

  // 既存チャートの破棄
  if (AppState.chartInstance) {
    AppState.chartInstance.destroy();
  }

  const ctx = canvas.getContext('2d');
  AppState.chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '実測☆3確率 (%)',
          data: actualRates,
          borderColor: '#00aeef',
          backgroundColor: 'rgba(0, 174, 239, 0.1)',
          fill: true,
          tension: 0.2,
          borderWidth: 3,
          pointRadius: 4,
          pointBackgroundColor: '#00aeef'
        },
        {
          label: `公表確率基準線 (${targetRatePercent}%)`,
          data: targetRates,
          borderColor: '#94a3b8',
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${context.parsed.y.toFixed(2)}%`;
            }
          }
        }
      },
      scales: {
        y: {
          min: 0,
          suggestedMax: Math.max(targetRatePercent * 2, 8),
          ticks: {
            callback: function(val) { return val + '%'; }
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.05)'
          }
        },
        x: {
          grid: {
            display: false
          }
        }
      }
    }
  });
}

// ==========================================================================
// 排出☆3生徒図鑑 & ガチャ履歴テーブル描画
// ==========================================================================

function renderDirectoryGrid() {
  const container = document.getElementById('dashStudentsGrid');
  const empty = document.getElementById('dashStudentsEmpty');
  const countSpan = document.getElementById('dashStudentsTotalCount');
  if (!container) return;

  // 排出された☆3生徒を抽出
  const threeStarPulls = AppState.pulls.filter(p => p.isThreeStar && p.studentName.trim());
  countSpan.textContent = threeStarPulls.length;

  if (threeStarPulls.length === 0) {
    container.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  // 生徒ごとの獲得回数集計
  const studentMap = new Map();
  threeStarPulls.forEach(pull => {
    const name = pull.studentName.trim();
    if (!studentMap.has(name)) {
      studentMap.set(name, {
        name: name,
        iconUrl: getStudentIconUrl(name),
        isPick: pull.isPick,
        isNew: pull.isNew,
        isGuaranteed50: pull.isGuaranteed50,
        isGuaranteed100: pull.isGuaranteed100,
        count: 0
      });
    }
    const entry = studentMap.get(name);
    entry.count++;
    if (pull.isPick) entry.isPick = true;
    if (pull.isGuaranteed100) entry.isGuaranteed100 = true;
    if (pull.isGuaranteed50) entry.isGuaranteed50 = true;
  });

  container.innerHTML = '';
  studentMap.forEach(item => {
    const card = document.createElement('div');
    card.className = 'student-card-item';

    // 枠色クラスの決定
    let frameClass = 'frame-regular';
    let tagText = '通常';
    let tagClass = 'badge-regular';

    if (item.isGuaranteed100) {
      frameClass = 'frame-exchange';
      tagText = '天井交換';
      tagClass = 'badge-exchange';
    } else if (item.isPick) {
      frameClass = 'frame-pu';
      tagText = 'PU';
      tagClass = 'badge-pu';
    } else if (item.isGuaranteed50) {
      frameClass = 'frame-fifty';
      tagText = '50%枠';
      tagClass = 'badge-fifty';
    } else if (item.isNew) {
      frameClass = 'frame-new';
      tagText = '新規';
      tagClass = 'badge-new';
    }

    card.innerHTML = `
      <div class="student-avatar-frame ${frameClass}">
        <img src="${item.iconUrl}" class="student-avatar-img" onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 32 32\\'><circle cx=\\'16\\' cy=\\'16\\' r=\\'15\\' fill=\\'%23e2e8f0\\'/></svg>'">
        ${item.count > 1 ? `<div class="student-dup-badge">${item.count}回目</div>` : ''}
      </div>
      <div class="student-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
      <div class="student-item-tag ${tagClass}">${tagText}</div>
    `;

    container.appendChild(card);
  });
}

function renderHistoryTable() {
  const tbody = document.getElementById('historyTableTbody');
  const countSpan = document.getElementById('historyRowCount');
  if (!tbody) return;

  countSpan.textContent = AppState.pulls.length;
  tbody.innerHTML = '';

  if (AppState.pulls.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">ガチャ履歴がまだありません。</td></tr>';
    return;
  }

  // 最新順（降順）で表示
  const reversed = [...AppState.pulls].reverse();

  reversed.forEach(p => {
    const tr = document.createElement('tr');
    if (p.isThreeStar) tr.classList.add('row-three-star');

    let badgeType = '-';
    if (p.isGuaranteed100) badgeType = '<span class="badge-legend badge-exchange">天井確定</span>';
    else if (p.isGuaranteed50) badgeType = '<span class="badge-legend badge-fifty">100連50%</span>';
    else if (p.isThreeStar) badgeType = '<span class="badge-legend badge-regular">☆3通常</span>';

    tr.innerHTML = `
      <td>${p.seqInBatch} (${p.pullType}連)</td>
      <td><b>${p.totalPullIndex}</b></td>
      <td class="${p.charge === 100 ? 'charge-cell-100' : (p.charge >= 200 ? 'charge-cell-200' : '')}">${p.charge}</td>
      <td>
        ${p.studentName ? `
          <div style="display:flex; align-items:center; gap:6px;">
            <img src="${getStudentIconUrl(p.studentName)}" style="width:24px; height:24px; border-radius:50%; object-fit:cover;">
            <b>${escapeHtml(p.studentName)}</b>
          </div>
        ` : '<span style="color:#94a3b8;">-</span>'}
      </td>
      <td>${badgeType}</td>
      <td>${p.isPick ? '☑' : ''}</td>
      <td>${p.isNew ? '☑' : ''}</td>
      <td style="font-size:11px; color:#64748b;">${p.isPick ? 'PU当選 (チャージリセット)' : ''}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================================================
// スプレッドシート連携（TSVコピー / CSVダウンロード / 取り消し）
// ==========================================================================

function copySpreadsheetTsv() {
  if (AppState.pulls.length === 0) {
    alert('コピーするガチャデータがありません。');
    return;
  }

  // 添付2枚目の形式に合わせたTSV文字列を生成
  // 連番 \t 累計 \t チャージ \t 生徒名 \t pick \t 新
  let tsv = '連番\t累計\tチャージ\t生徒名\tpick\t新\n';

  AppState.pulls.forEach(p => {
    const pick = p.isPick ? '1' : '';
    const isNew = p.isNew ? '1' : '';
    tsv += `${p.seqInBatch}\t${p.totalPullIndex}\t${p.charge}\t${p.studentName || ''}\t${pick}\t${isNew}\n`;
  });

  navigator.clipboard.writeText(tsv).then(() => {
    alert('【スプレッドシート用コピー完了】\nGoogleスプレッドシートやExcelのセルを選択して「Ctrl + V」でそのまま貼り付けられます！');
  }).catch(err => {
    console.error('Clipboard copy failed:', err);
    alert('クリップボードへのコピーに失敗しました。');
  });
}

function downloadCsv() {
  if (AppState.pulls.length === 0) {
    alert('保存するガチャデータがありません。');
    return;
  }

  let csv = '連番,累計,チャージ,生徒名,pick,新,枠種別,登録日時\n';
  AppState.pulls.forEach(p => {
    const name = `"${(p.studentName || '').replace(/"/g, '""')}"`;
    const pick = p.isPick ? '1' : '0';
    const isNew = p.isNew ? '1' : '0';
    const type = p.isGuaranteed100 ? '天井' : (p.isGuaranteed50 ? '50%枠' : (p.isThreeStar ? '☆3' : '通常'));
    csv += `${p.seqInBatch},${p.totalPullIndex},${p.charge},${name},${pick},${isNew},${type},${p.createdAt}\n`;
  });

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ba_gacha_live_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function undoLastPull() {
  if (AppState.pulls.length === 0) {
    alert('取り消せるガチャ履歴がありません。');
    return;
  }

  const lastBatchId = AppState.pulls[AppState.pulls.length - 1].batchId;
  const countInBatch = AppState.pulls.filter(p => p.batchId === lastBatchId).length;

  if (confirm(`直前の引き（${countInBatch}連分）を取り消しますか？`)) {
    AppState.pulls = AppState.pulls.filter(p => p.batchId !== lastBatchId);
    persistState();
    updateAllStats();
    renderHistoryTable();
    renderDirectoryGrid();
    renderConvergenceChart();
  }
}

// ==========================================================================
// 新規生徒アイコン仮登録（添付1枚目完全再現クロッパー）
// ==========================================================================

const CropperState = {
  img: null,
  zoom: 1.0,
  rotation: 0,
  posX: 0,
  posY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  initialImgX: 0,
  initialImgY: 0
};

function initCropperEngine() {
  const canvas = document.getElementById('cropCanvas');
  const fileInput = document.getElementById('cropFileInput');
  const dropzone = document.getElementById('cropDropzone');
  const zoomSlider = document.getElementById('cropZoomSlider');
  const btnRotate = document.getElementById('btnCropRotate');
  const btnReset = document.getElementById('btnCropReset');
  const nameInput = document.getElementById('customStudentName');

  if (!canvas) return;

  // ドロップゾーンクリック
  dropzone.addEventListener('click', () => fileInput.click());

  // ファイル選択
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      loadCropImage(e.target.files[0]);
    }
  });

  // ドラッグ＆ドロップ
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadCropImage(e.dataTransfer.files[0]);
    }
  });

  // Ctrl+V クリップボード画像貼り付け
  window.addEventListener('paste', (e) => {
    const modal = document.getElementById('modalCustomStudent');
    if (!modal.open) return;
    if (e.clipboardData && e.clipboardData.items) {
      for (const item of e.clipboardData.items) {
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile();
          loadCropImage(blob);
          break;
        }
      }
    }
  });

  // ズームスライダー
  zoomSlider.addEventListener('input', (e) => {
    CropperState.zoom = parseFloat(e.target.value);
    drawCropCanvas();
  });

  // 回転
  btnRotate.addEventListener('click', () => {
    CropperState.rotation = (CropperState.rotation + 90) % 360;
    drawCropCanvas();
  });

  // リセット
  btnReset.addEventListener('click', () => {
    resetCropperPosition();
    drawCropCanvas();
  });

  // キャンバスドラッグ操作
  canvas.addEventListener('mousedown', (e) => {
    if (!CropperState.img) return;
    CropperState.isDragging = true;
    CropperState.dragStartX = e.clientX;
    CropperState.dragStartY = e.clientY;
    CropperState.initialImgX = CropperState.posX;
    CropperState.initialImgY = CropperState.posY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!CropperState.isDragging) return;
    const dx = e.clientX - CropperState.dragStartX;
    const dy = e.clientY - CropperState.dragStartY;
    CropperState.posX = CropperState.initialImgX + dx;
    CropperState.posY = CropperState.initialImgY + dy;
    drawCropCanvas();
  });

  window.addEventListener('mouseup', () => {
    CropperState.isDragging = false;
  });

  // ホイール拡大縮小
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!CropperState.img) return;
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    CropperState.zoom = Math.max(0.5, Math.min(3.0, CropperState.zoom + delta));
    zoomSlider.value = CropperState.zoom;
    drawCropCanvas();
  });

  // 生徒名入力連動
  nameInput.addEventListener('input', (e) => {
    const val = normalizeStudentName(e.target.value);
    document.getElementById('cardSampleName').textContent = val || '生徒名';
    checkCustomSaveButtonState();
  });
}

function loadCropImage(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      CropperState.img = img;
      resetCropperPosition();
      document.getElementById('cropperTools').style.display = 'flex';
      document.getElementById('cropPlaceholder').style.display = 'none';
      drawCropCanvas();
      checkCustomSaveButtonState();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function resetCropperPosition() {
  CropperState.zoom = 1.0;
  CropperState.rotation = 0;
  CropperState.posX = 150; // キャンバス中央 (300/2)
  CropperState.posY = 150;
  const zoomSlider = document.getElementById('cropZoomSlider');
  if (zoomSlider) zoomSlider.value = 1.0;
}

function drawCropCanvas() {
  const canvas = document.getElementById('cropCanvas');
  if (!canvas || !CropperState.img) return;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();

  // 中心点移動と変形
  ctx.translate(CropperState.posX, CropperState.posY);
  ctx.rotate((CropperState.rotation * Math.PI) / 180);
  ctx.scale(CropperState.zoom, CropperState.zoom);

  const img = CropperState.img;
  // 画像中央を描画中心に合わせる
  const drawW = 220;
  const drawH = (img.height / img.width) * 220;
  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);

  ctx.restore();

  // リアルタイムに添付1枚目プレビューカードを更新
  updateCardSamplePreview();
}

/**
 * 添付1枚目再現の丸アイコンを生成してカードプレビューに反映
 */
function updateCardSamplePreview() {
  const croppedDataUrl = generateCroppedCirclePng();
  if (croppedDataUrl) {
    const sampleImg = document.getElementById('cardSampleImg');
    if (sampleImg) sampleImg.src = croppedDataUrl;
  }
}

/**
 * ガイドの円形（直径220px）に合わせて正方形＆丸型PNG（透明背景）をエクスポート
 */
function generateCroppedCirclePng() {
  const mainCanvas = document.getElementById('cropCanvas');
  if (!mainCanvas || !CropperState.img) return '';

  const exportCanvas = document.createElement('canvas');
  const size = 220;
  exportCanvas.width = size;
  exportCanvas.height = size;
  const ctx = exportCanvas.getContext('2d');

  // 円形クリッピングマスク
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  // mainCanvasのガイド正方形領域（中央220x220）をコピー描画
  // mainCanvas は 300x300、中央は (300-220)/2 = 40
  ctx.drawImage(mainCanvas, 40, 40, 220, 220, 0, 0, size, size);

  return exportCanvas.toDataURL('image/png');
}

function checkCustomSaveButtonState() {
  const name = document.getElementById('customStudentName').value.trim();
  const btn = document.getElementById('btnSaveCustomStudent');
  if (btn) {
    btn.disabled = !(name && CropperState.img);
  }
}

/**
 * 仮登録を保存
 */
function saveCustomStudent() {
  const nameInput = document.getElementById('customStudentName');
  const normName = normalizeStudentName(nameInput.value);

  if (!normName) {
    alert('生徒名を入力してください。');
    return;
  }

  const croppedIcon = generateCroppedCirclePng();
  if (!croppedIcon) {
    alert('画像をアップロードして切り抜き範囲を指定してください。');
    return;
  }

  // 保存
  AppState.customStudents[normName] = {
    icon: croppedIcon,
    createdAt: new Date().toISOString(),
    wikiSynced: false
  };

  persistState();

  alert(`生徒「${normName}」を仮登録しました！\nガチャの入力サジェストや図鑑ですぐに利用できます。`);

  // モーダルを閉じる
  document.getElementById('modalCustomStudent').close();

  // フォームリセット
  nameInput.value = '';
  CropperState.img = null;
  document.getElementById('cropPlaceholder').style.display = 'block';
  document.getElementById('cropperTools').style.display = 'none';

  // もしダッシュボードが開いていたら再描画
  renderDirectoryGrid();
  renderHistoryTable();
}

// ==========================================================================
// 仮登録エディタ ＆ GitHub共有管理
// ==========================================================================

function openCustomEditorModal() {
  renderCustomStudentsTable();
  const modal = document.getElementById('modalCustomEditor');
  if (modal) modal.showModal();
}

function renderCustomStudentsTable() {
  const tbody = document.getElementById('customStudentsTbody');
  const empty = document.getElementById('customStudentsEmpty');
  if (!tbody) return;

  const names = Object.keys(AppState.customStudents);
  tbody.innerHTML = '';

  if (names.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  names.forEach(name => {
    const data = AppState.customStudents[name];
    const tr = document.createElement('tr');

    const inOfficial = Boolean(AppState.officialStudents[name] || AppState.officialStudents[normalizeStudentName(name)]);

    tr.innerHTML = `
      <td>
        <img src="${data.icon}" class="custom-row-avatar">
      </td>
      <td>
        <input type="text" class="form-input edit-name-input" data-original-name="${escapeHtml(name)}" value="${escapeHtml(name)}" style="font-size:12px; padding:4px 8px;">
      </td>
      <td style="font-size:11px; color:#64748b;">${data.createdAt ? data.createdAt.slice(0, 10) : '-'}</td>
      <td>
        ${inOfficial ? '<span class="badge-legend badge-fifty">Wiki登録済 (削除推奨)</span>' : '<span class="badge-legend badge-regular">Wiki未掲載 (仮登録中)</span>'}
      </td>
      <td>
        <div style="display:flex; gap:4px;">
          <button class="btn-sm btn-secondary btn-update-name" data-original-name="${escapeHtml(name)}">更新</button>
          <button class="btn-sm btn-danger-outline btn-delete-custom" data-name="${escapeHtml(name)}">削除</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });

  // 名前更新ハンドラ
  tbody.querySelectorAll('.btn-update-name').forEach(btn => {
    btn.addEventListener('click', () => {
      const orig = btn.dataset.originalName;
      const input = tbody.querySelector(`.edit-name-input[data-original-name="${orig}"]`);
      if (input) {
        const newName = normalizeStudentName(input.value);
        if (!newName) {
          alert('生徒名を入力してください。');
          return;
        }
        if (newName !== orig) {
          AppState.customStudents[newName] = AppState.customStudents[orig];
          delete AppState.customStudents[orig];
          persistState();
          renderCustomStudentsTable();
          alert(`生徒名を「${newName}」に更新しました。`);
        }
      }
    });
  });

  // 削除ハンドラ
  tbody.querySelectorAll('.btn-delete-custom').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      if (confirm(`仮登録生徒「${name}」を削除しますか？`)) {
        delete AppState.customStudents[name];
        persistState();
        renderCustomStudentsTable();
      }
    });
  });
}

/**
 * GitHubプッシュ共有 (Personal Access Token API)
 */
async function pushCustomStudentsToGitHub() {
  const token = AppState.github.token || document.getElementById('githubTokenInput').value.trim();
  const statusEl = document.getElementById('githubSyncResult');

  if (!token) {
    statusEl.innerHTML = '<span style="color:#ef4444;">GitHub Personal Access Token を入力してください。</span>';
    return;
  }

  statusEl.innerHTML = '<span style="color:#00aeef;">GitHubへプッシュ中...</span>';

  try {
    const owner = AppState.github.repoOwner;
    const repo = AppState.github.repoName;
    const path = 'data/custom_students.json';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    // 既存ファイルのSHAを取得
    let sha = '';
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    // JSONコンテンツの生成
    const contentObj = { students: AppState.customStudents };
    const jsonStr = JSON.stringify(contentObj, null, 2);
    // UTF-8 base64 encode
    const base64Content = btoa(unescape(encodeURIComponent(jsonStr)));

    const body = {
      message: `Update custom_students.json via Web App (${APP_VERSION})`,
      content: base64Content
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (putRes.ok) {
      statusEl.innerHTML = '<span style="color:#10b981;">✔ GitHubへの共有プッシュが完了しました！他の利用者にも反映されます。</span>';
    } else {
      const errData = await putRes.json();
      statusEl.innerHTML = `<span style="color:#ef4444;">プッシュ失敗: ${errData.message || putRes.statusText}</span>`;
    }
  } catch (err) {
    console.error('GitHub push error:', err);
    statusEl.innerHTML = `<span style="color:#ef4444;">通信エラー: ${err.message}</span>`;
  }
}

// ==========================================================================
// UIイベントリスナー登録
// ==========================================================================

function initUIEventListeners() {
  // ナビゲーション / アクションボタン
  document.getElementById('btnPull1').addEventListener('click', () => showGachaInputView(1));
  document.getElementById('btnPull10').addEventListener('click', () => showGachaInputView(10));
  document.getElementById('btnNavDashboard').addEventListener('click', () => showDashboardView());
  document.getElementById('btnDashPull1').addEventListener('click', () => showGachaInputView(1));
  document.getElementById('btnDashPull10').addEventListener('click', () => showGachaInputView(10));

  // ガチャ開始ボタン
  document.getElementById('btnStartGacha').addEventListener('click', () => {
    const rateVal = parseFloat(document.querySelector('input[name="gachaRateRadio"]:checked').value);
    const initCharge = parseInt(document.getElementById('initChargeInput').value, 10) || 0;

    AppState.config.rate = rateVal;
    AppState.config.initCharge = initCharge;
    persistState();

    updateAllStats();
    showGachaInputView(10);
  });

  // シート内ボタン（戻る・OK・次の10連）
  document.getElementById('btnSheetBack').addEventListener('click', () => {
    if (AppState.pulls.length > 0) {
      showDashboardView();
    } else {
      showWelcomeView();
    }
  });

  document.getElementById('btnSheetSubmitOk').addEventListener('click', () => {
    commitCurrentInputSession();
    showDashboardView();
  });

  document.getElementById('btnSheetSubmitNext').addEventListener('click', () => {
    const pullCount = AppState.currentInputSession ? AppState.currentInputSession.count : 10;
    commitCurrentInputSession();
    updateAllStats();
    showGachaInputView(pullCount);
  });

  // スプレッドシートTSVコピー・CSVダウンロード・取り消し
  document.getElementById('btnCopyTsv').addEventListener('click', copySpreadsheetTsv);
  document.getElementById('btnDownloadCsv').addEventListener('click', downloadCsv);
  document.getElementById('btnUndoLastPull').addEventListener('click', undoLastPull);

  // モーダルオープン
  document.getElementById('btnOpenCustomModal').addEventListener('click', () => {
    document.getElementById('modalCustomStudent').showModal();
    // 日付反映
    const today = new Date();
    document.getElementById('cardSampleDate').textContent = `${today.getMonth() + 1}/${today.getDate()}`;
  });
  document.getElementById('btnCloseCustomModal').addEventListener('click', () => {
    document.getElementById('modalCustomStudent').close();
  });
  document.getElementById('btnSaveCustomStudent').addEventListener('click', saveCustomStudent);

  // エディタモーダル
  document.getElementById('btnOpenCustomEditor').addEventListener('click', () => {
    document.getElementById('modalCustomStudent').close();
    openCustomEditorModal();
  });
  document.getElementById('btnCloseEditorModal').addEventListener('click', () => {
    document.getElementById('modalCustomEditor').close();
  });
  document.getElementById('btnCloseEditor').addEventListener('click', () => {
    document.getElementById('modalCustomEditor').close();
  });

  // Wiki同期
  document.getElementById('btnSyncWiki').addEventListener('click', () => {
    cleanupSyncedCustomStudents(true);
  });

  // GitHub連携
  document.getElementById('btnSaveGithubToken').addEventListener('click', () => {
    const val = document.getElementById('githubTokenInput').value.trim();
    AppState.github.token = val;
    localStorage.setItem('ba_github_token', val);
    alert('GitHubトークンを保存しました。');
  });
  document.getElementById('btnPushToGithub').addEventListener('click', pushCustomStudentsToGitHub);

  // 設定モーダル
  document.getElementById('btnOpenSettings').addEventListener('click', () => {
    const modal = document.getElementById('modalSettings');
    if (AppState.config.rate === 0.06) {
      document.getElementById('settingsRate6').checked = true;
    } else {
      document.getElementById('settingsRate3').checked = true;
    }
    renderSettingsPickupTags();
    modal.showModal();
  });
  document.getElementById('btnCloseSettingsModal').addEventListener('click', () => {
    document.getElementById('modalSettings').close();
  });
  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    const rateVal = parseFloat(document.querySelector('input[name="settingsRateRadio"]:checked').value);
    AppState.config.rate = rateVal;
    persistState();
    updateAllStats();
    renderConvergenceChart();
    document.getElementById('modalSettings').close();
  });
  document.getElementById('btnResetAllData').addEventListener('click', () => {
    if (confirm('【警告】ガチャ履歴データを全て消去します。本当によろしいですか？')) {
      AppState.pulls = [];
      persistState();
      updateAllStats();
      document.getElementById('modalSettings').close();
      showWelcomeView();
    }
  });

  // 配信モード切り替え
  document.getElementById('btnToggleStreamMode').addEventListener('click', () => {
    const overlay = document.getElementById('streamOverlayLayer');
    overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('btnExitStreamMode').addEventListener('click', () => {
    document.getElementById('streamOverlayLayer').style.display = 'none';
  });

  // テーマ切り替え (タクティカルHUDダーク ⇔ ライト)
  const btnTheme = document.getElementById('btnToggleTheme');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const isDark = document.body.classList.contains('theme-tactical-dark');
      if (isDark) {
        document.body.classList.remove('theme-tactical-dark');
        document.body.classList.add('theme-light');
        localStorage.setItem('ba_theme', 'light');
      } else {
        document.body.classList.remove('theme-light');
        document.body.classList.add('theme-tactical-dark');
        localStorage.setItem('ba_theme', 'dark');
      }
      renderConvergenceChart();
    });

    const savedTheme = localStorage.getItem('ba_theme');
    if (savedTheme === 'light') {
      document.body.classList.remove('theme-tactical-dark');
      document.body.classList.add('theme-light');
    }
  }

  // 小窓ポップアウト機能 (配信用独立ウィンドウ)
  const btnPopout = document.getElementById('btnPopoutWindow');
  if (btnPopout) {
    btnPopout.addEventListener('click', () => {
      const url = new URL(window.location.href);
      url.searchParams.set('popout', '1');
      window.open(url.toString(), 'BA_Gacha_Live_Compact', 'width=520,height=820,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    });
  }

  // 小窓表示フラグがある場合はbodyにwindow-popoutクラスを付与
  if (new URLSearchParams(window.location.search).get('popout') === '1') {
    document.body.classList.add('window-popout');
  }

  // 仮登録JSONエクスポート・インポート
  document.getElementById('btnExportCustomJson').addEventListener('click', () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ students: AppState.customStudents }, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute("href", dataStr);
    dlAnchor.setAttribute("download", `custom_students_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
  });

  const importInput = document.getElementById('importCustomFileInput');
  document.getElementById('btnImportCustomJson').addEventListener('click', () => {
    importInput.click();
  });
  importInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          if (parsed && parsed.students) {
            AppState.customStudents = Object.assign(AppState.customStudents, parsed.students);
            persistState();
            renderCustomStudentsTable();
            alert('仮登録生徒データをインポートしました！');
          } else {
            alert('JSONフォーマットが正しくありません。（studentsオブジェクトが必要です）');
          }
        } catch (err) {
          alert('JSONの解析に失敗しました: ' + err.message);
        }
      };
      reader.readAsText(e.target.files[0]);
    }
  });

  // PU生徒追加フォーム
  initPickupStudentSetup();
}

/**
 * 初期設定画面でのピックアップ生徒追加
 */
function initPickupStudentSetup() {
  const input = document.getElementById('pickupStudentInput');
  const btnAdd = document.getElementById('btnAddPickupStudent');
  const dropdown = document.getElementById('pickupSuggestDropdown');

  if (!input || !btnAdd) return;

  function addPickup(name) {
    const norm = normalizeStudentName(name);
    if (norm && !AppState.config.pickupStudents.includes(norm)) {
      AppState.config.pickupStudents.push(norm);
      renderWelcomePickupTags();
      persistState();
    }
    input.value = '';
    dropdown.style.display = 'none';
  }

  btnAdd.addEventListener('click', () => addPickup(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addPickup(input.value);
    }
  });

  input.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (!val) {
      dropdown.style.display = 'none';
      return;
    }
    const matches = searchStudents(val);
    dropdown.innerHTML = '';
    if (matches.length > 0) {
      matches.slice(0, 8).forEach(name => {
        const div = document.createElement('div');
        div.className = 'guide-item';
        div.innerHTML = `
          <img src="${getStudentIconUrl(name)}" class="guide-avatar" onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 32 32\\'><circle cx=\\'16\\' cy=\\'16\\' r=\\'15\\' fill=\\'%23e2e8f0\\'/></svg>'">
          <span class="guide-name">${escapeHtml(name)}</span>
        `;
        div.addEventListener('click', () => addPickup(name));
        dropdown.appendChild(div);
      });
      dropdown.style.display = 'block';
    } else {
      dropdown.style.display = 'none';
    }
  });

  renderWelcomePickupTags();
}

function renderWelcomePickupTags() {
  const wrap = document.getElementById('pickupTagsWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  AppState.config.pickupStudents.forEach(name => {
    const tag = document.createElement('span');
    tag.className = 'pickup-tag';
    tag.innerHTML = `
      <img src="${getStudentIconUrl(name)}" class="pickup-tag-avatar" onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 32 32\\'><circle cx=\\'16\\' cy=\\'16\\' r=\\'15\\' fill=\\'%23e2e8f0\\'/></svg>'">
      <span>${escapeHtml(name)}</span>
      <span class="pickup-tag-remove" data-name="${escapeHtml(name)}">✕</span>
    `;
    tag.querySelector('.pickup-tag-remove').addEventListener('click', () => {
      AppState.config.pickupStudents = AppState.config.pickupStudents.filter(n => n !== name);
      renderWelcomePickupTags();
      persistState();
    });
    wrap.appendChild(tag);
  });
}

function renderSettingsPickupTags() {
  const wrap = document.getElementById('settingsPickupTags');
  if (!wrap) return;
  wrap.innerHTML = '';

  AppState.config.pickupStudents.forEach(name => {
    const tag = document.createElement('span');
    tag.className = 'pickup-tag';
    tag.innerHTML = `
      <span>${escapeHtml(name)}</span>
      <span class="pickup-tag-remove" data-name="${escapeHtml(name)}">✕</span>
    `;
    tag.querySelector('.pickup-tag-remove').addEventListener('click', () => {
      AppState.config.pickupStudents = AppState.config.pickupStudents.filter(n => n !== name);
      renderSettingsPickupTags();
      persistState();
    });
    wrap.appendChild(tag);
  });
}

function renderWelcomeForm() {
  document.getElementById('initChargeInput').value = AppState.config.initCharge;
  renderWelcomePickupTags();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
