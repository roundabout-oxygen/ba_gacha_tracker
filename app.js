/**
 * ブルーアーカイブ リアルタイムガチャ集計 (BA Gacha Live Tracker)
 * Version: v1.0.36
 * Core Application Logic & State Management
 */

const APP_VERSION = 'v1.0.37';

// P2P WebRTC (PeerJS) 同期管理 (Chrome ⇄ OBSブラウザソース間のプロセス間通信)
let peerInstance = null;
let activePeerConnections = [];
let syncRoomId = localStorage.getItem('ba_gacha_room_id') || Math.random().toString(36).substring(2, 8);
localStorage.setItem('ba_gacha_room_id', syncRoomId);
const REMOTE_STUDENT_ICONS_URL = 'https://raw.githubusercontent.com/roundabout-oxygen/ba_gacha_tabulation/main/data/student_icons.json';

// 単発 (1連) モードかどうかのフラグ (false = 10連モード, true = 1連モード)
let isSinglePullMode = false;

// アプリケーション全体の状態管理
const AppState = {
  // ガチャ設定
  config: {
    rate: 0.03, // 0.03 (通常) or 0.06 (フェス)
    initCharge: 0, // 開始前の引継ぎチャージ数 (0〜199)
    pickupStudents: [], // ピックアップ対象生徒の配列
    iconOnly: false // アイコンのみ表示させるフラグ
  },

  // 履歴データ（1連ごとの記録配列）
  pulls: [],

  // 生徒アイコン辞書 (Wiki正規データ + 仮登録データ)
  officialStudents: {}, // Wiki公式生徒 { "生徒名": "画像URL", ... }
  customStudents: {},   // 新規生徒仮登録 { "生徒名": { icon: "data:image/...", createdAt: "...", wikiSynced: false } }

  // GitHub連携設定
  github: {
    token: '',
    repoOwner: 'roundabout-oxygen',
    repoName: 'ba_gacha_tracker',
    filePath: 'data/custom_students.json'
  },

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

  // 仮登録マネージャー & GitHub共有設定の初期化
  initCustomStudentEditor();

  // デフォルトでガチャシートの準備（初回10連）
  setupInputSheet(10);

  // 初回ダッシュボード描画
  updateAllStats();
  renderDirectoryGrid();
  renderConvergenceChart();

  // P2P WebRTC (PeerJS) リアルタイム同期の初期化
  initPeerSync(isOverlayMode, urlParams.get('room'));

  // URLパラメータの解釈 (テスト・自動検証用 & 配信モード判定)
  const urlParams = new URLSearchParams(window.location.search);
  const isOverlayMode = urlParams.get('mode') === 'overlay' || urlParams.get('mode') === 'stream' || window.location.hash === '#overlay';
  if (isOverlayMode) {
    document.body.classList.add('stream-overlay-mode');
    switchTab('tabDashboard');
    renderConvergenceChart();
    // 手元操作画面が生きていれば最新状態をリクエストして即時同期
    if (syncChannel) {
      try {
        syncChannel.postMessage({ type: 'REQ_SYNC' });
      } catch (e) {}
    }
  } else if (urlParams.get('demo') === '1') {
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
    const savedGhToken = localStorage.getItem('ba_github_token');
    if (savedGhToken) {
      AppState.github.token = savedGhToken;
    }
  } catch (err) {
    console.error('Failed to load state from localStorage:', err);
  }
}

// ==========================================================================
// ローカルリアルタイム通信 (BroadcastChannel & storage event)
// 仕様: 同一PC内のブラウザ間において、サーバーや外部ネットワークを経由せず、
// ブラウザ標準のプロセス間通信機能を用いて数値を即座にゼロ遅延で同期する。
// ==========================================================================

let syncChannel = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    syncChannel = new BroadcastChannel('ba_gacha_live_sync');
    syncChannel.onmessage = (event) => {
      handleSyncMessage(event.data);
    };
  }
} catch (e) {
  console.warn('BroadcastChannel initialization error:', e);
}

function broadcastSyncState() {
  const syncMsg = {
    type: 'SYNC_STATE',
    senderMode: document.body.classList.contains('stream-overlay-mode') ? 'overlay' : 'control',
    payload: {
      config: AppState.config,
      pulls: AppState.pulls,
      currentSession: AppState.currentSession,
      isSinglePullMode: isSinglePullMode
    }
  };

  // 1. BroadcastChannel (同一ブラウザ/CEF用)
  if (syncChannel) {
    try {
      syncChannel.postMessage(syncMsg);
    } catch (e) {
      console.warn('broadcastSyncState failed:', e);
    }
  }

  // 2. PeerJS WebRTC (別プロセス/OBSブラウザソース用)
  activePeerConnections.forEach(conn => {
    try {
      if (conn && conn.open) {
        conn.send(syncMsg);
      }
    } catch (e) {
      console.warn('PeerJS send failed:', e);
    }
  });
}

function updateObsSyncBadge() {
  const badge = document.getElementById('obsSyncBadge');
  if (!badge) return;
  const count = activePeerConnections.filter(c => c && c.open).length;
  if (count > 0) {
    badge.className = 'status-badge badge-pickup';
    badge.textContent = `OBS接続中 (${count}台)`;
  } else {
    badge.className = 'status-badge badge-regular';
    badge.textContent = '同期準備完了';
  }
}

function initPeerSync(isOverlayMode, targetRoomId) {
  if (typeof Peer === 'undefined') {
    console.warn('PeerJS not loaded, relying only on BroadcastChannel.');
    return;
  }

  try {
    if (isOverlayMode) {
      // 配信（OBS）側: クライアントとして操作側に接続
      const room = targetRoomId || syncRoomId;
      peerInstance = new Peer();
      peerInstance.on('open', () => {
        console.log('[PeerJS] Overlay connected with ID:', peerInstance.id);
        const conn = peerInstance.connect('ba_tracker_' + room);
        conn.on('open', () => {
          console.log('[PeerJS] Connected to control host:', 'ba_tracker_' + room);
          conn.send({ type: 'REQ_SYNC' });
        });
        conn.on('data', (data) => {
          handleSyncMessage(data);
        });
        conn.on('error', (err) => console.warn('[PeerJS] Connection error:', err));
      });
      peerInstance.on('error', (err) => console.warn('[PeerJS] Peer error:', err));
    } else {
      // 操作側: ホストとして待受
      const hostId = 'ba_tracker_' + syncRoomId;
      peerInstance = new Peer(hostId);
      peerInstance.on('open', (id) => {
        console.log('[PeerJS] Host listening on ID:', id);
        updateObsSyncBadge();
      });
      peerInstance.on('connection', (conn) => {
        activePeerConnections.push(conn);
        conn.on('open', () => {
          updateObsSyncBadge();
          // 即座に最新状態を同期
          conn.send({
            type: 'SYNC_STATE',
            senderMode: 'control',
            payload: {
              config: AppState.config,
              pulls: AppState.pulls,
              currentSession: AppState.currentSession,
              isSinglePullMode: isSinglePullMode
            }
          });
        });
        conn.on('data', (data) => {
          handleSyncMessage(data);
        });
        conn.on('close', () => {
          activePeerConnections = activePeerConnections.filter(c => c !== conn);
          updateObsSyncBadge();
        });
        conn.on('error', () => {
          activePeerConnections = activePeerConnections.filter(c => c !== conn);
          updateObsSyncBadge();
        });
      });
      peerInstance.on('error', (err) => {
        console.warn('[PeerJS] Host peer error (falling back to BroadcastChannel):', err);
      });
    }
  } catch (e) {
    console.warn('[PeerJS] Init error:', e);
  }
}

