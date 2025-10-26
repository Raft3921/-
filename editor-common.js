// きのこジャンプ中の移動許可設定を取得する関数
function isMushroomMoveAllowed() {
  return localStorage.getItem('editor_mushroomMove') === 'true';
}
// プレイ開始時刻
window.gameStartTime = performance.now();
const urlParams = new URLSearchParams(window.location.search);
var slotName = urlParams.get("slot");
if (!slotName) slotName = localStorage.getItem("currentSlot") || "新しいワールド";
slotName = String(slotName); // 文字列化
window.slotName = slotName;

// 動く敵の画像サイズに合わせたヒットボックス（グローバル定義）
window.ENEMY_HITBOX = {offset: 12, size: 8};
// 押し出し用の当たり判定（動く敵の画像と同じサイズ）
window.ENEMY_PUSH_HITBOX = {offset: 12, size: 4};

const TILE_SIZE = 32;
const SCALE = 2.0;
const mapCols = 1000;
const mapRows = 20;
const map = [];

const STATIC_CHUNK_TILE_WIDTH = 32;
const STATIC_TILE_IDS = new Set([1, 2, 4, 5, 6, 8, 12, 13, 14,
 15, 16, 17,
 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30
]);
let staticChunkCanvases = [];
let staticChunkDirtyFlags = [];
let staticChunkCanvasHeight = mapRows * TILE_SIZE;
const chunkPreloadQueue = [];
const chunkPreloadSet = new Set();
let chunkFrameCounter = 0;
const MAX_PRELOAD_PER_FRAME = 2;
const IDLE_PLAYER_SPEED = 0.25;
const IDLE_CAMERA_SPEED = 0.5;

function getMapDimensions(rawMap) {
  if (!Array.isArray(rawMap)) {
    return { rows: 0, cols: 0 };
  }
  let maxCols = 0;
  for (let r = 0; r < rawMap.length; r++) {
    const row = rawMap[r];
    if (Array.isArray(row) && row.length > maxCols) {
      maxCols = row.length;
    }
  }
  return { rows: rawMap.length, cols: maxCols };
}

function normalizeWorldMap(rawMap, options = {}) {
  const { targetRows, targetCols, minRows = mapRows, minCols = mapCols } = options;
  const safeMap = Array.isArray(rawMap) ? rawMap : [];
  const sourceRows = safeMap.length;
  let sourceCols = 0;
  for (let r = 0; r < safeMap.length; r++) {
    const row = safeMap[r];
    if (Array.isArray(row) && row.length > sourceCols) {
      sourceCols = row.length;
    }
  }
  const finalRows = Number.isInteger(targetRows) && targetRows > 0 ? targetRows : Math.max(sourceRows, minRows);
  const finalCols = Number.isInteger(targetCols) && targetCols > 0 ? targetCols : Math.max(sourceCols, minCols);
  const normalized = new Array(finalRows);
  for (let r = 0; r < finalRows; r++) {
    const srcRow = Array.isArray(safeMap[r]) ? safeMap[r] : [];
    const newRow = new Array(finalCols);
    for (let c = 0; c < finalCols; c++) {
      const value = srcRow[c];
      const numeric = typeof value === "number" ? value : Number(value);
      newRow[c] = Number.isFinite(numeric) ? numeric : 0;
    }
    normalized[r] = newRow;
  }
  return {
    map: normalized,
    targetRows: finalRows,
    targetCols: finalCols,
    sourceRows,
    sourceCols,
    mismatch: finalRows !== sourceRows || finalCols !== sourceCols
  };
}

function trimWorldMetadata(boundsRows, boundsCols) {
  const clampKeys = (obj) => {
    if (!obj) return;
    Object.keys(obj).forEach(key => {
      const [rStr, cStr] = key.split(',');
      const r = Number(rStr);
      const c = Number(cStr);
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= boundsRows || c < 0 || c >= boundsCols) {
        delete obj[key];
      }
    });
  };
  clampKeys(window.dummyOverlays);
  clampKeys(window.enemyDirs);
  clampKeys(window.trampolineAngles);
  clampKeys(window.trampolinePowers);
  clampKeys(window.enemyProps);
}

function ensureStaticChunkCapacityForCol(col) {
  if (!Number.isFinite(col) || col < 0) return;
  const requiredChunks = Math.floor(col / STATIC_CHUNK_TILE_WIDTH) + 1;
  while (staticChunkCanvases.length < requiredChunks) {
    staticChunkCanvases.push(null);
    staticChunkDirtyFlags.push(true);
  }
}

function enqueueStaticChunk(index) {
  if (!Number.isFinite(index) || index < 0) return;
  ensureStaticChunkCapacityForCol(index * STATIC_CHUNK_TILE_WIDTH);
  if (chunkPreloadSet.has(index)) return;
  chunkPreloadQueue.push(index);
  chunkPreloadSet.add(index);
}

function markStaticChunkDirtyByTile(row, col) {
  if (!Number.isFinite(col)) return;
  ensureStaticChunkCapacityForCol(col);
  const chunkIndex = Math.floor(col / STATIC_CHUNK_TILE_WIDTH);
  for (let offset = -1; offset <= 1; offset++) {
    const idx = chunkIndex + offset;
    if (idx >= 0 && idx < staticChunkDirtyFlags.length) {
      staticChunkDirtyFlags[idx] = true;
      enqueueStaticChunk(idx);
    }
  }
}

function markTileAndNeighborsDirty(row, col) {
  markStaticChunkDirtyByTile(row, col);
  markStaticChunkDirtyByTile(row, col - 1);
  markStaticChunkDirtyByTile(row, col + 1);
}

function resetStaticChunks() {
  staticChunkCanvases = [];
  staticChunkDirtyFlags = [];
  chunkPreloadQueue.length = 0;
  chunkPreloadSet.clear();
  chunkFrameCounter = 0;
  const totalChunks = Math.ceil(getMaxMapCols() / STATIC_CHUNK_TILE_WIDTH);
  for (let idx = 0; idx < totalChunks; idx++) {
    enqueueStaticChunk(idx);
  }
}

function getMaxMapCols() {
  let maxCols = 0;
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    if (Array.isArray(row) && row.length > maxCols) {
      maxCols = row.length;
    }
  }
  return Math.max(maxCols, mapCols);
}