function handleSyncMessage(data) {
  if (!data || !data.type) return;

  if (data.type === 'SYNC_STATE') {
    const payload = data.payload;
    if (!payload) return;

    if (payload.config) AppState.config = payload.config;
    if (payload.pulls) AppState.pulls = payload.pulls;
    if (payload.currentSession) AppState.currentSession = payload.currentSession;
    if (payload.isSinglePullMode !== undefined) isSinglePullMode = payload.isSinglePullMode;

    recalculatePullsIndexAndCharge();
    updateAllStats();
    renderDirectoryGrid();
    renderConvergenceChart();

    // 配信表示モード側（OBS）または別画面でシート・ダッシュボードを最新表示
    if (document.body.classList.contains('stream-overlay-mode')) {
      switchTab('tabDashboard');
    } else {
      const batches = getAllBatches();
      if (batches.length > 0) {
        const targetBatchId = (AppState.currentSession && AppState.currentSession.editingBatchId)
          ? AppState.currentSession.editingBatchId
          : batches[batches.length - 1];
        loadBatchById(targetBatchId);
      } else {
        setupInputSheet();
      }
      renderSheetTimelineNav();
  broadcastSyncState();;
    }
  } else if (data.type === 'REQ_SYNC') {
    // 配信画面起動時の同期リクエストに応答
    broadcastSyncState();
  }
}

// フォールバック: storage イベントでも同期
window.addEventListener('storage', (e) => {
  if (e.key && e.key.startsWith('ba_gacha_')) {
    loadSavedState();
    recalculatePullsIndexAndCharge();
    updateAllStats();
    const batches = getAllBatches();
    if (batches.length > 0) {
      loadBatchById(batches[batches.length - 1]);
    } else {
      setupInputSheet();
    }
  }
});