function renderStaticChunk(index) {
  chunkPreloadSet.delete(index);
  const queuePos = chunkPreloadQueue.indexOf(index);
  if (queuePos !== -1) {
    chunkPreloadQueue.splice(queuePos, 1);
  }
  ensureStaticChunkCapacityForCol(index * STATIC_CHUNK_TILE_WIDTH);
  const tileStart = index * STATIC_CHUNK_TILE_WIDTH;
  const maxCols = getMaxMapCols();
  const tileEnd = Math.min(tileStart + STATIC_CHUNK_TILE_WIDTH, maxCols);
  if (tileStart >= tileEnd) {
    staticChunkCanvases[index] = null;
    return null;
  }
  const widthTiles = tileEnd - tileStart;
  const canvasWidth = widthTiles * TILE_SIZE;
  const canvasHeight = (map.length || mapRows) * TILE_SIZE;
  staticChunkCanvasHeight = canvasHeight;
  const chunkRecord = staticChunkCanvases[index] || {};
  let chunkCanvas = chunkRecord.canvas;
  if (!chunkCanvas) {
    chunkCanvas = document.createElement('canvas');
    chunkCanvas.getContext('2d');
  }
  if (chunkCanvas.width !== canvasWidth) {
    chunkCanvas.width = canvasWidth;
  }
  if (chunkCanvas.height !== canvasHeight) {
    chunkCanvas.height = canvasHeight;
  }
  const cctx = chunkCanvas.getContext('2d');
  if (!cctx) return null;
  cctx.imageSmoothingEnabled = false;
  cctx.clearRect(0, 0, canvasWidth, canvasHeight);

  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    if (!Array.isArray(row)) continue;
    for (let col = tileStart; col < tileEnd; col++) {
      const tile = row[col];
      if (!STATIC_TILE_IDS.has(tile)) continue;
      const drawX = (col - tileStart) * TILE_SIZE;
      const drawY = r * TILE_SIZE;
      if (tile === 1) {
        cctx.drawImage(groundImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 2) {
        cctx.drawImage(dirtImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 4) {
        cctx.drawImage(goalImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 5) {
        cctx.drawImage(stoneImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 6) {
        cctx.drawImage(poisonImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 8) {
        cctx.drawImage(ladderImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 15) {
        cctx.drawImage(coinImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 16) {
        cctx.drawImage(checkpointImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 17) {
        cctx.drawImage(goldgoalImg, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile >= 20 && tile <= 30) {
        const idx = tile - 20;
        const img = colorBlockImages[idx];
        if (img) cctx.drawImage(img, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 12) {
        cctx.drawImage(rail1Img, drawX, drawY, TILE_SIZE, TILE_SIZE);
      } else if (tile === 13) {
        const hasLeftRail = col > 0 && row[col - 1] >= 12 && row[col - 1] <= 14;
        if (hasLeftRail) {
          cctx.drawImage(rail2Img, drawX, drawY, TILE_SIZE, TILE_SIZE);
        } else {
          cctx.save();
          cctx.translate(drawX + TILE_SIZE, drawY);
          cctx.scale(-1, 1);
          cctx.drawImage(rail2Img, 0, 0, TILE_SIZE, TILE_SIZE);
          cctx.restore();
        }
      } else if (tile === 14) {
        cctx.drawImage(rail3Img, drawX, drawY, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  const chunkData = {
    canvas: chunkCanvas,
    tileStart,
    tileEnd,
    width: canvasWidth,
    height: canvasHeight
  };
  staticChunkCanvases[index] = chunkData;
  staticChunkDirtyFlags[index] = false;
  return chunkData;
}

function getStaticChunk(index) {
  ensureStaticChunkCapacityForCol(index * STATIC_CHUNK_TILE_WIDTH);
  if (!staticChunkCanvases[index] || staticChunkDirtyFlags[index]) {
    return renderStaticChunk(index);
  }
  return staticChunkCanvases[index];
}

function drawStaticChunks(ctx, visibleColStart, visibleColEnd) {
  const chunkStart = Math.max(0, Math.floor(visibleColStart / STATIC_CHUNK_TILE_WIDTH));
  const chunkEnd = Math.floor(Math.max(visibleColEnd - 1, visibleColStart) / STATIC_CHUNK_TILE_WIDTH);
  for (let chunkIndex = chunkStart; chunkIndex <= chunkEnd; chunkIndex++) {
    const chunk = getStaticChunk(chunkIndex);
    if (!chunk || !chunk.canvas) continue;
    const pixelX = chunk.tileStart * TILE_SIZE;
    ctx.drawImage(chunk.canvas, pixelX, 0);
    enqueueStaticChunk(chunkIndex - 1);
    enqueueStaticChunk(chunkIndex + 1);
    enqueueStaticChunk(chunkIndex - 2);
    enqueueStaticChunk(chunkIndex + 2);
  }
}

function processStaticChunkQueue() {
  if (!chunkPreloadQueue.length) return;
  chunkFrameCounter++;
  const cameraSpeed = Math.abs(cameraX - prevCameraX) + Math.abs(cameraY - prevCameraY);
  let playerSpeed = 0;
  if (typeof player === 'object') {
    playerSpeed = Math.abs(player.vx || 0) + Math.abs(player.vy || 0);
  }
  const isIdle = playerSpeed < IDLE_PLAYER_SPEED && cameraSpeed < IDLE_CAMERA_SPEED;
  const allowWork = isIdle || (chunkFrameCounter % 4 === 0);
  if (!allowWork) return;
  const steps = isIdle ? MAX_PRELOAD_PER_FRAME : 1;
  for (let i = 0; i < steps && chunkPreloadQueue.length; i++) {
    const chunkIndex = chunkPreloadQueue.shift();
    chunkPreloadSet.delete(chunkIndex);
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0) continue;
    ensureStaticChunkCapacityForCol(chunkIndex * STATIC_CHUNK_TILE_WIDTH);
    if (!staticChunkDirtyFlags[chunkIndex] && staticChunkCanvases[chunkIndex]) {
      continue;
    }
    renderStaticChunk(chunkIndex);
  }
}

function applyWorldMap(mapSource, metadata = {}, options = {}) {
  const normalized = normalizeWorldMap(mapSource, options);
  map.length = 0;
  map.push(...normalized.map);

  window.dummyOverlays = metadata.dummyOverlays ? Object.assign({}, metadata.dummyOverlays) : {};
  window.enemyDirs = metadata.enemyDirs ? Object.assign({}, metadata.enemyDirs) : {};
  window.trampolineAngles = metadata.trampolineAngles ? Object.assign({}, metadata.trampolineAngles) : {};
  window.trampolinePowers = metadata.trampolinePowers ? Object.assign({}, metadata.trampolinePowers) : {};
  window.enemyProps = metadata.enemyProps ? Object.assign({}, metadata.enemyProps) : {};

  trimWorldMetadata(normalized.targetRows, normalized.targetCols);
  resetStaticChunks();
  return normalized;
}

function applyWorldData(worldData, options = {}) {
  if (Array.isArray(worldData)) {
    return applyWorldMap(worldData, {}, options);
  }
  if (worldData && typeof worldData === "object" && Array.isArray(worldData.map)) {
    return applyWorldMap(worldData.map, worldData, options);
  }
  throw new Error("無効なワールドデータ形式です");
}

window.getWorldDimensions = getMapDimensions;
window.normalizeWorldMap = normalizeWorldMap;
window.trimWorldMetadata = trimWorldMetadata;
window.applyWorldData = applyWorldData;
if (typeof window.isEditorMode === 'undefined') {
  window.isEditorMode = window.location.pathname.includes('editor.html');
}

function getActiveMapBounds() {
  let maxRow = -1;
  let maxCol = -1;
  const overlayMap = window.dummyOverlays || {};

  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    if (!row) continue;
    for (let c = row.length - 1; c >= 0; c--) {
      const tile = row[c];
      const overlayKey = `${r},${c}`;
      const overlayTile = overlayMap[overlayKey];
      if (tile !== 0 || (overlayTile !== undefined && overlayTile !== 0)) {
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
        break;
      }
    }
  }

  const rows = maxRow >= 0 ? maxRow + 1 : Math.max(1, Math.min(map.length || 1, mapRows));
  const cols = maxCol >= 0 ? maxCol + 1 : Math.max(1, Math.min(map[0]?.length || 1, mapCols));
  return { rows, cols };
}
window.getActiveMapBounds = getActiveMapBounds;

const debugLog = (...args) => {
  if (window.debugMode) console.log(...args);
};

const debugWarn = (...args) => {
  if (window.debugMode) console.warn(...args);
};

// 地形データのロード
function loadMapFromStorage() {
  const savedMap = localStorage.getItem("world_" + slotName);
  if (savedMap) {
    try {
      const parsed = JSON.parse(savedMap);
      applyWorldData(parsed, { minRows: mapRows, minCols: mapCols });
      saveThumbnailData();
      return true;
    } catch (e) {
      console.error("マップ読み込みエラー:", e);
    }
  }
  applyWorldData([], { targetRows: mapRows, targetCols: mapCols });
  saveThumbnailData();
  return false;
}
loadMapFromStorage();

// ワールド読み込み後に敵の設定をUIに反映（エディターの場合のみ）
if (typeof updateEnemySettingsUI === 'function') {
  updateEnemySettingsUI();
}

// 色ブロック設定の読み込み
function loadColorBlockSettings() {
  const saved = localStorage.getItem('colorBlockSettings');
  if (saved) {
    window.colorBlockSettings = JSON.parse(saved);
  } else {
    window.colorBlockSettings = {};
  }
}
loadColorBlockSettings();

function resolveAsset(name) {
  if (typeof window.getAssetURL === 'function') {
    return window.getAssetURL(name);
  }
  if (window.ASSETS_BASE64 && window.ASSETS_BASE64[name]) {
    return window.ASSETS_BASE64[name];
  }
  return `assets/${name}`;
}

function shouldUseCrossOrigin() {
  if (typeof location === 'undefined') return true;
  return location.protocol !== 'file:';
}

function createImage(name) {
  const img = new Image();
  if (shouldUseCrossOrigin()) {
    img.crossOrigin = "anonymous";
  }
  img.src = resolveAsset(name);
  return img;
}

function waitForImage(img) {
  return new Promise(resolve => {
    if (!img) {
      resolve();
      return;
    }
    if (img.complete && img.naturalWidth > 0) {
      resolve();
      return;
    }
    const finalize = () => {
      img.onload = null;
      img.onerror = null;
      resolve();
    };
    img.onload = finalize;
    img.onerror = finalize;
  });
}

// 色変換用のヘルパー関数
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function rgbToHue(rgb) {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  
  if (max === min) {
    h = 0; // グレー
  } else {
    const d = max - min;
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return h * 360;
}

// 画像の準備
const groundImg = createImage("ground.png");
const dirtImg = createImage("dirt.png");
const enemyImg = createImage("enemy.png");
const goalImg = createImage("goal.png");
const stoneImg = createImage("stone.png");
const poisonImg = createImage("poison.png");
const trampolineImg = createImage("trampoline.png");
const ladderImg = createImage("ladder.png");
const enemyMoveImg1 = createImage("enemy-move1.png");
const enemyMoveImg2 = createImage("enemy-move2.png");
const deathScreenImg = createImage("death_screen.png");
const deathScreenFallImg = createImage("death_screen_fall.png");
const breakblockImg = createImage("breakblock.png");
const breakableImg = breakblockImg; // breakable block
const rail1Img = createImage("rail1.png");
const rail2Img = createImage("rail2.png");
const rail3Img = createImage("rail3.png");
const coinImg = createImage("coin.png");
const checkpointImg = createImage("checkpoint.png");
const goldgoalImg = createImage("goldgoal.png");

// 色ブロック用の画像配列
const colorBlockImages = [];
for (let i = 0; i <= 10; i++) {
  const name = i === 0 ? "color.png" : `color${i}.png`;
  colorBlockImages.push(createImage(name));
}

const simpleTileImages = Object.create(null);
simpleTileImages[1] = groundImg;
simpleTileImages[2] = dirtImg;
simpleTileImages[3] = enemyImg;
simpleTileImages[4] = goalImg;
simpleTileImages[5] = stoneImg;
simpleTileImages[6] = poisonImg;
simpleTileImages[8] = ladderImg;
simpleTileImages[9] = enemyMoveImg1; // fallback if needed
simpleTileImages[11] = breakableImg;
simpleTileImages[15] = coinImg;
simpleTileImages[16] = checkpointImg;
simpleTileImages[17] = goldgoalImg;
for (let i = 0; i < colorBlockImages.length; i++) {
  simpleTileImages[20 + i] = colorBlockImages[i];
}

let canvas = typeof document !== 'undefined' ? document.getElementById("gameCanvas") : null;
let ctx = canvas ? canvas.getContext("2d") : null;
let baseCanvasWidth = canvas ? canvas.width : 1024;
let baseCanvasHeight = canvas ? canvas.height : 640;
if (canvas && ctx) {
  ctx.imageSmoothingEnabled = false;
  canvas.style.width = `${baseCanvasWidth}px`;
  canvas.style.height = `${baseCanvasHeight}px`;
  window.canvas = canvas;
  window.ctx = ctx;
  window.slotName = slotName;
  window.baseCanvasWidth = baseCanvasWidth;
  window.baseCanvasHeight = baseCanvasHeight;
}
if (typeof window.renderPixelRatio === 'undefined') {
  window.renderPixelRatio = 1;
}
if (typeof window.showCollisionBoxes === 'undefined') {
  window.showCollisionBoxes = false;
}

// 画像読み込み
const playerImg = document.getElementById("player");
const playerRun1Img = document.getElementById("player-run1");
const playerRun2Img = document.getElementById("player-run2");
const playerJump1Img = document.getElementById("player-jump1");
const playerJump2Img = document.getElementById("player-jump2");

// ラフト画像のsrcをセット（画像要素が存在する場合のみ）
if (playerImg) playerImg.src = resolveAsset("player.png");
if (playerRun1Img) playerRun1Img.src = resolveAsset("player-run1.png");
if (playerRun2Img) playerRun2Img.src = resolveAsset("player-run2.png");
if (playerJump1Img) playerJump1Img.src = resolveAsset("player-jump1.png");
if (playerJump2Img) playerJump2Img.src = resolveAsset("player-jump2.png");

// キャラクター画像の定義
const characterImages = {
  raft: {
    idle: playerImg,
    run1: playerRun1Img,
    run2: playerRun2Img,
    jump1: playerJump1Img,
    jump2: playerJump2Img
  },
  mai: {
    idle: createImage("mai.png"),
    run1: createImage("mai-run1.png"),
    run2: createImage("mai-run2.png"),
    jump1: createImage("mai-jump1.png"),
    jump2: createImage("mai-jump2.png")
  },
  tanutsuna: {
    idle: createImage("tanutsuna.png"),
    run1: createImage("tanutsuna-run1.png"),
    run2: createImage("tanutsuna-run2.png"),
    jump1: createImage("tanutsuna-jump1.png"),
    jump2: createImage("tanutsuna-jump2.png")
  }
};

// 画像読み込みエラーハンドリング
Object.values(characterImages).forEach(character => {
  Object.values(character).forEach(img => {
    if (img instanceof HTMLImageElement) {
      img.onerror = function() {
        debugWarn('キャラクター画像読み込みエラー:', img.src);
        // エラー時はラフトの画像にフォールバック
        const fallbackImages = characterImages.raft;
        if (img === character.idle) img.src = fallbackImages.idle.src;
        else if (img === character.run1) img.src = fallbackImages.run1.src;
        else if (img === character.run2) img.src = fallbackImages.run2.src;
        else if (img === character.jump1) img.src = fallbackImages.jump1.src;
        else if (img === character.jump2) img.src = fallbackImages.jump2.src;
      };
    }
  });
});

// プレイヤー
const player = {
  x: 100, y: 100, width: 22, height: 28, // 横方向のみ縮小、縦方向は28のまま
  vx: 0, vy: 0, speed: 2, jumpPower: -9,
  gravity: 0.5, onGround: false,
  airResistance: 0.98,
  maxFallSpeed: 12,
  bounceDamping: 0.7,
  isInTrampolineTrajectory: false,
  trajectoryStartTime: 0,
  initialTrajectoryVx: 0,
  initialTrajectoryVy: 0,
  isOnMovingEnemy: false,
  currentEnemy: null,
  enemyFriction: 0.8,
};
// 予測着地点（軌道開始時に計算して player.predictedLanding に保存）
player.predictedLanding = null;
player.baseSpeed = player.speed;
player.baseJumpPower = player.jumpPower;
player.dashMultiplier = 1;

const CHARACTER_TRAITS = {
  raft: {
    speed: 2,
    jumpPower: -9,
    dashMultiplier: 1
  },
  mai: {
    speed: 2,
    jumpPower: -11,
    dashMultiplier: 1
  },
  tanutsuna: {
    speed: 2,
    jumpPower: -9,
    dashMultiplier: 1.8
  }
};

function applyCharacterTraits(character) {
  const traits = CHARACTER_TRAITS[character] || CHARACTER_TRAITS.raft;
  player.baseSpeed = traits.speed;
  player.speed = traits.speed;
  player.baseJumpPower = traits.jumpPower;
  player.jumpPower = traits.jumpPower;
  player.dashMultiplier = traits.dashMultiplier || 1;
  window.currentCharacter = character;
}
window.applyCharacterTraits = applyCharacterTraits;

function snapPlayerToGroundBelow() {
  const maxCols = Math.max(1, map[0]?.length || mapCols);
  const leftCol = Math.max(0, Math.floor(player.x / TILE_SIZE));
  const rightCol = Math.min(maxCols - 1, Math.floor((player.x + player.width - 1) / TILE_SIZE));
  let startRow = Math.max(0, Math.floor((player.y + player.height - 1) / TILE_SIZE));
  for (let row = startRow; row < map.length; row++) {
    for (let col = leftCol; col <= rightCol; col++) {
      const tile = (map[row] && map[row][col]) || 0;
      if (isSolidTile(tile)) {
        player.y = row * TILE_SIZE - player.height;
        return true;
      }
    }
  }
  return false;
}

// 予測着地点を計算するユーティリティ（フレーム単位でシミュレーション）
function computePredictedLanding(initialVx, initialVy, startX, startY) {
  const gravity = player.gravity;
  const airResistance = player.airResistance;
  let vx = initialVx;
  let vy = initialVy;
  let x = startX;
  let y = startY;
  const maxSteps = 2000;
  for (let i = 0; i < maxSteps; i++) {
    vx *= airResistance;
    vy += gravity;
    x += vx;
    y += vy;
    // 衝突判定（予測用）
    const collision = checkCollision(x, y, player.width, player.height);
    if (collision) {
      // Yをタイルにスナップして地面に乗せる
      const landingRow = Math.floor((y + player.height) / TILE_SIZE);
      const finalY = landingRow * TILE_SIZE - player.height;
      const landingX = Math.max(0, Math.min(x, ((map[0]?.length || mapCols) * TILE_SIZE) - player.width));
      return { x: landingX, y: finalY };
    }
    if (y > mapRows * TILE_SIZE + TILE_SIZE) break; // 画面外
  }
  return null;
}
const respawnPoint = { x: 100, y: 100 };

// プレイヤーアニメーター
class PlayerAnimator {
  constructor() {
    this.frame = 0;
    this.timer = 0;
    this.justJumped = false;
    this.jumpFrameStart = 0;
    this.lastJumping = false;
    this.currentCharacter = 'raft';
  }
  
  setCharacter(character) {
    this.currentCharacter = character;
  }
  
  getCharacterImages() {
    const images = characterImages[this.currentCharacter] || characterImages.raft;
    
    // 画像の存在チェック（未完成の画像がある場合はラフトにフォールバック）
    const fallbackImages = characterImages.raft;
    return {
      idle: images.idle.complete && images.idle.naturalWidth > 0 ? images.idle : fallbackImages.idle,
      run1: images.run1.complete && images.run1.naturalWidth > 0 ? images.run1 : fallbackImages.run1,
      run2: images.run2.complete && images.run2.naturalWidth > 0 ? images.run2 : fallbackImages.run2,
      jump1: images.jump1.complete && images.jump1.naturalWidth > 0 ? images.jump1 : fallbackImages.jump1,
      jump2: images.jump2.complete && images.jump2.naturalWidth > 0 ? images.jump2 : fallbackImages.jump2
    };
  }
  
  update(moving, jumping) {
    const now = performance.now();
    if (moving && now - this.timer > 100) {
      this.frame++;
      this.timer = now;
    }
    if (jumping && !this.lastJumping) {
      this.justJumped = true;
      this.jumpFrameStart = now;
    }
    if (!jumping) this.justJumped = false;
    this.lastJumping = jumping;
  }
  
  draw(ctx, x, y, width, height, moving, flip, jumping) {
    const images = this.getCharacterImages();
    let img;
    const now = performance.now();
    
    if (this.justJumped) {
      const elapsed = now - this.jumpFrameStart;
      if (elapsed < 100) img = images.jump1;
      else if (elapsed < 200) img = images.jump2;
      else this.justJumped = false;
    }
    
    if (!img) {
      if (jumping) {
        const centerX = x + width / 2;
        const bottomY = y + height;
        const nearGround =
          getTile(centerX, bottomY + 1) !== 0 ||
          getTile(centerX, bottomY + 32) !== 0;
        img = nearGround ? images.jump1 : images.jump2;
      } else if (moving) {
        img = this.frame % 2 === 0 ? images.run1 : images.run2;
      } else {
        img = images.idle;
      }
    }
    
    ctx.save();
    // 画像28x28, 判定22x28, 横方向オフセット3px, 縦方向オフセット0px
    const offsetX = 3;
    const offsetY = 0;
    if (flip) {
      const translatedX = alignToPixel(x + width + offsetX);
      const translatedY = alignToPixel(y + offsetY);
      ctx.translate(translatedX, translatedY);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, 28, 28);
    } else {
      const drawX = alignToPixel(x - offsetX);
      const drawY = alignToPixel(y - offsetY);
      ctx.drawImage(img, drawX, drawY, 28, 28);
    }
    ctx.restore();
  }
}
const animator = new PlayerAnimator();

const keys = Object.create(null);

function alignToPixel(value) {
  const scale = (window.dynamicScale || SCALE || 1) * (window.renderPixelRatio || 1);
  return Math.round(value * scale) / scale;
}

function getBaseCanvasWidth() {
  return window.baseCanvasWidth || baseCanvasWidth;
}

function getBaseCanvasHeight() {
  return window.baseCanvasHeight || baseCanvasHeight;
}

function getRenderPixelRatio() {
  return window.renderPixelRatio || 1;
}

function logicalToRender(value) {
  return value * getRenderPixelRatio();
}

const messageElement = typeof document !== 'undefined' ? document.getElementById("message") : null;
let messageTimerId = null;

function showPerformanceMessage(text, duration = 2000) {
  if (!messageElement) return;
  messageElement.textContent = text;
  messageElement.style.display = "block";
  if (messageTimerId) {
    clearTimeout(messageTimerId);
  }
  messageTimerId = setTimeout(() => {
    messageElement.style.display = "none";
    messageTimerId = null;
  }, duration);
}

const QUALITY_LEVELS = [1, 0.85, 0.7, 0.55, 0.4];
const QUALITY_LABELS = ["最高", "高", "中", "低", "最小"];
let qualityIndex = 0;
const frameDurations = [];
let lastFrameTimestamp = typeof performance !== 'undefined' ? performance.now() : 0;
function applyRenderQuality(index, options = {}) {
  if (!canvas) return;
  const boundedIndex = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, index));
  const force = !!options.force;
  const nextRatio = QUALITY_LEVELS[boundedIndex];
  if (!force && boundedIndex === qualityIndex && Math.abs((window.renderPixelRatio || 1) - nextRatio) < 0.0001) {
    return;
  }
  qualityIndex = boundedIndex;
  window.renderPixelRatio = nextRatio;
  const targetWidth = Math.max(1, Math.round(getBaseCanvasWidth() * nextRatio));
  const targetHeight = Math.max(1, Math.round(getBaseCanvasHeight() * nextRatio));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    window.ctx = ctx;
  }
  canvas.style.width = `${getBaseCanvasWidth()}px`;
  canvas.style.height = `${getBaseCanvasHeight()}px`;
  if (options.notify) {
    const label = QUALITY_LABELS[qualityIndex];
    const suffix = options.reason ? ` (${options.reason})` : '';
    showPerformanceMessage(`描画品質: ${label}${suffix}`);
  }
  if (options.resetHistory) {
    frameDurations.length = 0;
  }
}

if (canvas && ctx) {
  applyRenderQuality(qualityIndex, { force: true });
}

function monitorPerformance(deltaMs) {
  if (!canvas || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
  if (deltaMs > 200) {
    frameDurations.length = 0;
    return;
  }
  frameDurations.push(deltaMs);
  if (frameDurations.length > 90) frameDurations.shift();

  if (window.debugMode && frameDurations.length >= 24) {
    let sum = 0;
    let worst = 0;
    for (let i = 0; i < frameDurations.length; i++) {
      const v = frameDurations[i];
      sum += v;
      if (v > worst) worst = v;
    }
    const avg = sum / frameDurations.length;
    debugLog('fps monitor', { avg, worst, samples: frameDurations.length });
  }
}

function syncCanvasContext(element, options = {}) {
  if (!element) return;
  const context = element.getContext("2d");
  if (!context) return;
  canvas = element;
  ctx = context;
  const attrWidth = Number(element.getAttribute && element.getAttribute("width"));
  const attrHeight = Number(element.getAttribute && element.getAttribute("height"));
  if (!window.baseCanvasWidth) {
    if (Number.isFinite(attrWidth) && attrWidth > 0) {
      baseCanvasWidth = attrWidth;
    } else if (element.width > 0) {
      baseCanvasWidth = element.width;
    }
    window.baseCanvasWidth = baseCanvasWidth;
  } else {
    baseCanvasWidth = window.baseCanvasWidth;
  }
  if (!window.baseCanvasHeight) {
    if (Number.isFinite(attrHeight) && attrHeight > 0) {
      baseCanvasHeight = attrHeight;
    } else if (element.height > 0) {
      baseCanvasHeight = element.height;
    }
    window.baseCanvasHeight = baseCanvasHeight;
  } else {
    baseCanvasHeight = window.baseCanvasHeight;
  }
  ctx.imageSmoothingEnabled = false;
  window.canvas = canvas;
  window.ctx = ctx;
  if (options.setStyle !== false) {
    canvas.style.width = `${getBaseCanvasWidth()}px`;
    canvas.style.height = `${getBaseCanvasHeight()}px`;
  }
  if (typeof window.renderPixelRatio === 'undefined') {
    window.renderPixelRatio = 1;
  }
  if (typeof window.showCollisionBoxes === 'undefined') {
    window.showCollisionBoxes = false;
  }
  if (options.forceQuality) {
    applyRenderQuality(qualityIndex, { force: true, resetHistory: true });
  }
}

if (canvas && ctx) {
  syncCanvasContext(canvas, { forceQuality: true });
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    syncCanvasContext(document.getElementById("gameCanvas"), { forceQuality: true });
  });
}
if (typeof window !== 'undefined') {
  window.attachGameCanvas = function attachGameCanvas(element) {
    syncCanvasContext(element, { forceQuality: true });
  };
}

function setKeyState(rawKey, isDown) {
  if (typeof rawKey !== 'string') return;
  keys[rawKey] = isDown;
  if (rawKey.length === 1) {
    const lower = rawKey.toLowerCase();
    const upper = rawKey.toUpperCase();
    keys[lower] = isDown;
    keys[upper] = isDown;
    return;
  }
  const lower = rawKey.toLowerCase();
  const upper = rawKey.toUpperCase();
  if (lower !== rawKey) keys[lower] = isDown;
  if (upper !== rawKey) keys[upper] = isDown;
}

function isKeyActive(keyName) {
  if (!keyName) return false;
  if (keyName.length === 1) {
    return !!(keys[keyName] || keys[keyName.toLowerCase()] || keys[keyName.toUpperCase()]);
  }
  const lower = keyName.toLowerCase();
  const upper = keyName.toUpperCase();
  return !!(keys[keyName] || keys[lower] || keys[upper]);
}
let cameraX = 0, cameraY = 0;
let prevCameraX = 0, prevCameraY = 0;
let facingLeft = false;
let isMoving = false;
let isDead = false, deathStartTime = 0, useFallDeathScreen = false, showDeathScreen = false;
let cameraLockX = 0, cameraLockY = 0;
let deathFrozen = false;
let scoa = 0;

// 動く敵（アニメタイマー付き）
let enemyObjs = [];
function initEnemies() {
  enemyObjs = [];
  for (let row = 0; row < map.length; row++) {
    for (let col = 0; col < map[0].length; col++) {
      if (map[row][col] === 9) {
        // エディターで保存された向きを使う
        let dir = 1;
        if (window.enemyDirs && window.enemyDirs[`${row},${col}`] !== undefined) {
          dir = window.enemyDirs[`${row},${col}`];
        }
        enemyObjs.push({
          x: col * TILE_SIZE,
          y: row * TILE_SIZE,
          vy: 0,
          dir: dir,
          speed: 1.5,
          animTimer: Math.floor(Math.random() * 60),
          originalRow: row,  // 元の配置位置を記録
          originalCol: col
        });
        map[row][col] = 0;
      }
    }
  }
}
initEnemies();

function updateEnemies() {
  if (!enemyObjs || !Array.isArray(enemyObjs)) {
    debugWarn("updateEnemies: enemyObjsが無効です");
    return;
  }
  
  for (const enemy of enemyObjs) {
    if (!enemy) continue;
    
    // 重力を追加
    enemy.vy += 0.5; // 重力
    enemy.y += enemy.vy;
    
    // 地面との衝突判定（より正確に）
    const enemyBottom = enemy.y + TILE_SIZE;
    const enemyCol = Math.floor(enemy.x / TILE_SIZE);
    const enemyRow = Math.floor(enemyBottom / TILE_SIZE);
    
    // 足元のタイルをチェック
    let onGround = false;
    if (enemyRow >= 0 && enemyRow < map.length && enemyCol >= 0 && enemyCol < map[0].length) {
      const tileBelow = map[enemyRow][enemyCol];
      // 地面として機能するタイル（色ブロック20-30も含む）
      if (tileBelow === 1 || tileBelow === 2 || tileBelow === 5 || tileBelow === 11 || tileBelow === 3 || tileBelow === 6 || tileBelow === 12 || tileBelow === 13 || tileBelow === 14 || 
          (tileBelow >= 20 && tileBelow <= 30)) {
        onGround = true;
      }
    }
    
    // 地面に着地
    if (onGround && enemy.vy > 0) {
      enemy.y = enemyRow * TILE_SIZE - TILE_SIZE;
      enemy.vy = 0;
    }
    
    // 水平移動
    enemy.x += enemy.speed * enemy.dir;
    enemy.animTimer = (enemy.animTimer || 0) + 1;
    
    // 足元と正面で折返し
    const aheadX = enemy.x + (enemy.dir > 0 ? TILE_SIZE : -2);
    const footY = enemy.y + TILE_SIZE;
    const tileAhead = getTile(aheadX, enemy.y);
    const tileBelowAhead = getTile(aheadX, footY);
    
    // より自然な折返し判定
    if (
      tileBelowAhead === 0 || // 足元が空
      tileAhead === 1 || tileAhead === 2 || tileAhead === 5 || tileAhead === 3 || tileAhead === 6 || // 正面にブロック
      (tileAhead >= 20 && tileAhead <= 30) || // 正面に色ブロック
      enemy.x <= 0 || enemy.x + TILE_SIZE >= map[0].length * TILE_SIZE // マップ端
    ) {
      enemy.dir *= -1;
      enemy.x += enemy.speed * enemy.dir;
    }
  }
}

function drawEnemies() {
  if (!enemyObjs || !Array.isArray(enemyObjs)) {
    debugWarn("drawEnemies: enemyObjsが無効です");
    return;
  }

  const scale = window.dynamicScale || 1;
  const viewWidth = getBaseCanvasWidth() / scale;
  const viewHeight = getBaseCanvasHeight() / scale;
  const margin = TILE_SIZE;
  const viewLeft = cameraX - margin;
  const viewRight = cameraX + viewWidth + margin;
  const viewTop = cameraY - margin;
  const viewBottom = cameraY + viewHeight + margin;

  for (const enemy of enemyObjs) {
    if (!enemy) continue;
    const ex = enemy.x;
    const ey = enemy.y;
    if (ex + TILE_SIZE < viewLeft || ex > viewRight || ey + TILE_SIZE < viewTop || ey > viewBottom) {
      continue;
    }

    const frame = Math.floor((enemy.animTimer || 0) / 10) % 2;
    const img = frame === 0 ? enemyMoveImg1 : enemyMoveImg2;
    ctx.drawImage(img, ex, ey, TILE_SIZE, TILE_SIZE);
  }
}

const deathGifEl = document.getElementById("deathGif");

// タイル取得
function getTile(x, y) {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  if (row < 0 || row >= map.length || col < 0 || col >= map[0].length) return 0;
  return map[row][col];
}

// 当たり判定チェック
function isSolidTile(tile) {
  return tile !== 0 && tile !== 3 && tile !== 4 && tile !== 6 && tile !== 7 && tile !== 8 && tile !== 10 &&
    tile !== 12 && tile !== 13 && tile !== 14 && tile !== 15 && tile !== 16 && tile !== 17 && tile !== 19;
}

function checkCollision(x, y, width, height) {
  const left = Math.floor(x / TILE_SIZE);
  const right = Math.floor((x + width - 1) / TILE_SIZE);
  const top = Math.floor(y / TILE_SIZE);
  const bottom = Math.floor((y + height - 1) / TILE_SIZE);
  
  for (let row = top; row <= bottom; row++) {
    for (let col = left; col <= right; col++) {
      if (row >= 0 && row < map.length && col >= 0 && col < map[0].length) {
        const tile = map[row][col];
        
        // 毒タイルの場合は当たり判定なし（完全にすり抜け可能）
        if (tile === 6) {
          continue; // 毒タイルの場合は判定をスキップ
        }
        
        if (isSolidTile(tile)) {
          return true;
        }
      }
    }
  }
  return false;
}

// チェックポイント管理
if (!window.checkpoints) window.checkpoints = [];
if (!window.lastCheckpointPos) window.lastCheckpointPos = {x: -1, y: -1};

// 死亡処理（death.gifも）
function diePlayer(reason) {
  if (window.debugMode) {
    debugLog("死亡処理呼び出し:", reason);
  }
  isDead = true;
  deathStartTime = performance.now();
  cameraLockX = cameraX;
  cameraLockY = cameraY;

  // death.gif画面全体表示
  deathGifEl.style.display = "block";
  setTimeout(() => {
    deathGifEl.style.display = "none";
  }, 1000);

  // respawnPointからリスポーン（チェックポイントで更新済み）
  if (window.debugMode) {
    debugLog("リスポーン位置:", respawnPoint.x, respawnPoint.y);
  }
  player.x = respawnPoint.x;
  player.y = respawnPoint.y;
  player.vx = 0; player.vy = 0; player.onGround = false;
  // 軌道計算をリセット
  player.isInTrampolineTrajectory = false;
  player.trajectoryStartTime = 0;
  player.initialTrajectoryVx = 0;
  player.initialTrajectoryVy = 0;
  player.predictedLanding = null;
  snapPlayerToGroundBelow();
  // 動く敵の状態をリセット
  player.isOnMovingEnemy = false;
  player.currentEnemy = null;
  for (let key in keys) keys[key] = false;
  deathFrozen = true;
}

// プレイヤー初期化時
const spawn = findSpawn();
player.x = spawn.x;
player.y = spawn.y; // スポーン地点に直接配置
respawnPoint.x = spawn.x;
respawnPoint.y = spawn.y; // リスポーン位置も調整
player.isInTrampolineTrajectory = false;
player.predictedLanding = null;
player.initialTrajectoryVx = 0;
player.initialTrajectoryVy = 0;
player.vx = 0;
player.vy = 0;
snapPlayerToGroundBelow();

  // デバッグ用：プレイヤー位置の確認
  if (window.debugMode) {
    debugLog("プレイヤー初期位置:", player.x, player.y);
    debugLog("スポーン位置:", spawn.x, spawn.y);
  }

  // プレイヤー周辺のタイル情報を確認（デバッグモード時のみ）
  if (window.debugMode) {
    const playerCol = Math.floor(player.x / TILE_SIZE);
    const playerRow = Math.floor(player.y / TILE_SIZE);
    debugLog("プレイヤー周辺タイル:");
    for (let r = playerRow - 1; r <= playerRow + 2; r++) {
      let rowInfo = "";
      for (let c = playerCol - 1; c <= playerCol + 2; c++) {
        if (r >= 0 && r < map.length && c >= 0 && c < map[0].length) {
          const tile = map[r][c];
          const isDummy = tile === 19;
          const overlay = isDummy && window.dummyOverlays ? window.dummyOverlays[`${r},${c}`] : null;
          rowInfo += `[${tile}${overlay ? `(${overlay})` : ''}]`;
        } else {
          rowInfo += "[X]";
        }
      }
      debugLog(`行${r}: ${rowInfo}`);
    }
  }

// イベント登録
document.addEventListener("keydown", (e) => {
  // フルスクリーン切り替え（fキー）
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    if (!document.fullscreenElement) {
      if (canvas && canvas.requestFullscreen) canvas.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  }

  // トランポリン軌道表示切り替え（vキー）
  if (e.key === 'v' || e.key === 'V') {
    e.preventDefault();
    window.showTrampolineTrajectory = !window.showTrampolineTrajectory;
  }
// vキーでトランポリン軌道表示を切り替え
  setKeyState(e.key, true);
  
  if ((e.key === '-' || e.key === '_') && !e.repeat) {
    e.preventDefault();
    window.showCollisionBoxes = !window.showCollisionBoxes;
    showPerformanceMessage(`当たり判定表示: ${window.showCollisionBoxes ? 'ON' : 'OFF'}`, 1500);
    if (typeof window.draw === 'function') {
      try {
        window.draw();
      } catch (err) {
        console.error(err);
      }
    }
  }
  
  // デバッグモード切り替え（F12キー or bキー）
  if (e.key === 'F12' || e.key === 'b' || e.key === 'B') {
    e.preventDefault();
    window.debugMode = !window.debugMode;
    debugLog('デバッグモード:', window.debugMode ? 'ON' : 'OFF');
  }
});
document.addEventListener("keyup", (e) => setKeyState(e.key, false));

// カメラズーム制御用変数
if (typeof window.dynamicScale === 'undefined') window.dynamicScale = SCALE;
let targetScale = SCALE;

// 設定の読み込み
function loadGameSettings() {
  const settings = JSON.parse(localStorage.getItem('gameSettings') || '{}');
  const keySettings = JSON.parse(localStorage.getItem('keySettings') || '{}');
  
  const defaults = {
    cameraSpeed: 0.1,
    zoom: 2.0,
    difficulty: 'normal',
    character: 'raft',
    renderQuality: QUALITY_LEVELS[0]
  };
  
  // デフォルトキー設定
  const defaultKeys = {
    left: 'a',
    right: 'd',
    jump: ' ',
    ladderUp: 'w',
    down: 's',
    stop: 'Shift',
    editorLeft: 'a',
    editorRight: 'd',
    editorUp: 'w',
    editorDown: 's'
  };
  
  // カメラ追従速度
  window.cameraSpeed = settings.cameraSpeed !== undefined ? parseFloat(settings.cameraSpeed) : defaults.cameraSpeed;
  
  // ズーム倍率（設定値をそのまま使用）
  window.dynamicScale = settings.zoom !== undefined ? parseFloat(settings.zoom) : defaults.zoom;
  targetScale = window.dynamicScale;
  
  // 描画品質
  let qualityValue = settings.renderQuality !== undefined ? parseFloat(settings.renderQuality) : defaults.renderQuality;
  if (!Number.isFinite(qualityValue)) qualityValue = defaults.renderQuality;
  let qualitySettingIndex = QUALITY_LEVELS.findIndex(v => Math.abs(v - qualityValue) < 0.0001);
  if (qualitySettingIndex === -1) qualitySettingIndex = 0;
  applyRenderQuality(qualitySettingIndex, { force: true, resetHistory: true });
  window.renderQualitySetting = QUALITY_LEVELS[qualitySettingIndex];
  
  // 難易度設定
  window.gameDifficulty = settings.difficulty || defaults.difficulty;
  
  // キャラクター設定
  const selectedCharacter = settings.character || defaults.character;
  applyCharacterTraits(selectedCharacter);
  if (animator) {
    animator.setCharacter(selectedCharacter);
  }
  
  // キー設定
  window.gameKeys = {};
  Object.keys(defaultKeys).forEach(key => {
    if (key === 'ladderUp' && keySettings[key] === undefined && keySettings.up !== undefined) {
      window.gameKeys[key] = keySettings.up;
    } else {
      window.gameKeys[key] = keySettings[key] || defaultKeys[key];
    }
  });
  
  if (window.debugMode) {
    debugLog('設定読み込み完了:', { 
      cameraSpeed: window.cameraSpeed, 
      zoom: window.dynamicScale, 
      difficulty: window.gameDifficulty,
      renderQuality: window.renderQualitySetting,
      character: selectedCharacter,
      keys: window.gameKeys
    });
  }
}
loadGameSettings();

// 設定変更時のリアルタイム反映
window.addEventListener('storage', (e) => {
  if (e.key === 'gameSettings' || e.key === 'keySettings') {
    if (window.debugMode) {
      debugLog('設定が変更されました');
    }
    loadGameSettings();
  }
});

// --- デフォルトの敵当たり判定・死亡判定設定 ---
window.defaultEnemyProps = {
  hitTop: true,
  hitSide: true,
  hitBottom: true,
  deathTop: false,
  deathSide: false,
  deathBottom: false
};

function isPlayerOnLadder() {
  const centerX = player.x + player.width / 2;
  const centerY = player.y + player.height / 2;
  const footY = player.y + player.height - 1;
  const centerTile = getTile(centerX, centerY);
  const footTile = getTile(centerX, footY);
  return centerTile === 8 || footTile === 8;
}

// メイン更新
function update() {
  player.vx = 0; isMoving = false;
  player.speed = player.baseSpeed;
  const wasOnGround = player.onGround;
  
  const stopKey = window.gameKeys?.stop || 'Shift';
  const shiftPressed = isKeyActive(stopKey);
  
  // キー設定を使用した左右移動
  const leftKey = window.gameKeys?.left || 'a';
  const rightKey = window.gameKeys?.right || 'd';
  
  if (isKeyActive(leftKey) || isKeyActive("ArrowLeft")) { 
    player.vx = -player.speed; 
    facingLeft = true; 
    isMoving = true; 
  }
  if (isKeyActive(rightKey) || isKeyActive("ArrowRight")) { 
    player.vx = player.speed; 
    facingLeft = false; 
    isMoving = true; 
  }

  if (window.currentCharacter === 'tanutsuna' && shiftPressed && !isPlayerOnLadder()) {
    const dashSpeed = player.baseSpeed * (player.dashMultiplier || 1);
    if (player.vx > 0) {
      player.vx = dashSpeed;
    } else if (player.vx < 0) {
      player.vx = -dashSpeed;
    }
  }

  // 敵移動（先に敵を移動させる）
  updateEnemies();

  const effectiveCanvas = window.canvas || canvas;
  const scale = window.dynamicScale || 1;
  const viewportWidth = effectiveCanvas ? getBaseCanvasWidth() / scale : TILE_SIZE * 32;
  const viewportHeight = effectiveCanvas ? getBaseCanvasHeight() / scale : TILE_SIZE * 20;
  const enemyCullHalfWidth = viewportWidth * 0.75 + TILE_SIZE;
  const enemyCullHalfHeight = viewportHeight * 1.25 + TILE_SIZE;
  const playerMidX = player.x + player.width / 2;
  const playerMidY = player.y + player.height / 2;

  // 動く敵との当たり判定と物理演算（移動前に処理）
  let onEnemyFlag = false;
  let isBeingPushedByEnemy = false; // 敵に押されているかどうかのフラグ
  
  // enemyObjsの存在チェック
  if (!enemyObjs || !Array.isArray(enemyObjs)) {
    enemyObjs = [];
    debugWarn("enemyObjsが初期化されていません。再初期化します。");
  }
  
  for (let i = 0; i < enemyObjs.length; i++) {
    const enemy = enemyObjs[i];
    if (!enemy) {
      debugWarn("無効な敵オブジェクトをスキップします:", i);
      continue;
    }
    const enemyCenterX = enemy.x + TILE_SIZE / 2;
    const enemyCenterY = enemy.y + TILE_SIZE / 2;
    if (Math.abs(enemyCenterX - playerMidX) > enemyCullHalfWidth ||
        Math.abs(enemyCenterY - playerMidY) > enemyCullHalfHeight) {
      continue;
    }
    // --- ここからenemyPropsによる判定 ---
    // 動く敵の元の配置位置を取得（enemyPropsは配置位置で保存されている）
    const originalEnemyCol = enemy.originalCol !== undefined ? enemy.originalCol : Math.floor(enemy.x / TILE_SIZE);
    const originalEnemyRow = enemy.originalRow !== undefined ? enemy.originalRow : Math.floor(enemy.y / TILE_SIZE);
    const key = `${originalEnemyRow},${originalEnemyCol}`;
    const props = (window.enemyProps && window.enemyProps[key]) ? window.enemyProps[key] : window.defaultEnemyProps;
    
    // デバッグ用：敵プロパティの確認
    if (window.debugMode) {
      debugLog('敵プロパティ確認:', {
        key,
        hasCustomProps: !!(window.enemyProps && window.enemyProps[key]),
        customProps: window.enemyProps && window.enemyProps[key],
        defaultProps: window.defaultEnemyProps,
        finalProps: props
      });
    }
    // プレイヤーの各辺
    const px1 = player.x, px2 = player.x + player.width;
    const py1 = player.y, py2 = player.y + player.height;
    const ex1 = enemy.x + window.ENEMY_HITBOX.offset, ex2 = enemy.x + window.ENEMY_HITBOX.offset + window.ENEMY_HITBOX.size;
    const ey1 = enemy.y + window.ENEMY_HITBOX.offset, ey2 = enemy.y + window.ENEMY_HITBOX.offset + window.ENEMY_HITBOX.size;
    // --- 死亡判定用の判定（狭め） ---
    const isTopDeath = px2 > ex1 && px1 < ex2 && Math.abs(py2 - ey1) < 4 && player.vy >= 0;
    const isBottomDeath = px2 > ex1 && px1 < ex2 && Math.abs(py1 - ey2) < 4 && player.vy < 0;
    const isSideDeath = py2 > ey1 + 6 && py1 < ey2 - 6 && (Math.abs(px2 - ex1) < 3 || Math.abs(px1 - ex2) < 3);
    // --- 当たり判定用の判定（プレイヤーが敵に重ならないように広い範囲） ---
    const isTopHit = px2 > ex1 && px1 < ex2 && Math.abs(py2 - ey1) >= 4 && Math.abs(py2 - ey1) < 16 && player.vy >= 0;
    const isBottomHit = px2 > ex1 && px1 < ex2 && Math.abs(py1 - ey2) >= 4 && Math.abs(py1 - ey2) < 16 && player.vy < 0;
    const isSideHit = py2 > ey1 + 2 && py1 < ey2 - 2 && (Math.abs(px2 - ex1) >= 0 && Math.abs(px2 - ex1) < 16 || Math.abs(px1 - ex2) >= 0 && Math.abs(px1 - ex2) < 16);
    
    // 衝突判定の詳細をログ出力
    if (isTopDeath || isBottomDeath || isSideDeath || isTopHit || isBottomHit || isSideHit) {
      if (window.debugMode) {
        debugLog('敵判定DEBUG詳細:', {
          key, 
          props, 
          hasCustomProps: !!(window.enemyProps && window.enemyProps[key]),
          playerPos: {x: player.x, y: player.y, vx: player.vx, vy: player.vy},
          enemyPos: {x: enemy.x, y: enemy.y, dir: enemy.dir},
          collision: {
            isTopDeath, isBottomDeath, isSideDeath,
            isTopHit, isBottomHit, isSideHit,
            px1, px2, py1, py2, ex1, ex2, ey1, ey2
          }
        });
      }
    }

    // --- 死亡判定（赤ボタンは必ず死亡） ---
    // 死亡判定がONの場合は必ず死亡
    if (
      (isTopDeath && props.deathTop) ||
      (isBottomDeath && props.deathBottom) ||
      (isSideDeath && props.deathSide)
    ) {
      if (window.debugMode) {
        debugLog('動く敵死亡判定実行（赤ボタン）:', {
          isTopDeath, isBottomDeath, isSideDeath, 
          propsDeathTop: props.deathTop, propsDeathBottom: props.deathBottom, propsDeathSide: props.deathSide,
          willDie: true
        });
      }
      if (!isDead) {
        diePlayer("enemyMove");
      }
      continue; // 死亡判定が成立したら他の判定はスキップ
    }
    
    // デバッグ用：死亡判定の詳細をログ出力
    if (isTopDeath || isBottomDeath || isSideDeath) {
      if (window.debugMode) {
        debugLog('死亡判定詳細:', {
          isTopDeath, isBottomDeath, isSideDeath,
          propsDeathTop: props.deathTop,
          propsDeathBottom: props.deathBottom,
          propsDeathSide: props.deathSide,
          willDie: (isTopDeath && props.deathTop) || (isBottomDeath && props.deathBottom) || (isSideDeath && props.deathSide)
        });
      }
    }
    
    // --- 当たり判定（死亡判定が成立しなかった場合のみ）---
    if (isTopHit && props.hitTop) {
      if (window.debugMode) {
        debugLog('上からの当たり判定実行:', {isTopHit, props});
      }
      onEnemyFlag = true;
      
      // プレイヤーを敵の上に配置
      player.y = enemy.y - player.height;
      player.vy = 0;
      player.onGround = true;
      
      // 動く敵の上に乗っている状態を設定
      player.isOnMovingEnemy = true;
      player.currentEnemy = enemy;
      
      // 敵の移動に合わせてプレイヤーも移動（物理演算ベース）
      const enemyVelocity = enemy.speed * enemy.dir;
      
      // プレイヤーを敵の進行方向に移動させる
      if (Math.abs(enemyVelocity) > 0.1) {
        // 敵が動いている場合、プレイヤーも同じ方向に移動
        player.x += enemyVelocity;
        
        // プレイヤーの速度も敵の速度に合わせる（慣性を考慮）
        const targetVelocity = enemyVelocity;
        const acceleration = 0.2; // 加速度を少し上げてより自然に
        const velocityDiff = targetVelocity - player.vx;
        player.vx += velocityDiff * acceleration;
        
        if (window.debugMode) {
          debugLog('敵に乗って移動（進行方向）:', {
            enemyVelocity,
            playerVx: player.vx,
            targetVelocity,
            velocityDiff,
            acceleration
          });
        }
      } else {
        // 敵が止まっている場合、プレイヤーの速度を徐々に減衰
        player.vx *= 0.95;
      }
      
      continue;
    }
    // --- 横方向の当たり判定（狭い当たり判定による押し出し）---
    if (isSideHit && props.hitSide) {
      if (window.debugMode) {
        debugLog('横方向の当たり判定実行:', {isSideHit, props, enemyDir: enemy.dir, playerVx: player.vx});
      }
      
      // 押し出し用の狭い当たり判定を使用
      const enemyHitboxLeft = enemy.x + window.ENEMY_PUSH_HITBOX.offset;
      const enemyHitboxRight = enemy.x + window.ENEMY_PUSH_HITBOX.offset + window.ENEMY_PUSH_HITBOX.size;
      const enemyHitboxTop = enemy.y + window.ENEMY_PUSH_HITBOX.offset;
      const enemyHitboxBottom = enemy.y + window.ENEMY_PUSH_HITBOX.offset + window.ENEMY_PUSH_HITBOX.size;
      
      // プレイヤーが敵の右面に触れているか左面に触れているかを判定
      const playerRightEdge = player.x + player.width;
      const playerLeftEdge = player.x;
      
      // プレイヤーの右端が敵の左端に近い場合 → 左面接触
      // プレイヤーの左端が敵の右端に近い場合 → 右面接触
      const distanceToEnemyLeft = Math.abs(playerRightEdge - enemyHitboxLeft);
      const distanceToEnemyRight = Math.abs(playerLeftEdge - enemyHitboxRight);
      
      const isPlayerOnRightSide = distanceToEnemyRight < distanceToEnemyLeft;
      
      // プレイヤーが敵の1×1当たり判定に重なっている場合の処理
      const isOverlapping = px2 > enemyHitboxLeft && px1 < enemyHitboxRight;
      
      if (isOverlapping) {
        // 重なっている場合は強制的に押し出す
        isBeingPushedByEnemy = true; // 押されているフラグを設定
        if (isPlayerOnRightSide) {
          // プレイヤーが敵の右側にいる → 右に押し出す
          player.x = enemyHitboxRight;
          player.vx = Math.max(player.vx, Math.abs(enemy.speed) + 2.0);
          if (window.debugMode) {
            debugLog('重なり検出、右方向強制押し出し（狭い判定）:', {
              playerPos: {x: player.x, y: player.y},
              enemyPos: {x: enemy.x, y: enemy.y},
              enemyHitbox: {left: enemyHitboxLeft, right: enemyHitboxRight},
              overlap: {px1, px2, enemyLeft: enemyHitboxLeft, enemyRight: enemyHitboxRight}
            });
          }
        } else {
          // プレイヤーが敵の左側にいる → 左に押し出す
          player.x = enemyHitboxLeft - player.width;
          player.vx = Math.min(player.vx, -(Math.abs(enemy.speed) + 2.0));
          if (window.debugMode) {
            debugLog('重なり検出、左方向強制押し出し（狭い判定）:', {
              playerPos: {x: player.x, y: player.y},
              enemyPos: {x: enemy.x, y: enemy.y},
              enemyHitbox: {left: enemyHitboxLeft, right: enemyHitboxRight},
              overlap: {px1, px2, enemyLeft: enemyHitboxLeft, enemyRight: enemyHitboxRight}
            });
          }
        }
      } else {
        // 通常の押し出し処理
        isBeingPushedByEnemy = true; // 押されているフラグを設定
        if (isPlayerOnRightSide) {
          // プレイヤーが敵の右面に触れている → 右に押し出す
          const pushForce = Math.abs(enemy.speed) + 1.0;
          player.vx = Math.max(player.vx, pushForce);
          if (window.debugMode) {
            debugLog('右面接触、右方向押し出し（狭い判定）:', {
              oldVx: player.vx, 
              newVx: player.vx, 
              pushForce, 
              distances: {toEnemyLeft: distanceToEnemyLeft, toEnemyRight: distanceToEnemyRight},
              enemyHitbox: {left: enemyHitboxLeft, right: enemyHitboxRight}
            });
          }
        } else {
          // プレイヤーが敵の左面に触れている → 左に押し出す
          const pushForce = -(Math.abs(enemy.speed) + 1.0);
          player.vx = Math.min(player.vx, pushForce);
          if (window.debugMode) {
            debugLog('左面接触、左方向押し出し（狭い判定）:', {
              oldVx: player.vx, 
              newVx: player.vx, 
              pushForce, 
              distances: {toEnemyLeft: distanceToEnemyLeft, toEnemyRight: distanceToEnemyRight},
              enemyHitbox: {left: enemyHitboxLeft, right: enemyHitboxRight}
            });
          }
        }
      }
      continue;
    }
    // --- 下からの当たり判定（敵を押し上げる）---
    if (isBottomHit && props.hitBottom) {
      if (window.debugMode) {
        debugLog('下からの当たり判定実行:', {isBottomHit, props});
      }
      // プレイヤーが敵の下から当たった場合、敵を押し上げる
      enemy.y = player.y + player.height;
      continue;
    }
  }
  
  // 動く敵の上から離れた時の処理
  if (player.isOnMovingEnemy && !onEnemyFlag) {
    if (window.debugMode) {
      debugLog('動く敵の上から離れました');
    }
    player.isOnMovingEnemy = false;
    player.currentEnemy = null;
    // 離れた時の慣性を保持（少しずつ減衰）
    player.vx *= 0.8;
  }

  // 移動・落下（敵との当たり判定処理後）
  const nextX = player.x + player.vx;
  const collisionX = checkCollision(nextX, player.y, player.width, player.height);

  // 敵とのブロックとしての当たり判定
  let enemyCollisionX = false;
  if (!collisionX && enemyObjs && Array.isArray(enemyObjs)) {
    for (const enemy of enemyObjs) {
      if (!enemy) continue;

      const originalEnemyCol = enemy.originalCol !== undefined ? enemy.originalCol : Math.floor(enemy.x / TILE_SIZE);
      const originalEnemyRow = enemy.originalRow !== undefined ? enemy.originalRow : Math.floor(enemy.y / TILE_SIZE);
      const key = `${originalEnemyRow},${originalEnemyCol}`;
      const props = (window.enemyProps && window.enemyProps[key]) ? window.enemyProps[key] : window.defaultEnemyProps;
      if (!props.hitSide) {
        continue;
      }

      const enemyHitboxLeft = enemy.x + window.ENEMY_HITBOX.offset;
      const enemyHitboxRight = enemy.x + window.ENEMY_HITBOX.offset + window.ENEMY_HITBOX.size;
      const enemyHitboxTop = enemy.y + window.ENEMY_HITBOX.offset;
      const enemyHitboxBottom = enemy.y + window.ENEMY_HITBOX.offset + window.ENEMY_HITBOX.size;

      const px1 = nextX, px2 = nextX + player.width;
      const py1 = player.y, py2 = player.y + player.height;

      if (py2 > enemyHitboxTop + 4 && py1 < enemyHitboxBottom - 4) {
        if (player.vx > 0 && px2 > enemyHitboxLeft && px1 < enemyHitboxRight) {
          enemyCollisionX = true;
          player.x = enemyHitboxLeft - player.width;
          if (window.debugMode) {
            debugLog('右方向ブロック当たり判定（1×1判定）:', {props, enemyPos: {x: enemy.x, y: enemy.y}, enemyHitbox: {left: enemyHitboxLeft, right: enemyHitboxRight}});
          }
          break;
        } else if (player.vx < 0 && px2 > enemyHitboxLeft && px1 < enemyHitboxRight) {
          enemyCollisionX = true;
          player.x = enemyHitboxRight;
          if (window.debugMode) {
            debugLog('左方向ブロック当たり判定（1×1判定）:', {props, enemyPos: {x: enemy.x, y: enemy.y}, enemyHitbox: {left: enemyHitboxLeft, right: enemyHitboxRight}});
          }
          break;
        }
      }
    }
  }

  if (!collisionX && !enemyCollisionX) {
    player.x = nextX;
  } else {
    if (player.isInTrampolineTrajectory) {
      player.isInTrampolineTrajectory = false;
      if (player.predictedLanding) {
        player.predictedLanding = null;
        player.initialTrajectoryVx = 0;
        player.initialTrajectoryVy = 0;
      }
      if (window.debugMode) {
        debugLog(collisionX ? '軌道計算終了: 横方向の壁に衝突' : '軌道計算終了: 横方向の敵に衝突');
      }
    }
    player.vx = 0;
  }

  isBeingPushedByEnemy = false;
// トランポリン軌道計算
  if (player.isInTrampolineTrajectory) {
    const elapsed = performance.now() - player.trajectoryStartTime;
    const timeInSeconds = elapsed / 1000; // ミリ秒を秒に変換
    
    // 放物線軌道計算（重力 + 空気抵抗）
    const gravity = player.gravity;
    const airResistance = player.airResistance;
    
    // 時間に応じた速度計算（空気抵抗を考慮）
    const resistanceFactor = Math.pow(airResistance, timeInSeconds * 60); // 60fpsを想定
    player.vx = player.initialTrajectoryVx * resistanceFactor;
    player.vy = player.initialTrajectoryVy + gravity * timeInSeconds * 60;
    
    // 最大落下速度制限
    if (player.vy > player.maxFallSpeed) {
      player.vy = player.maxFallSpeed;
    }
    
    // 軌道計算の自動終了条件（長時間の軌道計算を防ぐ）
    if (timeInSeconds > 10) { // 10秒以上軌道計算が続く場合は強制終了
      player.isInTrampolineTrajectory = false;
      if (player.predictedLanding) {
        player.predictedLanding = null;
        player.initialTrajectoryVx = 0;
        player.initialTrajectoryVy = 0;
      }
      if (window.debugMode) {
        debugLog('軌道計算終了: 時間制限');
      }
    }
    
    // デバッグ情報
    if (window.debugMode) {
      debugLog(`軌道計算: 時間: ${timeInSeconds.toFixed(2)}s, VX: ${player.vx.toFixed(2)}, VY: ${player.vy.toFixed(2)}`);
    }
  } else {
    // 通常の重力処理
    player.vy += player.gravity;
  }
  
  // プレイヤーの横方向移動
  const nextXPos = player.x + player.vx;
  const collisionXPos = checkCollision(nextXPos, player.y, player.width, player.height);
  
  // 敵との横方向衝突判定も追加
  let enemyCollisionXTrajectory = false;
  if (!collisionXPos && enemyObjs && Array.isArray(enemyObjs)) {
    for (const enemy of enemyObjs) {
      if (!enemy) continue;
      
      // 敵の元の配置位置を取得
      const originalEnemyCol = enemy.originalCol !== undefined ? enemy.originalCol : Math.floor(enemy.x / TILE_SIZE);
      const originalEnemyRow = enemy.originalRow !== undefined ? enemy.originalRow : Math.floor(enemy.y / TILE_SIZE);
      const key = `${originalEnemyRow},${originalEnemyCol}`;
      const props = (window.enemyProps && window.enemyProps[key]) ? window.enemyProps[key] : window.defaultEnemyProps;
      
      // 敵の1×1の当たり判定を使用
      const enemyHitboxLeft = enemy.x + window.ENEMY_HITBOX.offset;
      const enemyHitboxRight = enemy.x + window.ENEMY_HITBOX.offset + window.ENEMY_HITBOX.size;
      const enemyHitboxTop = enemy.y + window.ENEMY_HITBOX.offset;
      const enemyHitboxBottom = enemy.y + window.ENEMY_HITBOX.offset + window.ENEMY_HITBOX.size;
      
      // プレイヤーの次の位置と敵の1×1当たり判定をチェック
      const px1 = nextXPos, px2 = nextXPos + player.width;
      const py1 = player.y, py2 = player.y + player.height;
      
      // 横方向の敵との衝突判定（1×1判定）
      if (py2 > enemyHitboxTop + 4 && py1 < enemyHitboxBottom - 4) {
        if (player.vx > 0 && px2 > enemyHitboxLeft && px1 < enemyHitboxRight && props.hitSide) {
          enemyCollisionXTrajectory = true;
          break;
        } else if (player.vx < 0 && px2 > enemyHitboxLeft && px1 < enemyHitboxRight && props.hitSide) {
          enemyCollisionXTrajectory = true;
          break;
        }
      }
    }
  }
  
  if (!collisionXPos && !enemyCollisionXTrajectory) {
    player.x = nextXPos;
  } else {
    // 壁または敵に当たった時に軌道計算を終了
    if (player.isInTrampolineTrajectory) {
      player.isInTrampolineTrajectory = false;
      if (player.predictedLanding) {
        player.predictedLanding = null;
        player.initialTrajectoryVx = 0;
        player.initialTrajectoryVy = 0;
      }
      if (window.debugMode) {
        if (collisionXPos) {
          debugLog('軌道計算終了: 横方向の壁に衝突');
        } else {
          debugLog('軌道計算終了: 横方向の敵に衝突');
        }
      }
    }
    player.vx = 0;
  }
  
  // トランポリン軌道中の上方向衝突判定を追加
  if (player.isInTrampolineTrajectory && player.vy < 0) {
    const nextYPos = player.y + player.vy;
    const collisionYPos = checkCollision(player.x, nextYPos, player.width, player.height);
    
    // 敵との上方向衝突判定も追加
    let enemyCollisionYTrajectory = false;
    if (!collisionYPos && enemyObjs && Array.isArray(enemyObjs)) {
      for (const enemy of enemyObjs) {
        if (!enemy) continue;
        
        // 敵の元の配置位置を取得
        const originalEnemyCol = enemy.originalCol !== undefined ? enemy.originalCol : Math.floor(enemy.x / TILE_SIZE);
        const originalEnemyRow = enemy.originalRow !== undefined ? enemy.originalRow : Math.floor(enemy.y / TILE_SIZE);
        const key = `${originalEnemyRow},${originalEnemyCol}`;
        const props = (window.enemyProps && window.enemyProps[key]) ? window.enemyProps[key] : window.defaultEnemyProps;
        
        // プレイヤーの次の位置と敵の位置をチェック
        const px1 = player.x, px2 = player.x + player.width;
        const py1 = nextYPos, py2 = nextYPos + player.height;
        const ex1 = enemy.x, ex2 = enemy.x + TILE_SIZE;
        const ey1 = enemy.y, ey2 = enemy.y + TILE_SIZE;
        
        // 上方向の敵との衝突判定
        if (px2 > ex1 + 4 && px1 < ex2 - 4) {
          if (py1 <= ey2 && py2 >= ey2 - 1 && props.hitBottom) {
            enemyCollisionYTrajectory = true;
            break;
          }
        }
      }
    }
    
    if (collisionYPos || enemyCollisionYTrajectory) {
      // 上方向に衝突した場合、軌道計算を終了して通常の重力に戻す
      player.isInTrampolineTrajectory = false;
      player.vy = 0; // 上向きの速度をリセット
      
      if (collisionYPos) {
        player.y = Math.ceil(nextYPos / TILE_SIZE) * TILE_SIZE; // 壁の衝突位置に調整
        if (window.debugMode) {
          debugLog('軌道計算終了: 上方向の壁に衝突');
        }
      } else if (enemyCollisionYTrajectory) {
        // 敵との衝突位置に調整
        for (const enemy of enemyObjs) {
          if (!enemy) continue;
          const ex1 = enemy.x, ex2 = enemy.x + TILE_SIZE;
          const ey1 = enemy.y, ey2 = enemy.y + TILE_SIZE;
          const px1 = player.x, px2 = player.x + player.width;
          
          if (px2 > ex1 + 4 && px1 < ex2 - 4) {
            if (player.y + player.height <= ey2 && player.y + player.height + player.vy >= ey2 - 1) {
              player.y = ey2 - player.height;
              break;
            }
          }
        }
        if (window.debugMode) {
          debugLog('軌道計算終了: 上方向の敵に衝突');
        }
      }
    }
  }
  
  // 梯子停止の処理（梯子を登っている＆停止キーを押している場合）
  const ladderFootX = player.x + player.width / 2;
  const ladderFootY = player.y + player.height + 1;
  const ladderTileBelow = getTile(ladderFootX, ladderFootY);
  if (ladderTileBelow === 8 && shiftPressed) {
    player.vy = 0; // 落下を停止
  }
  
  const nextY = player.y + player.vy;
  const collisionY = checkCollision(player.x, nextY, player.width, player.height);
  
  // 敵との縦方向ブロック当たり判定
  let enemyCollisionY = false;
  if (!collisionY && enemyObjs && Array.isArray(enemyObjs)) {
    for (const enemy of enemyObjs) {
      if (!enemy) continue;
      
      // 敵の元の配置位置を取得
      const originalEnemyCol = enemy.originalCol !== undefined ? enemy.originalCol : Math.floor(enemy.x / TILE_SIZE);
      const originalEnemyRow = enemy.originalRow !== undefined ? enemy.originalRow : Math.floor(enemy.y / TILE_SIZE);
      const key = `${originalEnemyRow},${originalEnemyCol}`;
      const props = (window.enemyProps && window.enemyProps[key]) ? window.enemyProps[key] : window.defaultEnemyProps;
      
      // プレイヤーの次の位置と敵の位置をチェック
      const px1 = player.x, px2 = player.x + player.width;
      const py1 = nextY, py2 = nextY + player.height;
      const ex1 = enemy.x, ex2 = enemy.x + TILE_SIZE;
      const ey1 = enemy.y, ey2 = enemy.y + TILE_SIZE;
      
      // 縦方向のブロック当たり判定
      if (px2 > ex1 + 4 && px1 < ex2 - 4) {
        // 下方向の当たり判定
        if (player.vy > 0 && py2 > ey1 && py1 < ey2) {
          // 当たり判定がOFFの場合はスキップ
          if (!props.hitTop) {
            continue;
          }
          // 下に移動中に敵の上に当たった
          enemyCollisionY = true;
          player.y = ey1 - player.height;
          player.vy = 0;
          player.onGround = true;
          if (window.debugMode) {
            debugLog('下方向ブロック当たり判定（敵の上）:', {props, enemyPos: {x: enemy.x, y: enemy.y}});
          }
          break;
        } else if (player.vy < 0 && py2 > ey1 && py1 < ey2) {
          // 当たり判定がOFFの場合はスキップ
          if (!props.hitBottom) {
            continue;
          }
          // 上に移動中に敵の下に当たった
          enemyCollisionY = true;
          player.y = ey2;
          player.vy = 0;
          if (window.debugMode) {
            debugLog('上方向ブロック当たり判定（敵の下）:', {props, enemyPos: {x: enemy.x, y: enemy.y}});
          }
          break;
        }
      }
    }
  }
  
  if (!collisionY && !enemyCollisionY) {
    const groundCheckX = playerMidX;
    const groundCheckY = nextY + player.height + 0.1;
    const tileBelowNext = getTile(groundCheckX, groundCheckY);
    if (wasOnGround && player.vy <= player.gravity && isSolidTile(tileBelowNext)) {
      const snappedRow = Math.floor(groundCheckY / TILE_SIZE);
      player.y = snappedRow * TILE_SIZE - player.height;
      player.vy = 0;
      player.onGround = true;
    } else {
      player.y = nextY;
      player.onGround = false;
    }
  } else {
    if (player.vy > 0) {
      player.onGround = true;
      if (!snapPlayerToGroundBelow()) {
        player.y = Math.max(0, player.y);
      }
      if (player.isInTrampolineTrajectory) {
        player.isInTrampolineTrajectory = false;
        if (player.predictedLanding) {
          player.predictedLanding = null;
          player.initialTrajectoryVx = 0;
          player.initialTrajectoryVy = 0;
        }
        if (window.debugMode) {
          debugLog('軌道計算終了: 地面に着地');
        }
      }
    } else if (player.vy < 0 && collisionY) {
      const topRow = Math.floor(nextY / TILE_SIZE);
      player.y = (topRow + 1) * TILE_SIZE;
    }
    player.vy = 0;
  }
// ハシゴの上面で自然に立てる
  const underTile = getTile(player.x + player.width / 2, player.y + player.height + 2);
  const nowTile = getTile(player.x + player.width / 2, player.y + player.height / 2);
  if (underTile === 8 && nowTile !== 8) {
    player.onGround = true;
    player.vy = 0;
  }

  // --- ここから壁めり込み即死判定 ---
  if (!isDead && checkCollision(player.x, player.y, player.width, player.height)) {
    if (window.debugMode) {
      debugLog('壁めり込み即死判定: プレイヤーが壁にめり込んだため死亡');
    }
    diePlayer('block');
    return;
  }

  if (!isDead && canvas) {
    // ver.2完全コピー：プレイヤーを中心に（補完なし）
    cameraX = player.x + player.width / 2 - getBaseCanvasWidth() / (2 * window.dynamicScale);
    cameraY = player.y + player.height / 2 - getBaseCanvasHeight() / (2 * window.dynamicScale);
    
    // ver.2完全コピー：制限
    const bounds = window.getActiveMapBounds ? window.getActiveMapBounds() : null;
    const mapPixelHeight = (bounds ? bounds.rows : map.length) * TILE_SIZE;
    const viewHeight = getBaseCanvasHeight() / window.dynamicScale;
    const maxCameraY = Math.max(0, mapPixelHeight - viewHeight);
    if (cameraY > maxCameraY) cameraY = maxCameraY;
    if (cameraY < 0) cameraY = 0;

    const mapPixelWidth = (bounds ? bounds.cols : (map[0]?.length || mapCols)) * TILE_SIZE;
    const viewWidth = getBaseCanvasWidth() / window.dynamicScale;
    const maxCameraX = Math.max(0, mapPixelWidth - viewWidth);
    if (cameraX > maxCameraX) cameraX = maxCameraX;
  } else {
    cameraX = cameraLockX;
    cameraY = cameraLockY;
  }
  if (cameraX < 0) cameraX = 0;
  animator.update(isMoving, !player.onGround);



  // --- タイルごとの判定 ---
  const footX = player.x + player.width / 2;
  const footY = player.y + player.height + 1;
  const tileBelow = getTile(footX, footY);

  // --- breakable block timer ---
  if (!window.breakTimers) window.breakTimers = {};
  if (!window.fallingBreaks) window.fallingBreaks = [];
  if (!window.breakRespawns) window.breakRespawns = [];
  const colBelow = Math.floor(footX / TILE_SIZE);
  const rowBelow = Math.floor(footY / TILE_SIZE);
  if (tileBelow === 11) {
    const key = rowBelow + "," + colBelow;
    if (!window.breakTimers[key]) {
      window.breakTimers[key] = performance.now();
    }
  }
  // 起動中の落下ブロックを更新（対象キーのみ）
  const activeBreakTimers = window.breakTimers;
  if (activeBreakTimers) {
    const nowTime = performance.now();
    for (const key of Object.keys(activeBreakTimers)) {
      const elapsed = nowTime - activeBreakTimers[key];
      if (elapsed <= 500) continue;
      const [rowStr, colStr] = key.split(',');
      const row = Number(rowStr);
      const col = Number(colStr);
      if (!Number.isInteger(row) || !Number.isInteger(col)) {
        delete activeBreakTimers[key];
        continue;
      }
      const rowData = map[row];
      if (!rowData || rowData[col] !== 11) {
        delete activeBreakTimers[key];
        continue;
      }
      window.fallingBreaks.push({
        row,
        col,
        y: row * TILE_SIZE,
        vy: 0
      });
      rowData[col] = 0;
      delete activeBreakTimers[key];
    }
  }

  // --- falling breakable blocks update ---
  for (let i = window.fallingBreaks.length - 1; i >= 0; i--) {
    const fb = window.fallingBreaks[i];
    fb.vy += 0.5; // gravity
    fb.y += fb.vy;
    const nextRow = Math.floor((fb.y + TILE_SIZE) / TILE_SIZE);
    
    // 動く敵との衝突判定
    let hitEnemy = false;
    for (let j = enemyObjs.length - 1; j >= 0; j--) {
      const enemy = enemyObjs[j];
        if (
          fb.col * TILE_SIZE + TILE_SIZE > enemy.x &&
          fb.col * TILE_SIZE < enemy.x + TILE_SIZE &&
          fb.y + TILE_SIZE > enemy.y &&
        fb.y < enemy.y + TILE_SIZE
        ) {
          // 敵を倒す！
        enemyObjs.splice(j, 1);
        hitEnemy = true;
          scoa += 300; // 敵を倒したスコア
          break;
        }
      }
    
    if (hitEnemy) {
      // 敵を倒した場合は落下ブロックも消す
      window.fallingBreaks.splice(i, 1);
      continue;
    }
    
    if (nextRow >= map.length || (nextRow >= 0 && map[nextRow][fb.col] !== 0)) {
      // 地面に着いたらフェードアウト開始（一度だけ）
      if (!fb.fading) {
        fb.fading = true;
        fb.alpha = 1.0;
        fb.fadeTimer = 0;
      }
    }
    if (fb.fading) {
      fb.fadeTimer += 1;
      fb.alpha -= 0.1; // 0.03 → 0.1 に変更してフェードアウトを速くする
      
      // フェードアウト完了条件を複数設定
      if (fb.alpha <= 0 || fb.fadeTimer >= 3) { // タイマーを3フレームに短縮
        // 復活待ちリストに追加
        window.breakRespawns.push({row: fb.row, col: fb.col, timer: 300}); // 5秒(60fps)
        window.fallingBreaks.splice(i, 1);
        continue;
      }
    }
  }
  // --- breakable block respawn ---
  for (let i = window.breakRespawns.length - 1; i >= 0; i--) {
    const br = window.breakRespawns[i];
    br.timer--;
    if (br.timer <= 0) {
      map[br.row][br.col] = 11;
      window.breakRespawns.splice(i, 1);
    } else {
      // 何もしない
    }
  }

  // --- タイルごとの判定 ---
  // 固定敵の死亡判定（プレイヤーが敵の上に乗った時のみ）
  const playerBottom = player.y + player.height;
  
  // プレイヤーの足元のタイルをチェック（固定敵のみ）
  const tileBelowPlayer = getTile(playerMidX, playerBottom + 1);
  if (tileBelowPlayer === 3 && !isDead) {
    if (window.debugMode) {
      debugLog("固定敵死亡判定");
    }
    diePlayer("enemy");
    return;
  }
  
  // トランポリンの当たり判定（1x1タイル分のみ）
  const trampolineRow = Math.floor(playerBottom / TILE_SIZE);
  const trampolineCol = Math.floor(playerMidX / TILE_SIZE);
  if (trampolineRow >= 0 && trampolineRow < map.length && trampolineCol >= 0 && trampolineCol < map[0].length) {
    const tile = map[trampolineRow][trampolineCol];
    if (tile === 7 && player.vy > 0 && !isDead) {
      let angle = 0; // デフォルトは上方向
      if (window.trampolineAngles && window.trampolineAngles[`${trampolineRow},${trampolineCol}`] !== undefined) {
        angle = window.trampolineAngles[`${trampolineRow},${trampolineCol}`];
      } else {
        // 角度が設定されていない場合は0°（上方向）をデフォルトとして設定
        if (!window.trampolineAngles) window.trampolineAngles = {};
        window.trampolineAngles[`${trampolineRow},${trampolineCol}`] = 0;
        angle = 0;
      }
      
      // 精密な軌道計算
      const rad = (angle - 90) * Math.PI / 180;
      // トランポリンの力の設定を取得（デフォルトは2.2倍）
      let trampolinePowerMultiplier = 2.2;
      if (window.trampolinePowers && window.trampolinePowers[`${trampolineRow},${trampolineCol}`] !== undefined) {
        trampolinePowerMultiplier = window.trampolinePowers[`${trampolineRow},${trampolineCol}`];
      } else {
        // 力が設定されていない場合は2.2倍をデフォルトとして設定
        if (!window.trampolinePowers) window.trampolinePowers = {};
        window.trampolinePowers[`${trampolineRow},${trampolineCol}`] = 2.2;
      }
      const basePower = Math.abs(player.jumpPower) * trampolinePowerMultiplier;
      
      // 角度に応じた軌道調整
      let powerMultiplier = 1.0;
      let horizontalMultiplier = 1.0;
      let verticalMultiplier = 1.0;
      
      // 角度範囲ごとの軌道調整
      if (angle >= 315 || angle < 45) {
        // 右方向 (315-45度): 水平方向を強化
        horizontalMultiplier = 1.2;
        verticalMultiplier = 0.8;
      } else if (angle >= 45 && angle < 135) {
        // 下方向 (45-135度): 垂直方向を強化
        horizontalMultiplier = 0.6;
        verticalMultiplier = 1.4;
      } else if (angle >= 135 && angle < 225) {
        // 左方向 (135-225度): 水平方向を強化
        horizontalMultiplier = 1.2;
        verticalMultiplier = 0.8;
      } else {
        // 上方向 (225-315度): 垂直方向を強化
        horizontalMultiplier = 0.6;
        verticalMultiplier = 1.4;
      }
      
      // 細かい角度調整
      const angleMod = angle % 90;
      if (angleMod > 0 && angleMod < 90) {
        // 斜め方向の場合、角度に応じて力を調整
        const diagonalMultiplier = 0.8 + (angleMod / 90) * 0.4; // 0.8-1.2の範囲
        powerMultiplier = diagonalMultiplier;
      }
      
      // 最終的な速度計算
      const finalPower = basePower * powerMultiplier;
      const initialVx = Math.cos(rad) * finalPower * horizontalMultiplier;
      const initialVy = Math.sin(rad) * finalPower * verticalMultiplier;
      
      // 軌道計算を開始
      player.isInTrampolineTrajectory = true;
      player.trajectoryStartTime = performance.now();
      player.initialTrajectoryVx = initialVx;
      player.initialTrajectoryVy = initialVy;
      player.vx = initialVx;
      player.vy = initialVy;
      player.onGround = false;
      // ここで予測着地点を計算して保存
      if (window.isEditorMode && typeof computePredictedLanding === 'function') {
        try {
          player.predictedLanding = computePredictedLanding(initialVx, initialVy, player.x, player.y);
          if (window.debugMode) debugLog('predictedLanding', player.predictedLanding);
        } catch (e) {
          console.error('予測着地点計算に失敗', e);
          player.predictedLanding = null;
        }
      }
      
      // デバッグ情報（開発時のみ）
      if (window.debugMode) {
        debugLog(`トランポリン軌道開始: 角度: ${angle}°, パワー: ${finalPower.toFixed(2)}, VX: ${initialVx.toFixed(2)}, VY: ${initialVy.toFixed(2)}`);
      }
    }
  }
  
  // プレイヤー中心座標
  const tileAtCenter = getTile(playerMidX, playerMidY);
  if (tileAtCenter === 6 && !isDead) {
    if (window.debugMode) {
      debugLog("毒死亡判定");
    }
    diePlayer("poison");
    return;
  }
  
  // ハシゴの判定（当たり判定なしになったので特殊効果のみ）
  const bodyX = playerMidX;
  const bodyY = playerMidY;
  const tileAtBody = getTile(bodyX, bodyY);
  
  if (tileAtBody === 8) {
    // キー設定を使用した梯子上昇・下降の処理
    const ladderUpKey = window.gameKeys?.ladderUp || 'w';
    const downKey = window.gameKeys?.down || 's';
    
    if (isKeyActive(ladderUpKey) || isKeyActive("ArrowUp")) {
      player.vy = -2; // 上昇
    } else if (isKeyActive(downKey) || isKeyActive("ArrowDown")) {
      player.vy = 2; // 下降
    } else if (shiftPressed) {
      player.vy = 0; // シフトで落下停止
    } else {
      player.vy = 0; // 何も押していない時は停止
    }
    player.onGround = true;
  }
  
  // ジャンプ（スペースキーのみ）
  const jumpKey = window.gameKeys?.jump || ' ';
  
  // ジャンプキーが↑に設定されている場合は↑キーのみでジャンプ
  if (jumpKey === 'ArrowUp') {
    if (isKeyActive(jumpKey) && player.onGround) {
      player.vy = player.jumpPower;
      player.onGround = false;
    }
  } else {
    // 通常のジャンプ処理（スペースキーのみ）
    if (isKeyActive(jumpKey) && player.onGround) {
      player.vy = player.jumpPower;
      player.onGround = false;
    }
  }
  
  // 胴体判定（プレイヤーの中心部分）
  if (tileAtBody === 15) {
    scoa += 100;
    const col = Math.floor(bodyX / TILE_SIZE);
    const row = Math.floor(bodyY / TILE_SIZE);
    if (map[row] && map[row][col] === 15) {
      map[row][col] = 0;
      markStaticChunkDirtyByTile(row, col);
    }
  }
  if (tileAtBody === 16) {
    // 前回のチェックポイント位置との距離をチェック
    const dist = Math.sqrt((player.x - window.lastCheckpointPos.x) ** 2 + (player.y - window.lastCheckpointPos.y) ** 2);
    if (dist > 32) { // 32px以上離れている場合のみ新しいチェックポイントとして設定
      respawnPoint.x = player.x;
      respawnPoint.y = player.y;
      window.lastCheckpointPos.x = player.x;
      window.lastCheckpointPos.y = player.y;
    }
  }
  // 落下死
  const fallThreshold = map.length * TILE_SIZE + 64;
  if (player.y > fallThreshold && !isDead) {
    if (window.debugMode) {
      debugLog("落下死判定");
    }
    isDead = true;
    deathStartTime = performance.now();
    useFallDeathScreen = true;
    player.x = respawnPoint.x;
    player.y = respawnPoint.y;
    player.vx = 0; player.vy = 0;
    player.onGround = false;
    for (let key in keys) keys[key] = false;
    deathFrozen = true;
    cameraLockX = cameraX;
    cameraLockY = cameraY;
    return;
  }

  // ゴール
  if (tileAtBody === 4) {
    scoa += 500;
    const col = Math.floor(bodyX / TILE_SIZE);
    const row = Math.floor(bodyY / TILE_SIZE);
    if (map[row] && map[row][col] === 4) {
      map[row][col] = 0;
      markStaticChunkDirtyByTile(row, col);
    }
  }
  // ゴールドゴール
  if (tileAtBody === 17) {
    scoa += 2000;
    const col = Math.floor(bodyX / TILE_SIZE);
    const row = Math.floor(bodyY / TILE_SIZE);
    if (map[row] && map[row][col] === 17) {
      map[row][col] = 0;
      markStaticChunkDirtyByTile(row, col);
    }
  }

  // 土と草の変換処理（0.5秒間に一度）
  if (!window.groundDirtTimer) window.groundDirtTimer = 0;
  window.groundDirtTimer++;
  if (window.groundDirtTimer >= 30) { // 60fps * 0.5秒 = 30フレーム
    for (let r = 0; r < map.length; r++) {
      for (let c = 0; c < map[r].length; c++) {
        if (map[r][c] === 1 && r > 0 && map[r-1][c] !== 0) {
          // スコアをゲットできるブロック、チェックポイント、スポーン地点、動く敵は除外
          const tileAbove = map[r-1][c];
          if (tileAbove !== 4 && tileAbove !== 15 && tileAbove !== 16 && tileAbove !== 17 && tileAbove !== 10 && tileAbove !== 3) {
            map[r][c] = 2; // groundの上に何かあればdirtに変換
            markStaticChunkDirtyByTile(r, c);
          }
        }
        if (map[r][c] === 2 && (r === 0 || map[r-1][c] === 0)) {
          map[r][c] = 1; // dirtの上に何もなければgroundに変換
          markStaticChunkDirtyByTile(r, c);
        }
      }
    }
    window.groundDirtTimer = 0;
  }

  if (isDead) {
    const elapsed = performance.now() - deathStartTime;
    if (useFallDeathScreen) {
      if (elapsed >= 100) {
        isDead = false;
        showDeathScreen = false;
        useFallDeathScreen = false;
        deathFrozen = false;
      }
      return;
    }
    if (elapsed >= 1000 && !showDeathScreen) showDeathScreen = true;
    if (elapsed >= 2000) {
      isDead = false;
      showDeathScreen = false;
      useFallDeathScreen = false;
      deathFrozen = false;
    }
    return;
  }

  // カメラは常にプレイヤー中心
  cameraX += (player.x + player.width / 2 - cameraX - getBaseCanvasWidth() / (2 * window.dynamicScale)) * window.cameraSpeed;
  cameraY += (player.y + player.height / 2 - cameraY - getBaseCanvasHeight() / (2 * window.dynamicScale)) * window.cameraSpeed;
  // カメラ制限（マップサイズに合わせる: mapの現在のサイズで制限）
  const bounds = window.getActiveMapBounds ? window.getActiveMapBounds() : null;
  const mapPixelWidth = (bounds ? bounds.cols : (map[0]?.length || mapCols)) * TILE_SIZE;
  const mapPixelHeight = (bounds ? bounds.rows : map.length) * TILE_SIZE;
  const maxCameraX = Math.max(0, mapPixelWidth - getBaseCanvasWidth() / window.dynamicScale);
  const maxCameraY = Math.max(0, mapPixelHeight - getBaseCanvasHeight() / window.dynamicScale);
  cameraX = Math.max(0, Math.min(cameraX, maxCameraX));
  cameraY = Math.max(0, Math.min(cameraY, maxCameraY));
}

// 描画
function draw() {
  if (!canvas || !ctx) return;

  const now = performance.now();
  const elapsedSec = ((now - window.gameStartTime) / 1000).toFixed(1);
  const bounds = window.getActiveMapBounds ? window.getActiveMapBounds() : null;
  const totalCols = map[0]?.length || mapCols;
  const totalRows = bounds ? Math.max(bounds.rows, 1) : map.length;
  const scale = window.dynamicScale || 1;
  const pixelRatio = getRenderPixelRatio();
  const displayScale = scale * pixelRatio;
  const viewWidth = getBaseCanvasWidth() / scale;
  const viewHeight = getBaseCanvasHeight() / scale;
  const renderCameraX = alignToPixel(cameraX);
  const renderCameraY = alignToPixel(cameraY);
  const visibleColStart = Math.max(0, Math.floor(renderCameraX / TILE_SIZE) - 1);
  const visibleColEnd = Math.min(totalCols, Math.ceil((renderCameraX + viewWidth) / TILE_SIZE) + 1);
  const visibleRowStart = Math.max(0, Math.floor(renderCameraY / TILE_SIZE) - 1);
  const visibleRowEnd = Math.min(totalRows, Math.ceil((renderCameraY + viewHeight) / TILE_SIZE) + 1);

  if (window.showTrampolineTrajectory) {
    ctx.save();
    ctx.strokeStyle = 'orange';
    ctx.lineWidth = 2;
    for (let row = visibleRowStart; row < Math.min(map.length, visibleRowEnd); row++) {
      const mapRow = map[row];
      if (!mapRow) continue;
      for (let col = visibleColStart; col < Math.min(mapRow.length, visibleColEnd); col++) {
        if (mapRow[col] === 7) {
          const x0 = col * TILE_SIZE + TILE_SIZE / 2;
          const y0 = row * TILE_SIZE + TILE_SIZE / 2;
          const angle = 75 * Math.PI / 180;
          const power = 18;
          let vx = Math.cos(angle) * power;
          let vy = -Math.sin(angle) * power;
          let x = x0;
          let y = y0;
          for (let t = 0; t < 60; t++) {
            vy += 0.7;
            x += vx;
            y += vy;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + vx, y + vy);
            ctx.stroke();
          }
          ctx.save();
          ctx.fillStyle = 'red';
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, 2 * Math.PI);
          ctx.fill();
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#aee';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  ctx.setTransform(displayScale, 0, 0, displayScale, -renderCameraX * displayScale, -renderCameraY * displayScale);

  const shouldDrawGrid = window.isEditorMode && window.showGrid;
  if (shouldDrawGrid) {
    ctx.save();
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    for (let col = visibleColStart; col <= visibleColEnd; col++) {
      const x = col * TILE_SIZE;
      ctx.beginPath();
      ctx.moveTo(x, visibleRowStart * TILE_SIZE);
      ctx.lineTo(x, visibleRowEnd * TILE_SIZE);
      ctx.stroke();
    }
    for (let row = visibleRowStart; row <= visibleRowEnd; row++) {
      const y = row * TILE_SIZE;
      ctx.beginPath();
      ctx.moveTo(visibleColStart * TILE_SIZE, y);
      ctx.lineTo(visibleColEnd * TILE_SIZE, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawStaticChunks(ctx, visibleColStart, visibleColEnd);

  if (window.fallingBreaks && window.fallingBreaks.length) {
    const minX = renderCameraX - TILE_SIZE;
    const maxX = renderCameraX + viewWidth + TILE_SIZE;
    const minY = renderCameraY - TILE_SIZE;
    const maxY = renderCameraY + viewHeight + TILE_SIZE;
    for (const fb of window.fallingBreaks) {
      if (!fb) continue;
      const fx = fb.col * TILE_SIZE;
      const fy = fb.y;
      if (fx + TILE_SIZE < minX || fx > maxX || fy + TILE_SIZE < minY || fy > maxY) continue;
      ctx.save();
      if (fb.fading) ctx.globalAlpha = Math.max(0, fb.alpha);
      ctx.drawImage(breakableImg, fx, fy, TILE_SIZE, TILE_SIZE);
      ctx.globalAlpha = 1.0;
      ctx.restore();
    }
  }

  for (let row = visibleRowStart; row < visibleRowEnd; row++) {
    const mapRow = map[row];
    if (!mapRow) continue;
    for (let col = visibleColStart; col < Math.min(mapRow.length, visibleColEnd); col++) {
      const tile = mapRow[col];
      const x = col * TILE_SIZE;
      const y = row * TILE_SIZE;

      let drawTile = tile;
      if (drawTile === 19 && window.dummyOverlays) {
        const overlayTile = window.dummyOverlays[`${row},${col}`];
        if (overlayTile !== undefined) {
          drawTile = overlayTile;
        }
      }

      if (drawTile === 0 || STATIC_TILE_IDS.has(drawTile)) {
        continue;
      } else if (drawTile === 3) {
        ctx.drawImage(enemyImg, x, y, TILE_SIZE, TILE_SIZE);
      } else if (drawTile === 4) {
        ctx.drawImage(goalImg, x, y, TILE_SIZE, TILE_SIZE);
      } else if (drawTile === 7) {
        let angle = 0;
        if (window.trampolineAngles && window.trampolineAngles[`${row},${col}`] !== undefined) {
          angle = window.trampolineAngles[`${row},${col}`];
        }
        ctx.save();
        ctx.translate(x + TILE_SIZE / 2, y + TILE_SIZE / 2);
        ctx.rotate(angle * Math.PI / 180);
        ctx.drawImage(trampolineImg, -TILE_SIZE / 2, -TILE_SIZE * 0.75, TILE_SIZE, TILE_SIZE * 1.5);
        ctx.restore();
      } else if (drawTile === 11) {
        ctx.drawImage(breakableImg, x, y, TILE_SIZE, TILE_SIZE);
      } else if (drawTile === 15) {
        ctx.drawImage(coinImg, x, y, TILE_SIZE, TILE_SIZE);
      } else if (drawTile === 16) {
        ctx.drawImage(checkpointImg, x, y, TILE_SIZE, TILE_SIZE);
      } else if (drawTile === 17) {
        ctx.drawImage(goldgoalImg, x, y, TILE_SIZE, TILE_SIZE);
      } else if (drawTile >= 20 && drawTile <= 30) {
        const colorIndex = drawTile - 20;
        if (colorBlockImages[colorIndex]) {
          ctx.drawImage(colorBlockImages[colorIndex], x, y, TILE_SIZE, TILE_SIZE);
        }
      }
    }
  }

  if (window.showCollisionBoxes) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 64, 64, 0.8)';
    ctx.lineWidth = 1 / displayScale;
    for (let row = visibleRowStart; row < visibleRowEnd; row++) {
      const mapRow = map[row];
      if (!mapRow) continue;
      for (let col = visibleColStart; col < Math.min(mapRow.length, visibleColEnd); col++) {
        let tile = mapRow[col];
        let drawTile = tile;
        if (drawTile === 19 && window.dummyOverlays) {
          const overlayTile = window.dummyOverlays[`${row},${col}`];
          if (overlayTile !== undefined) {
            drawTile = overlayTile;
          }
        }
        if (drawTile === 0) continue;
        const x = col * TILE_SIZE;
        const y = row * TILE_SIZE;
        ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
      }
    }
    if (window.fallingBreaks && window.fallingBreaks.length) {
      for (const fb of window.fallingBreaks) {
        if (!fb) continue;
        const fx = fb.col * TILE_SIZE;
        const fy = fb.y;
        ctx.strokeRect(fx, fy, TILE_SIZE, TILE_SIZE);
      }
    }
    ctx.restore();
  }

  drawEnemies();

  if (!deathFrozen) {
    animator.draw(ctx, player.x, player.y, player.width, player.height, isMoving, facingLeft, !player.onGround);
  }

  if (player.predictedLanding && window.isEditorMode) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,0,0,0.8)';
    const px = player.predictedLanding.x + player.width / 2;
    const py = player.predictedLanding.y + player.height / 2;
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (useFallDeathScreen) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(deathScreenFallImg, 0, 0, canvas.width, canvas.height);
  } else if (showDeathScreen) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(deathScreenImg, 0, 0, canvas.width, canvas.height);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  const fontSize = Math.max(8, Math.round(20 * pixelRatio));
  ctx.font = `bold ${fontSize}px Arial`;
  const timeX = logicalToRender(getBaseCanvasWidth() - 300);
  const scoreX = logicalToRender(getBaseCanvasWidth() - 160);
  const hudY = logicalToRender(30);
  ctx.fillText(`TIME: ${elapsedSec}s`, timeX, hudY);
  ctx.fillText(`SCORE: ${scoa}`, scoreX, hudY);
}


function gameLoop() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const delta = now - lastFrameTimestamp;
  lastFrameTimestamp = now;

  if (typeof document !== 'undefined' && document.hidden) {
    requestAnimationFrame(gameLoop);
    return;
  }

  if (canvas) {
    update();
    draw();
    monitorPerformance(delta);
    processStaticChunkQueue();
  }

  prevCameraX = cameraX;
  prevCameraY = cameraY;

  requestAnimationFrame(gameLoop);
}

// ゲームページ（index.html）でのみgameLoopを実行
if (!window.location.pathname.includes('editor.html') && (window.location.pathname.includes('index.html') || window.location.pathname.endsWith('/') || window.location.pathname === '')) {
  const requiredImages = [
    groundImg,
    dirtImg,
    enemyImg,
    goalImg,
    stoneImg,
    poisonImg,
    trampolineImg,
    ladderImg,
    enemyMoveImg1,
    enemyMoveImg2,
    breakblockImg,
    rail1Img,
    rail2Img,
    rail3Img,
    coinImg,
    checkpointImg,
    goldgoalImg,
    deathScreenImg,
    deathScreenFallImg,
    ...colorBlockImages
  ];
  Promise.all(requiredImages.map(waitForImage)).then(() => {
    gameLoop();
  });
}

function findSpawn() {
  for (let r = 0; r < map.length; r++) {
    for (let c = 0; c < map[0].length; c++) {
      if (map[r][c] === 10) {
        return { x: c * TILE_SIZE, y: r * TILE_SIZE };
      }
    }
  }
  return { x: 100, y: 100 }; // デフォルト
}

function findSpawnTileCoords() {
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (row[c] === 10) {
        return { row: r, col: c };
      }
    }
  }
  return { row: 0, col: 0 };
}

function saveThumbnailData() {
  if (!Array.isArray(map) || !map.length) return;
  const viewRows = 5;
  const viewCols = 8;
  const spawnTile = findSpawnTileCoords();
  const maxRows = map.length;
  let maxCols = 0;
  for (let i = 0; i < map.length; i++) {
    const row = map[i];
    if (Array.isArray(row) && row.length > maxCols) {
      maxCols = row.length;
    }
  }
  if (maxCols === 0) maxCols = viewCols;

  let startRow = Math.max(0, spawnTile.row - Math.floor(viewRows / 2));
  let startCol = Math.max(0, spawnTile.col - Math.floor(viewCols / 2));
  if (startRow + viewRows > maxRows) startRow = Math.max(0, maxRows - viewRows);
  if (startCol + viewCols > maxCols) startCol = Math.max(0, maxCols - viewCols);

  const trimmedMap = [];
  for (let r = 0; r < viewRows; r++) {
    const sourceRowIndex = startRow + r;
    const sourceRow = map[sourceRowIndex] || [];
    const newRow = new Array(viewCols);
    for (let c = 0; c < viewCols; c++) {
      const sourceColIndex = startCol + c;
      const value = sourceRow[sourceColIndex];
      const numeric = typeof value === 'number' ? value : Number(value);
      newRow[c] = Number.isFinite(numeric) ? numeric : 0;
    }
    trimmedMap.push(newRow);
  }

  const overlayEntries = {};
  if (window.dummyOverlays) {
    Object.keys(window.dummyOverlays).forEach(key => {
      const [rStr, cStr] = key.split(',');
      const r = Number(rStr);
      const c = Number(cStr);
      if (!Number.isInteger(r) || !Number.isInteger(c)) return;
      if (r >= startRow && r < startRow + viewRows && c >= startCol && c < startCol + viewCols) {
        overlayEntries[key] = window.dummyOverlays[key];
      }
    });
  }

  const data = {
    version: 2,
    offsetRow: startRow,
    offsetCol: startCol,
    map: trimmedMap,
    dummyOverlays: overlayEntries
  };

  try {
    localStorage.setItem('thumbdata_' + slotName, JSON.stringify(data));
    localStorage.removeItem('thumb_' + slotName);
  } catch (err) {
    console.warn('thumbdata 保存に失敗しました:', err);
  }
}

if (typeof window !== 'undefined') {
  window.saveThumbnailData = saveThumbnailData;
  window.markTileAndNeighborsDirty = markTileAndNeighborsDirty;
  window.invalidateStaticChunks = resetStaticChunks;
}

// --- サムネイル保存ボタンを削除 ---
const oldThumbBtn = document.getElementById('saveThumbBtn');
if (oldThumbBtn) oldThumbBtn.remove();

const homeBtn = document.getElementById("backHomeBtn");
if (homeBtn) {
  homeBtn.onclick = () => {
    location.href = "home.html";
  };
}

function saveMap() {
  const mapData = {
    map: map,
    dummyOverlays: window.dummyOverlays || {},
    enemyDirs: window.enemyDirs || {},
    trampolineAngles: window.trampolineAngles || {},
    trampolinePowers: window.trampolinePowers || {},
    enemyProps: window.enemyProps || {},
    cols: map[0]?.length || mapCols,
    rows: map.length
  };
  localStorage.setItem("world_" + slotName, JSON.stringify(mapData));
  saveThumbnailData();
}