function persistState() {
  try {
    localStorage.setItem('ba_gacha_config', JSON.stringify(AppState.config));
    localStorage.setItem('ba_gacha_pulls', JSON.stringify(AppState.pulls));
    localStorage.setItem('ba_custom_students', JSON.stringify(AppState.customStudents));
    localStorage.setItem('ba_gacha_theme', AppState.theme);
    localStorage.setItem('ba_gacha_session', JSON.stringify(AppState.currentSession));
  } catch (err) {
    console.error('Failed to persist state:', err);
  }

  // 配信画面(OBS)へ即座に最新データを配信
  broadcastSyncState();
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
        AppState.customStudents = Object.assign({}, AppState.customStudents, remoteCustom.students);
        persistState();
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
// チャージ計算ロジック (Single Source of Truth: AppState.pulls)
// ==========================================================================

/**
 * 確定済み（または最新）の最終チャージを取得
 * pulls が空なら引継ぎ設定（initCharge）を返す
 */
function getLastCommittedCharge() {
  if (AppState.pulls && AppState.pulls.length > 0) {
    return AppState.pulls[AppState.pulls.length - 1].charge;
  }
  return Number(AppState.config.initCharge) || 0;
}

/**
 * 上部バー等に表示する最新チャージ数
 * ユーザー要望: 「上に表示されているチャージは最終ページの最下段のチャージを表示してください。
 * 前の10連へで表示を前に戻すと変化しますがそうならないようにお願いします」
 */
function getActiveDisplayCharge() {
  return getLastCommittedCharge();
}

/**
 * 直前までのチャージ数を取得（互換用）
 */
function calculateCurrentCharge() {
  return getLastCommittedCharge();
}

/**
 * 全 pull の totalPullIndex, charge, isGuaranteed50, isGuaranteed100 を時系列順に一括再計算
 */
function recalculatePullsIndexAndCharge() {
  let runningCharge = Number(AppState.config.initCharge) || 0;
  AppState.pulls.forEach((p, idx) => {
    p.totalPullIndex = idx + 1;
    runningCharge += 1;
    p.charge = runningCharge;
    p.isGuaranteed50 = (runningCharge === 100);
    p.isGuaranteed100 = (runningCharge === 200);
    if (p.isPick || runningCharge === 200) {
      runningCharge = 0;
    }
  });
}

/**
 * 現在のシート入力内容を AppState.pulls に同期し、全履歴の整合性を再計算
 */
function syncCurrentSessionToPulls(forceCommitNew = false) {
  const session = AppState.currentSession;
  if (!session || !session.rows || session.rows.length === 0) return;

  const pullType = isSinglePullMode ? '1' : '10';
  const targetRows = isSinglePullMode ? [session.rows[0]] : session.rows;
  const editingBatchId = session.editingBatchId;

  if (editingBatchId) {
    // 既存バッチの更新
    const firstIdx = AppState.pulls.findIndex(p => p.batchId === editingBatchId);
    if (firstIdx !== -1) {
      const existingInBatch = AppState.pulls.filter(p => p.batchId === editingBatchId);
      const originalCount = existingInBatch.length;
      const createdAt = existingInBatch[0] ? existingInBatch[0].createdAt : new Date().toISOString();

      const updatedPulls = targetRows.map((r, i) => {
        const isThreeStar = Boolean(r.studentName && r.studentName.trim());
        return {
          id: existingInBatch[i] ? existingInBatch[i].id : (firstIdx + i + 1),
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
    // まだバッチIDがない新規シートの場合、生徒名・pick・newに入力があるか、または確定指定(forceCommitNew)なら正式追加
    const hasAnyContent = targetRows.some(r => (r.studentName && r.studentName.trim()) || r.isPick || r.isNew);
    if (hasAnyContent || forceCommitNew) {
      const batchId = 'batch_' + Date.now();
      session.editingBatchId = batchId;
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
  }

  // 全履歴の連番・チャージ・天井を一括再計算
  recalculatePullsIndexAndCharge();

  // 現在表示中バッチの行チャージも AppState.pulls から最新の値を取り込んで同期
  if (session.editingBatchId) {
    const curPulls = AppState.pulls.filter(p => p.batchId === session.editingBatchId);
    session.rows.forEach((r, idx) => {
      if (curPulls[idx]) {
        r.total = curPulls[idx].totalPullIndex;
        r.charge = curPulls[idx].charge;
        r.isGuaranteed50 = curPulls[idx].isGuaranteed50;
        r.isGuaranteed100 = curPulls[idx].isGuaranteed100;
      }
    });
  }

  persistState();
}

/**
 * 現在のシート内のチャージ数・50%天井行のハイライト・上部集計バーを即時再計算
 * pickチェックボックスの変更時や生徒名入力時に即座に呼ばれる
 */
function recalculateCurrentSessionCharges() {
  if (!AppState.currentSession.rows || AppState.currentSession.rows.length === 0) return;

  const session = AppState.currentSession;
  const rows = session.rows;

  if (session.editingBatchId) {
    syncCurrentSessionToPulls();
  } else {
    const hasAnyContent = rows.some(r => (r.studentName && r.studentName.trim()) || r.isPick || r.isNew);
    if (hasAnyContent) {
      syncCurrentSessionToPulls();
    } else {
      let runningCharge = getLastCommittedCharge();
      rows.forEach((r, idx) => {
        runningCharge += 1;
        r.charge = runningCharge;
        r.isGuaranteed50 = (runningCharge === 100);
        r.isGuaranteed100 = (runningCharge === 200);
        if (r.isPick || runningCharge === 200) {
          runningCharge = 0;
        }
      });
    }
  }

  // DOMを最新の row.charge に合わせて更新
  const tbody = document.getElementById('gachaSheetTbody');
  const trList = tbody ? tbody.querySelectorAll('tr') : [];

  rows.forEach((row, idx) => {
    if (trList[idx]) {
      const tr = trList[idx];
      const tdCharge = tr.querySelector('.col-charge');
      const tdTotal = tr.querySelector('.col-total');

      if (tdTotal) tdTotal.textContent = row.total;

      if (tdCharge) {
        let label = row.charge;
        if (row.charge === 100) label += ' (50%)';
        else if (row.charge === 200) label = '200天井';
        tdCharge.textContent = label;

        if (row.charge > 100) {
          tdCharge.classList.add('charge-danger');
        } else {
          tdCharge.classList.remove('charge-danger');
        }
      }

      if (row.charge === 100 || row.charge === 200) {
        tr.classList.add('row-charge-100');
      } else {
        tr.classList.remove('row-charge-100');
      }
    }
  });

  updateAllStats();
  renderSheetTimelineNav();
  renderDirectoryGrid();
  renderConvergenceChart();
  persistState();
  broadcastSyncState();
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
  let runningCharge = getLastCommittedCharge();

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
  renderSheetTimelineNav();
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
function checkMissing100ThPull() {
  // 現在シート内の100連目チェック
  const session = AppState.currentSession;
  if (session && session.rows && session.rows.length > 0) {
    const row100 = session.rows.find(r => r.charge === 100);
    if (row100 && (!row100.studentName || !row100.studentName.trim())) {
      const inputEl = document.querySelector(`.sheet-student-input[data-row-index="${row100.seq - 1}"]`);
      if (inputEl) {
        inputEl.classList.remove('input-shake');
        void inputEl.offsetWidth;
        inputEl.classList.add('input-shake');
        inputEl.focus();
        setTimeout(() => inputEl.classList.remove('input-shake'), 600);
      }
      return false;
    }
  }

  // 確定済み履歴の中の未入力100連目チェック
  const unentered100 = AppState.pulls.find(p => p.charge === 100 && (!p.studentName || !p.studentName.trim()));
  if (unentered100 && unentered100.batchId) {
    loadBatchById(unentered100.batchId);
    setTimeout(() => {
      const inputEl = document.querySelector(`.sheet-student-input[data-row-index="${unentered100.seqInBatch - 1}"]`);
      if (inputEl) {
        inputEl.classList.remove('input-shake');
        void inputEl.offsetWidth;
        inputEl.classList.add('input-shake');
        inputEl.focus();
        setTimeout(() => inputEl.classList.remove('input-shake'), 600);
      }
    }, 50);
    return false;
  }

  return true;
}

function addNewBatchImmediately() {
  if (!checkMissing100ThPull()) {
    return;
  }
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
  let runningCharge = getLastCommittedCharge();

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
  broadcastSyncState();
}

/**
 * 「この10連を削除」: 表示されているバッチを履歴から完全に削除し、前の引きに戻る
 */
function deleteCurrentBatch() {
  const batches = getAllBatches();
  
  // バッチが一切ない場合（初期シート入力中など）は入力シートを白紙リセット
  if (batches.length === 0) {
    AppState.currentSession.editingBatchId = null;
    AppState.currentSession.rows = [];
    setupInputSheet();
    updateAllStats();
    renderHistoryTable();
    renderDirectoryGrid();
    renderConvergenceChart();
    updateSheetPageIndicator();
    broadcastSyncState();
    return;
  }

  // 1. 削除対象のバッチIDとインデックスを特定
  let targetBatchId = AppState.currentSession.editingBatchId;
  let targetIdx = -1;
  if (targetBatchId) {
    targetIdx = batches.indexOf(targetBatchId);
  } else {
    // editingBatchId がない場合は最新バッチ
    targetIdx = batches.length - 1;
    targetBatchId = batches[targetIdx];
  }

  if (!targetBatchId) return;

  // 2. pulls から対象バッチを完全に削除
  AppState.pulls = AppState.pulls.filter(p => p.batchId !== targetBatchId);

  // 3. 重要: 現在のセッションの rows と editingBatchId を完全クリア！
  // (クリアしないと、loadPreviousBatch等の保存判定でゾンビデータとして再コミットされてしまうため)
  AppState.currentSession.editingBatchId = null;
  AppState.currentSession.rows = [];

  // 4. 連番・チャージの整合性を再計算して保存
  recalculatePullsIndexAndCharge();
  persistState();

  // 5. 削除後の再表示バッチを決定
  const remainingBatches = getAllBatches();
  if (remainingBatches.length > 0) {
    // 削除した位置の1つ前（直前）のバッチを表示。先頭だったなら残りの先頭を表示
    let nextIdx = targetIdx - 1;
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx >= remainingBatches.length) nextIdx = remainingBatches.length - 1;
    loadBatchById(remainingBatches[nextIdx]);
    triggerSheetSlideAnimation('left');
  } else {
    // 全てのバッチが削除されたら、新規初期シートをセットアップ
    setupInputSheet();
    triggerSheetSlideAnimation('left');
  }

  // 6. UI・統計・履歴・グラフ・配信用通信をすべて最新化
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
  updateSheetPageIndicator();
  broadcastSyncState();
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
  const btnSubmitOk = document.getElementById('btnSheetSubmitOk');
  if (btnSubmitOk) {
    btnSubmitOk.textContent = '確定';
  }

  if (btnDelete) {
    btnDelete.textContent = isSinglePullMode ? '1連削除' : '10連削除';
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

    // 入力イベント (平仮名等のタイピング中はサジェスト絞り込みのみ行い、確定・配信同期は行わない)
    inputName.addEventListener('input', (e) => {
      onStudentInputTyping(idx, e.target.value);
    });
    inputName.addEventListener('focus', (e) => {
      showStudentGuidePopup(inputName, idx);
    });
    inputName.addEventListener('blur', (e) => {
      // カーソルを他に移した時に初めて正式確定・集計・配信同期を実行
      commitStudentInput(idx, e.target.value);
      updateRowAvatar(e.target.value);
      setTimeout(() => {
        const popup = document.getElementById('studentInputGuidePopup');
        if (popup) popup.style.display = 'none';
      }, 150);
    });
    inputName.addEventListener('keydown', (e) => {
      handleSuggestKeyNavigation(e, idx);
    });

    inputWrap.appendChild(inputName);
    tdName.appendChild(inputWrap);
    tr.appendChild(tdName);

    // 5. new チェックボックス (pickの左に配置)
    const tdNew = document.createElement('td');
    tdNew.className = 'col-chk col-new';
    const labelNew = document.createElement('label');
    labelNew.className = 'sheet-chk-label chk-new';
    const chkNew = document.createElement('input');
    chkNew.type = 'checkbox';
    chkNew.checked = row.isNew;
    chkNew.dataset.rowIndex = idx;
    chkNew.addEventListener('change', (e) => {
      row.isNew = e.target.checked;
      recalculateCurrentSessionCharges();
    });
    const boxNew = document.createElement('span');
    boxNew.className = 'custom-chk-box';
    boxNew.textContent = '✔';
    labelNew.appendChild(chkNew);
    labelNew.appendChild(boxNew);
    tdNew.appendChild(labelNew);
    tr.appendChild(tdNew);

    // 6. pick チェックボックス
    const tdPick = document.createElement('td');
    tdPick.className = 'col-chk col-pick';
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

    tbody.appendChild(tr);
  });

  // 1連モード・10連モードの表示状態（グレーアウト等）を適用
  applyPullModeUI();
}

/**
 * 入力中の処理: 平仮名等のタイピング中はサジェスト候補の更新のみ行い、配信や集計には反映しない
 */
function onStudentInputTyping(rowIndex, query) {
  const inputEl = document.querySelector(`.sheet-student-input[data-row-index="${rowIndex}"]`);
  updateStudentGuidePopup(inputEl, query, rowIndex);
}

/**
 * 生徒名確定時の処理: リストから選択した時、またはカーソルを他に移した時に正式反映
 */
function commitStudentInput(rowIndex, value) {
  const row = AppState.currentSession.rows[rowIndex];
  if (!row) return;

  const trimmed = (value || '').trim();
  row.studentName = trimmed;
  const inputEl = document.querySelector(`.sheet-student-input[data-row-index="${rowIndex}"]`);
  const chkPick = document.querySelector(`.col-pick input[data-row-index="${rowIndex}"]`);
  const chkNew = document.querySelector(`.col-new input[data-row-index="${rowIndex}"]`);

  if (trimmed) {
    if (inputEl) {
      inputEl.value = trimmed;
      inputEl.classList.add('has-value');
    }

    // ピックアップ生徒と一致するか判定
    const isPickMatch = AppState.config.pickupStudents.some(pu =>
      normalizeStudentName(pu) === normalizeStudentName(trimmed)
    );
    row.isPick = isPickMatch;
    if (chkPick) chkPick.checked = isPickMatch;

    if (inputEl) {
      if (isPickMatch) inputEl.classList.add('is-pickup');
      else inputEl.classList.remove('is-pickup');
    }
  } else {
    if (inputEl) {
      inputEl.value = '';
      inputEl.classList.remove('has-value');
      inputEl.classList.remove('is-pickup');
    }
    row.isPick = false;
    row.isNew = false;
    if (chkPick) chkPick.checked = false;
    if (chkNew) chkNew.checked = false;
  }

  // リスト選択またはフォーカス移動で確定された時のみ、集計・チャージ・配信側へ同期反映！
  recalculateCurrentSessionCharges();
}

// 互換用エイリアス
const onStudentInputChange = commitStudentInput;

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
  // リストにある生徒を選択した瞬間に正式確定＆配信側へ同期！
  commitStudentInput(rowIndex, name);

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
  if (e.isComposing || e.keyCode === 229) return;

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
    if (currentSuggestCandidates && currentSuggestCandidates[highlightedSuggestIndex]) {
      selectSuggestStudent(rowIndex, currentSuggestCandidates[highlightedSuggestIndex]);
    } else {
      const inputEl = document.querySelector(`.sheet-student-input[data-row-index="${rowIndex}"]`);
      if (inputEl) commitStudentInput(rowIndex, inputEl.value);
      if (popup) popup.style.display = 'none';
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

function commitCurrentSheet(forceCommitNew = false) {
  syncCurrentSessionToPulls(forceCommitNew);
  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
  renderSheetTimelineNav();
  persistState();
  broadcastSyncState();
}

// ==========================================================================
// 統計計算 & 画面更新
// ==========================================================================

function updateAllStats() {
  const pulls = AppState.pulls;
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

  // 50%勝率集計 (charge === 100 かつ入力済み行のみ対象: pickなら勝ち、すり抜けなら負け)
  const fiftyPulls = pulls.filter(p => Number(p.charge) === 100 && Boolean(p.studentName && p.studentName.trim()));
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
  setText('liveStatThreeStarRate', threeStarRate.toFixed(2));
  setText('liveStatPickupRate', pickupRate.toFixed(2));
  setText('liveStatWinCount', fiftyWins);
  setText('liveStatLossCount', fiftyLosses);

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

          // 生徒アイコンの丸枠ボーダー (新規・50%すり抜けなら緑、ピックアップなら黄色)
          let ringColor = '#c5a059';
          if (pull.isPick) {
            ringColor = '#f59e0b'; // ピックアップ: 黄色
          } else if (pull.isNew) {
            ringColor = '#ff3e6c'; // 新規: 赤色 (設計書準拠)
          } else if (pull.isGuaranteed50) {
            ringColor = '#10b981'; // 50%すり抜け: 緑色
          }

          ctx.save();
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 2.8;
          ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
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
    // 既存インスタンスを再利用して差分更新 (入力時のチラつきと破棄オーバーヘッドを解消)
    AppState.chartInstance.data.datasets[0].data = baselinePoints;
    AppState.chartInstance.data.datasets[1].data = uniquePoints;
    AppState.chartInstance.data.datasets[1].label = isFest ? '6% 乖離率' : '3% 乖離率';
    AppState.chartInstance.data.datasets[1].borderColor = lineColor;
    AppState.chartInstance.data.datasets[1].backgroundColor = isFest ? 'rgba(255, 62, 108, 0.06)' : 'rgba(0, 174, 239, 0.06)';
    AppState.chartInstance.data.datasets[1].pointBackgroundColor = lineColor;
    AppState.chartInstance.options.scales.x.max = maxPulls;
    AppState.chartInstance.options.scales.x.ticks.stepSize = maxPulls <= 100 ? 20 : 50;
    AppState.chartInstance.options.scales.y.min = -yLimit;
    AppState.chartInstance.options.scales.y.max = yLimit;
    AppState.chartInstance.update('none');
    return;
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
  const container = document.getElementById('threeStarCardsGrid');
  if (!container) return;

  const emptyHint = document.getElementById('threeStarEmptyHint');
  const isIconOnly = Boolean(AppState.config && AppState.config.iconOnly);
  container.classList.toggle('mode-icon-only-grid', isIconOnly);
  
  // 時系列順 (古いものが左上、新しいものは右下に追加される昇順)
  const threeStarPulls = AppState.pulls.filter(p => p.isThreeStar);
  
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
    } else if (pull.isNew) {
      typeText = '新規';
      borderClass = 'border-new';
    } else if (pull.isGuaranteed50) {
      typeText = 'すり抜け(50%)';
      borderClass = 'border-fifty';
    } else {
      typeText = currentCount > 1 ? 'すり抜け(被り)' : 'すり抜け';
      borderClass = 'border-regular';
    }

    card.classList.add(borderClass);
    if (isIconOnly) {
      card.classList.add('mode-icon-only');
    }

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

  const iconOnlyToggle = document.getElementById('settingsIconOnlyToggle');
  if (iconOnlyToggle) iconOnlyToggle.checked = Boolean(AppState.config.iconOnly);

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

  const iconOnlyToggle = document.getElementById('settingsIconOnlyToggle');
  if (iconOnlyToggle) {
    AppState.config.iconOnly = iconOnlyToggle.checked;
  }

  recalculatePullsIndexAndCharge();
  persistState();
  updateAllStats();
  if (AppState.currentSession && AppState.currentSession.editingBatchId) {
    loadBatchById(AppState.currentSession.editingBatchId);
  } else {
    setupInputSheet();
  }
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
      broadcastSyncState();
    });
  }

  // 次の10連へ ▶（次の10連がある場合のみ移動、最終ページで押した時はシェイクアニメーション）
  if (btnSubmitNext) {
    btnSubmitNext.addEventListener('click', () => {
      if (!checkMissing100ThPull()) {
        return;
      }
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
      commitCurrentSheet(true);
      switchTab('tabDashboard');
    });
  }

  // 4. 設定タブ操作ボタン
  const btnCancel = document.getElementById('btnCancelSettings');
  const btnSave = document.getElementById('btnSaveSettings');

  if (btnCancel) btnCancel.addEventListener('click', cancelSettingsFromTab);
  if (btnSave) btnSave.addEventListener('click', saveSettingsFromTab);

  // アイコンのみ表示トグル (即時反映＆配信同期)
  const iconOnlyToggle = document.getElementById('settingsIconOnlyToggle');
  if (iconOnlyToggle) {
    iconOnlyToggle.addEventListener('change', (e) => {
      AppState.config.iconOnly = e.target.checked;
      persistState();
      renderDirectoryGrid();
      broadcastSyncState();
    });
  }

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
        AppState.currentSession = {
          editingBatchId: null,
          pullCount: 10,
          rows: []
        };
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

  // 6. 設定タブ内: 配信設定 (OBS Studio連携)
  initStreamOverlayTools();
}

/**
 * 配信表示モード (OBS Studio オーバーレイ) 関連ツールの初期化
 */
function initStreamOverlayTools() {
  const urlInput = document.getElementById('streamOverlayUrlInput');
  const btnCopy = document.getElementById('btnCopyOverlayUrl');
  const btnPopout = document.getElementById('btnPopoutWindow');
  const btnOpenOverlay = document.getElementById('btnOpenOverlayWindow');

  // 現在のページURLからOBSオーバーレイ用URLを生成
  let baseUrl = window.location.href.split('?')[0].split('#')[0];
  let overlayUrl = baseUrl;
  if (overlayUrl.startsWith('file:')) {
    overlayUrl += '?mode=overlay#overlay';
  } else {
    overlayUrl += '?mode=overlay&room=' + encodeURIComponent(syncRoomId);
  }

  if (urlInput) {
    urlInput.value = overlayUrl;
    urlInput.addEventListener('click', () => {
      urlInput.select();
    });
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(overlayUrl).then(() => {
          const orig = btnCopy.textContent;
          btnCopy.textContent = '✅ コピー完了！';
          setTimeout(() => { btnCopy.textContent = orig; }, 2000);
        }).catch(() => {
          if (urlInput) {
            urlInput.select();
            document.execCommand('copy');
            alert('OBS用URLをクリップボードにコピーしました！\nOBSの「ブラウザ」ソースに貼り付けてください。');
          }
        });
      } else if (urlInput) {
        urlInput.select();
        document.execCommand('copy');
        alert('OBS用URLをクリップボードにコピーしました！\nOBSの「ブラウザ」ソースに貼り付けてください。');
      }
    });
  }

  // ウィンドウオープン管理用
  let miniWindowRef = null;
  const winW = 530;
  const winH = Math.min(840, (window.screen && window.screen.availHeight ? window.screen.availHeight - 60 : 820));

  function openMiniWindow(left, top) {
    const l = (left !== undefined) ? left : Math.max(10, Math.floor(((window.screen.availWidth || 1920) - (winW * 2 + 16)) / 2));
    const t = (top !== undefined) ? top : Math.max(10, Math.floor(((window.screen.availHeight || 1080) - winH) / 2));
    const mini = window.open(baseUrl, 'SchaleGachaTrackerMini', `width=${winW},height=${winH},left=${l},top=${t},menubar=no,toolbar=no`);
    if (mini) {
      try { mini.focus(); } catch (e) {}
      miniWindowRef = mini;
    }
    return mini;
  }

  function openOverlayWindow(left, top) {
    const l = (left !== undefined) ? left : Math.max(10, Math.floor(((window.screen.availWidth || 1920) - (winW * 2 + 16)) / 2) + winW + 10);
    const t = (top !== undefined) ? top : Math.max(10, Math.floor(((window.screen.availHeight || 1080) - winH) / 2));
    const ov = window.open(overlayUrl, 'SchaleGachaOverlay', `width=${winW},height=${winH},left=${l},top=${t},menubar=no,toolbar=no,location=no`);
    if (ov) {
      try { ov.focus(); } catch (e) {}
    }
    return ov;
  }

  // 1. 小窓化ボタン (手元の操作・編集用ウィンドウ)
  if (btnPopout) {
    btnPopout.addEventListener('click', () => {
      const availW = (window.screen && window.screen.availWidth) ? window.screen.availWidth : 1920;
      const availH = (window.screen && window.screen.availHeight) ? window.screen.availHeight : 1080;
      const totalWidth = winW * 2 + 14;
      const startLeft = Math.max(10, Math.floor((availW - totalWidth) / 2));
      const topPos = Math.max(10, Math.floor((availH - winH) / 2));
      openMiniWindow(startLeft, topPos);
    });
  }

  // 2. 配信プレビュー画面(OBS用)ボタン: 小窓とプレビューを並べて開く / 既に開いている小窓の右隣に開く
  if (btnOpenOverlay) {
    btnOpenOverlay.addEventListener('click', () => {
      const isCurrentlyMini = (window.name === 'SchaleGachaTrackerMini') || (window.outerWidth <= 650);

      if (isCurrentlyMini) {
        // 小窓自身の中で押された場合: その小窓の右隣にプレビューを開く
        const curX = window.screenX !== undefined ? window.screenX : (window.screenLeft || 20);
        const curY = window.screenY !== undefined ? window.screenY : (window.screenTop || 20);
        const curW = window.outerWidth || winW;
        openOverlayWindow(curX + curW + 8, curY);
      } else {
        // メイン画面で押された場合:
        let miniX = null;
        let miniY = null;
        let miniWidth = winW;
        let hasAliveMini = false;

        if (miniWindowRef && !miniWindowRef.closed) {
          try {
            miniX = miniWindowRef.screenX !== undefined ? miniWindowRef.screenX : miniWindowRef.screenLeft;
            miniY = miniWindowRef.screenY !== undefined ? miniWindowRef.screenY : miniWindowRef.screenTop;
            miniWidth = miniWindowRef.outerWidth || winW;
            hasAliveMini = true;
            miniWindowRef.focus();
          } catch (e) {}
        }

        if (hasAliveMini && miniX !== null) {
          // 既に開いている小窓の右隣に開く
          openOverlayWindow(miniX + miniWidth + 8, miniY);
        } else {
          // 小窓とプレビューの両方を左右に並べて同時に開く
          const availW = (window.screen && window.screen.availWidth) ? window.screen.availWidth : 1920;
          const availH = (window.screen && window.screen.availHeight) ? window.screen.availHeight : 1080;
          const totalWidth = winW * 2 + 14;
          const startLeft = Math.max(10, Math.floor((availW - totalWidth) / 2));
          const topPos = Math.max(10, Math.floor((availH - winH) / 2));

          // ポップアップブロッカー回避: 単一ウィンドウのみを開く
          openOverlayWindow(startLeft + winW + 10, topPos);
        }
      }
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
  recalculatePullsIndexAndCharge();
  persistState();

  const remainingBatches = getAllBatches();
  if (remainingBatches.length > 0) {
    loadBatchById(remainingBatches[remainingBatches.length - 1]);
  } else {
    setupInputSheet();
  }

  updateAllStats();
  renderHistoryTable();
  renderDirectoryGrid();
  renderConvergenceChart();
  renderSheetTimelineNav();
  broadcastSyncState();
}

// ==========================================================================
// 新規生徒仮登録・切り抜きエンジン (□と〇のプレビュー・添付1枚目再現)
// ==========================================================================

const CropperState = {
  img: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
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

  // キャンバスドラッグ操作 (マウス)
  canvas.addEventListener('mousedown', (e) => {
    if (!CropperState.img) return;
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

  // マウスホイールでのズームイン・ズームアウト
  canvas.addEventListener('wheel', (e) => {
    if (!CropperState.img) return;
    e.preventDefault();
    const zoomDelta = e.deltaY < 0 ? 0.08 : -0.08;
    CropperState.scale = Math.max(0.3, Math.min(4.0, CropperState.scale + zoomDelta));
    const slider = document.getElementById('cropZoomSlider');
    if (slider) slider.value = CropperState.scale.toFixed(2);
    drawCropper();
  }, { passive: false });

  // ズームスライダー
  const slider = document.getElementById('cropZoomSlider');
  if (slider) {
    slider.addEventListener('input', (e) => {
      CropperState.scale = parseFloat(e.target.value);
      drawCropper();
    });
  }

  // 90度回転ボタン
  const btnRotate = document.getElementById('btnCropRotate');
  if (btnRotate) {
    btnRotate.addEventListener('click', () => {
      if (!CropperState.img) return;
      CropperState.rotation = (CropperState.rotation + 90) % 360;
      drawCropper();
    });
  }

  // ズームイン・ズームアウト・リセットボタン
  const btnReset = document.getElementById('btnCropReset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      if (!CropperState.img) return;
      CropperState.rotation = 0;
      CropperState.offsetX = 0;
      CropperState.offsetY = 0;
      const minSide = Math.min(CropperState.img.width, CropperState.img.height);
      CropperState.scale = Math.max(0.4, Math.min(3.0, 160 / minSide));
      if (slider) slider.value = CropperState.scale.toFixed(2);
      drawCropper();
    });
  }

  // 生徒名リアルタイム反映
  const nameInput = document.getElementById('customStudentName');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      updateCardPreview();
    });
  }

  // 保存ボタン
  const btnSaveStudent = document.getElementById('btnSaveCustomStudent');
  if (btnSaveStudent) {
    btnSaveStudent.addEventListener('click', saveCustomStudent);
  }

  // キャンセルボタン
  const btnCancel = document.getElementById('btnCancelCustomModal');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      const modal = document.getElementById('modalCustomStudent');
      if (modal && typeof modal.close === 'function') modal.close();
    });
  }
}

function loadCropperImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      CropperState.img = img;
      CropperState.rotation = 0;
      CropperState.offsetX = 0;
      CropperState.offsetY = 0;

      // 初期倍率を枠 (140px) に程よくフィットするよう自動調整
      const minSide = Math.min(img.width, img.height);
      const initialScale = Math.max(0.4, Math.min(3.0, 160 / minSide));
      CropperState.scale = initialScale;

      const slider = document.getElementById('cropZoomSlider');
      if (slider) slider.value = initialScale.toFixed(2);

      const tools = document.getElementById('cropperTools');
      if (tools) tools.style.display = 'flex';

      const placeholder = document.getElementById('cropPlaceholder');
      if (placeholder) placeholder.style.display = 'none';

      const btnSave = document.getElementById('btnSaveCustomStudent');
      if (btnSave) btnSave.disabled = false;

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

  canvas.width = 280;
  canvas.height = 280;
  ctx.clearRect(0, 0, 280, 280);

  const img = CropperState.img;
  const cx = 140;
  const cy = 140;

  // 画像描画 (回転・移動・スケールを反映)
  ctx.save();
  ctx.translate(cx + CropperState.offsetX, cy + CropperState.offsetY);
  ctx.rotate((CropperState.rotation * Math.PI) / 180);
  ctx.scale(CropperState.scale, CropperState.scale);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();

  // カードプレビューをリアルタイム更新
  updateCardPreview();
}

/**
 * 切り抜き枠 (中央 140x140) の内容を円形アイコン (160x160) として抽出する
 */
function getCroppedDataUrl() {
  const canvas = document.getElementById('cropCanvas');
  if (!canvas || !CropperState.img) return null;

  const cropSize = 140;
  const cx = 140;
  const cy = 140;

  // 出力用オフスクリーンキャンバス (160x160 高解像度)
  const outCanvas = document.createElement('canvas');
  outCanvas.width = 160;
  outCanvas.height = 160;
  const outCtx = outCanvas.getContext('2d');

  // 円形クリップ
  outCtx.save();
  outCtx.beginPath();
  outCtx.arc(80, 80, 80, 0, Math.PI * 2);
  outCtx.closePath();
  outCtx.clip();

  // メインキャンバスの切り抜き枠 (140x140) を 160x160 にコピー
  outCtx.drawImage(
    canvas,
    cx - cropSize / 2,
    cy - cropSize / 2,
    cropSize,
    cropSize,
    0,
    0,
    160,
    160
  );
  outCtx.restore();

  return outCanvas.toDataURL('image/png');
}

/**
 * 右下のカード形式プレビューをリアルタイム更新
 */
function updateCardPreview() {
  const cardImg = document.getElementById('cardSampleImg');
  const cardName = document.getElementById('cardSampleName');
  const nameInput = document.getElementById('customStudentName');

  if (cardImg && CropperState.img) {
    const url = getCroppedDataUrl();
    if (url) cardImg.src = url;
  }

  if (cardName) {
    cardName.textContent = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : '生徒名';
  }

  const btnSave = document.getElementById('btnSaveCustomStudent');
  if (btnSave) {
    btnSave.disabled = !CropperState.img;
  }
}

function saveCustomStudent() {
  const nameInput = document.getElementById('customStudentName');
  if (!nameInput || !nameInput.value.trim()) {
    alert('生徒名を入力してください。');
    if (nameInput) nameInput.focus();
    return;
  }

  if (!CropperState.img) {
    alert('画像をアップロードしてください。');
    return;
  }

  const rawName = nameInput.value.trim();
  const name = typeof normalizeStudentName === 'function' ? normalizeStudentName(rawName) : rawName;
  const iconDataUrl = getCroppedDataUrl();

  if (!iconDataUrl) {
    alert('アイコン画像の切り抜き生成に失敗しました。');
    return;
  }

  if (!AppState.customStudents) {
    AppState.customStudents = {};
  }

  AppState.customStudents[name] = {
    icon: iconDataUrl,
    createdAt: new Date().toISOString(),
    wikiSynced: false
  };

  persistState();
  if (typeof updateAllStats === 'function') updateAllStats();
  if (typeof renderDirectoryGrid === 'function') renderDirectoryGrid();
  if (typeof renderHistoryTable === 'function') renderHistoryTable();
  if (typeof renderCustomStudentsTableIfOpen === 'function') renderCustomStudentsTableIfOpen();

  // 現在ガチャ入力シートが開いていれば、その行の生徒アイコンも即座に再描画
  if (typeof renderInputSheetTable === 'function') {
    renderInputSheetTable();
  }

  alert(`生徒「${name}」のアイコンを登録しました！ガチャ入力で利用可能です。`);
  const modal = document.getElementById('modalCustomStudent');
  if (modal && typeof modal.close === 'function') modal.close();
}

// ==========================================================================
// 仮登録生徒マネージャー & GitHubプッシュ共有
// ==========================================================================

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, match => {
    switch (match) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return match;
    }
  });
}

function initCustomStudentEditor() {
  const modal = document.getElementById('modalCustomEditor');
  if (!modal) return;

  const tokenInput = document.getElementById('githubTokenInput');
  const btnSaveToken = document.getElementById('btnSaveGithubToken');
  const btnPush = document.getElementById('btnPushToGithub');
  const btnExport = document.getElementById('btnExportCustomJson');
  const btnImport = document.getElementById('btnImportCustomJson');
  const fileImport = document.getElementById('importCustomFileInput');
  const btnSyncWiki = document.getElementById('btnSyncWiki');

  // トークン初期表示
  if (tokenInput && AppState.github && AppState.github.token) {
    tokenInput.value = AppState.github.token;
  }

  // トークン保存ボタン
  if (btnSaveToken && tokenInput) {
    btnSaveToken.addEventListener('click', () => {
      const val = tokenInput.value.trim();
      AppState.github.token = val;
      localStorage.setItem('ba_github_token', val);
      alert('GitHub Personal Access Token を保存しました。');
    });
  }

  // GitHubへプッシュ共有ボタン
  if (btnPush) {
    btnPush.addEventListener('click', pushCustomStudentsToGitHub);
  }

  // JSONエクスポートボタン
  if (btnExport) {
    btnExport.addEventListener('click', () => {
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify({ students: AppState.customStudents }, null, 2));
      const a = document.createElement('a');
      a.href = dataStr;
      a.download = `custom_students_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  // JSONインポートボタン
  if (btnImport && fileImport) {
    btnImport.addEventListener('click', () => fileImport.click());
    fileImport.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const parsed = JSON.parse(evt.target.result);
            if (parsed && parsed.students) {
              AppState.customStudents = Object.assign(AppState.customStudents, parsed.students);
              persistState();
              renderCustomStudentsTableIfOpen();
              updateAllStats();
              renderDirectoryGrid();
              if (typeof renderInputSheetTable === 'function') renderInputSheetTable();
              alert('仮登録生徒データをインポートしました！');
            } else {
              alert('JSON形式が正しくありません。「students」オブジェクトが必要です。');
            }
          } catch (err) {
            alert('JSONの解析に失敗しました: ' + err.message);
          }
        };
        reader.readAsText(e.target.files[0]);
      }
    });
  }

  // Wikiデータ照合＆自動クリーンアップ
  if (btnSyncWiki) {
    btnSyncWiki.addEventListener('click', async () => {
      await loadStudentDictionaries();
      cleanupSyncedCustomStudents(true);
      updateAllStats();
      renderDirectoryGrid();
      renderCustomStudentsTableIfOpen();
    });
  }
}

/**
 * 仮登録マネージャーのテーブル一覧を描画
 */
function renderCustomStudentsTableIfOpen() {
  const tbody = document.getElementById('customStudentsTbody');
  const empty = document.getElementById('customStudentsEmpty');
  if (!tbody) return;

  const names = Object.keys(AppState.customStudents || {});
  tbody.innerHTML = '';

  if (names.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  names.forEach(name => {
    const data = AppState.customStudents[name];
    if (!data) return;

    const tr = document.createElement('tr');
    const inOfficial = Boolean(AppState.officialStudents[name] || AppState.officialStudents[normalizeStudentName(name)]);

    // 1. アイコン
    const tdIcon = document.createElement('td');
    tdIcon.style.textAlign = 'center';
    const img = document.createElement('img');
    img.className = 'custom-row-avatar';
    img.src = data.icon || '';
    img.alt = name;
    img.style.width = '36px';
    img.style.height = '36px';
    img.style.borderRadius = '50%';
    img.style.objectFit = 'cover';
    img.style.border = '2px solid #00aeef';
    img.style.verticalAlign = 'middle';
    tdIcon.appendChild(img);
    tr.appendChild(tdIcon);

    // 2. 生徒名入力
    const tdName = document.createElement('td');
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.className = 'styled-form-input edit-name-input';
    inputName.value = name;
    inputName.dataset.originalName = name;
    inputName.style.fontSize = '12px';
    inputName.style.padding = '4px 8px';
    inputName.style.width = '100%';
    inputName.style.boxSizing = 'border-box';
    tdName.appendChild(inputName);
    tr.appendChild(tdName);

    // 3. 登録日
    const tdDate = document.createElement('td');
    tdDate.style.fontSize = '11px';
    tdDate.style.color = '#64748b';
    tdDate.style.whiteSpace = 'nowrap';
    tdDate.textContent = data.createdAt ? data.createdAt.slice(0, 10) : '-';
    tr.appendChild(tdDate);

    // 4. 状況
    const tdStatus = document.createElement('td');
    tdStatus.style.whiteSpace = 'nowrap';
    const statusBadge = document.createElement('span');
    statusBadge.className = inOfficial ? 'status-badge badge-fifty' : 'status-badge badge-regular';
    statusBadge.style.fontSize = '10px';
    statusBadge.textContent = inOfficial ? 'Wiki登録済 (削除推奨)' : '仮登録中';
    tdStatus.appendChild(statusBadge);
    tr.appendChild(tdStatus);

    // 5. 操作
    const tdAction = document.createElement('td');
    const actWrap = document.createElement('div');
    actWrap.style.display = 'flex';
    actWrap.style.gap = '4px';
    actWrap.style.justifyContent = 'center';

    const btnUpdate = document.createElement('button');
    btnUpdate.type = 'button';
    btnUpdate.className = 'btn-cyan-sm btn-update-name';
    btnUpdate.textContent = '更新';
    btnUpdate.style.padding = '3px 8px';
    btnUpdate.style.fontSize = '11px';
    btnUpdate.dataset.originalName = name;

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn-dialog-cancel btn-delete-custom';
    btnDelete.textContent = '削除';
    btnDelete.style.padding = '3px 8px';
    btnDelete.style.fontSize = '11px';
    btnDelete.style.background = '#fef2f2';
    btnDelete.style.borderColor = '#fca5a5';
    btnDelete.style.color = '#ef4444';
    btnDelete.dataset.name = name;

    actWrap.appendChild(btnUpdate);
    actWrap.appendChild(btnDelete);
    tdAction.appendChild(actWrap);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  });

  // 生徒名更新ボタン
  tbody.querySelectorAll('.btn-update-name').forEach(btn => {
    btn.addEventListener('click', () => {
      const orig = btn.dataset.originalName;
      const input = tbody.querySelector(`.edit-name-input[data-original-name="${orig}"]`);
      if (input) {
        const newName = input.value.trim();
        if (!newName) {
          alert('生徒名を入力してください。');
          return;
        }
        if (newName !== orig) {
          AppState.customStudents[newName] = AppState.customStudents[orig];
          delete AppState.customStudents[orig];
          persistState();
          renderCustomStudentsTableIfOpen();
          updateAllStats();
          renderDirectoryGrid();
          if (typeof renderInputSheetTable === 'function') renderInputSheetTable();
          alert(`生徒名を「${newName}」に更新しました。`);
        }
      }
    });
  });

  // 削除ボタン
  tbody.querySelectorAll('.btn-delete-custom').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      if (confirm(`仮登録生徒「${name}」を削除しますか？`)) {
        delete AppState.customStudents[name];
        persistState();
        renderCustomStudentsTableIfOpen();
        updateAllStats();
        renderDirectoryGrid();
        if (typeof renderInputSheetTable === 'function') renderInputSheetTable();
      }
    });
  });
}

/**
 * GitHubプッシュ共有 (Personal Access Token API)
 */
async function pushCustomStudentsToGitHub() {
  const tokenInput = document.getElementById('githubTokenInput');
  const token = (tokenInput && tokenInput.value.trim()) || (AppState.github && AppState.github.token);
  const statusEl = document.getElementById('githubSyncResult');

  if (!token) {
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#ef4444; font-weight:bold;">⚠️ GitHub Personal Access Token を入力してください。</span>';
    } else {
      alert('GitHub Personal Access Token を入力してください。');
    }
    if (tokenInput) tokenInput.focus();
    return;
  }

  // トークンを保存
  AppState.github.token = token;
  localStorage.setItem('ba_github_token', token);

  if (statusEl) {
    statusEl.innerHTML = '<span style="color:#00aeef; font-weight:bold;">⏳ GitHubへプッシュ中...</span>';
  }

  try {
    const owner = AppState.github.repoOwner || 'roundabout-oxygen';
    const repo = AppState.github.repoName || 'ba_gacha_tracker';
    const path = AppState.github.filePath || 'data/custom_students.json';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    // 既存ファイルのSHAを取得
    let sha = '';
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    } else if (getRes.status === 401) {
      throw new Error('トークンが無効または有効期限切れです (401 Unauthorized)');
    } else if (getRes.status === 404) {
      // ファイル未存在の場合は新規作成
    } else {
      throw new Error(`GitHub API エラー: ${getRes.status} ${getRes.statusText}`);
    }

    // JSONコンテンツの生成 (UTF-8 Base64)
    const contentObj = { students: AppState.customStudents };
    const jsonStr = JSON.stringify(contentObj, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(jsonStr)));

    const body = {
      message: `Update custom_students.json via Web App (${APP_VERSION})`,
      content: base64Content
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (putRes.ok) {
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#10b981; font-weight:bold;">✅ GitHubへのプッシュ共有が成功しました！</span>';
      }
      alert('GitHubへのプッシュ共有が完了しました！他の利用者も最新データを取得できます。');
    } else {
      const errData = await putRes.json().catch(() => ({}));
      const msg = errData.message || `${putRes.status} ${putRes.statusText}`;
      if (statusEl) {
        statusEl.innerHTML = `<span style="color:#ef4444; font-weight:bold;">❌ プッシュ失敗: ${msg}</span>`;
      }
      alert(`GitHubへのプッシュに失敗しました: ${msg}`);
    }
  } catch (err) {
    if (statusEl) {
      statusEl.innerHTML = `<span style="color:#ef4444; font-weight:bold;">❌ エラー: ${err.message}</span>`;
    }
    alert(`エラーが発生しました: ${err.message}`);
  }
}

// グローバルAPI公開 (デバッグ・外部連携・自動検証用)
if (typeof window !== 'undefined') {
  window.AppState = AppState;
  window.switchTab = switchTab;
  window.loadDemoGachaData = loadDemoGachaData;
  window.setupInputSheet = setupInputSheet;
  window.renderInputSheetTable = renderInputSheetTable;
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
  window.CropperState = CropperState;
  window.loadCropperImageFile = loadCropperImageFile;
  window.drawCropper = drawCropper;
  window.getCroppedDataUrl = getCroppedDataUrl;
  window.saveCustomStudent = saveCustomStudent;
  window.initCustomStudentEditor = initCustomStudentEditor;
  window.renderCustomStudentsTableIfOpen = renderCustomStudentsTableIfOpen;
  window.pushCustomStudentsToGitHub = pushCustomStudentsToGitHub;
}
