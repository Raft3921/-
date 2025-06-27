const urlParams = new URLSearchParams(window.location.search);
let slotName = urlParams.get("slot");
if (!slotName) slotName = localStorage.getItem("currentSlot") || "新しいワールド";
slotName = String(slotName); // 文字列化

const TILE_SIZE = 32;
const SCALE = 2.0;
const mapCols = 100;
const mapRows = 20;
const map = [];

// 地形データのロード
function loadMapFromStorage() {
  const savedMap = localStorage.getItem("world_" + slotName);
  if (savedMap) {
    const parsed = JSON.parse(savedMap);
    if (Array.isArray(parsed)) {
      map.length = 0;
      map.push(...parsed);
      return true;
    }
  }
  for (let r = 0; r < mapRows; r++) {
    map[r] = [];
    for (let c = 0; c < mapCols; c++) map[r][c] = 0;
  }
  return false;
}
loadMapFromStorage();

// 画像の準備
const groundImg = new Image(); groundImg.src = "assets/ground.png";
const dirtImg = new Image();   dirtImg.src = "assets/dirt.png";
const enemyImg = new Image();  enemyImg.src = "assets/enemy.png";
const goalImg = new Image();   goalImg.src = "assets/goal.png";
const stoneImg = new Image();     stoneImg.src = "assets/stone.png";
const poisonImg = new Image();    poisonImg.src = "assets/poison.png";
const trampolineImg = new Image();trampolineImg.src = "assets/trampoline.png";
const ladderImg = new Image();    ladderImg.src = "assets/ladder.png";
const enemyMoveImg1 = new Image(); enemyMoveImg1.src = "assets/enemy-move1.png";
const enemyMoveImg2 = new Image(); enemyMoveImg2.src = "assets/enemy-move2.png";
const deathScreenImg = new Image(); deathScreenImg.src = "assets/death_screen.png";
const deathScreenFallImg = new Image(); deathScreenFallImg.src = "assets/death_screen_fall.png";
const breakblockImg = new Image(); breakblockImg.src = "assets/breakblock.png";
const breakableImg = breakblockImg; // breakable block
const rail1Img = new Image(); rail1Img.src = "assets/rail1.png";
const rail2Img = new Image(); rail2Img.src = "assets/rail2.png";
const rail3Img = new Image(); rail3Img.src = "assets/rail3.png";
const coinImg = new Image(); coinImg.src = "assets/coin.png";
const checkpointImg = new Image(); checkpointImg.src = "assets/checkpoint.png";
const goldgoalImg = new Image(); goldgoalImg.src = "assets/goldgoal.png";

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
window.canvas = canvas;
window.ctx = ctx;
window.slotName = slotName;

// プレイヤー
const player = {
  x: 100, y: 100, width: 28, height: 28,
  vx: 0, vy: 0, speed: 3, jumpPower: -9,
  gravity: 0.5, onGround: false,
};
const respawnPoint = { x: 100, y: 100 };

// プレイヤーアニメーター
class PlayerAnimator {
  constructor() {
    this.frame = 0;
    this.timer = 0;
    this.runImages = [
      document.getElementById("player"),
      document.getElementById("player-run1"),
      document.getElementById("player-run2"),
    ];
    this.jumpImages = [
      document.getElementById("player-jump1"),
      document.getElementById("player-jump2"),
    ];
    this.justJumped = false;
    this.jumpFrameStart = 0;
    this.lastJumping = false;
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
    let img;
    const now = performance.now();
    if (this.justJumped) {
      const elapsed = now - this.jumpFrameStart;
      if (elapsed < 100) img = this.jumpImages[0];
      else if (elapsed < 200) img = this.jumpImages[1];
      else this.justJumped = false;
    }
    if (!img) {
      if (jumping) {
        const centerX = x + width / 2;
        const bottomY = y + height;
        const nearGround =
          getTile(centerX, bottomY + 1) !== 0 ||
          getTile(centerX, bottomY + 32) !== 0;
        img = nearGround ? this.jumpImages[0] : this.jumpImages[1];
      } else if (moving) {
        img = this.runImages[this.frame % this.runImages.length];
      } else {
        img = this.runImages[0];
      }
    }
    ctx.save();
    if (flip) {
      ctx.translate(x + width, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, width, height);
    } else {
      ctx.drawImage(img, x, y, width, height);
    }
    ctx.restore();
  }
}
const animator = new PlayerAnimator();

const keys = {};
let cameraX = 0, cameraY = 0;
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
        enemyObjs.push({
          x: col * TILE_SIZE,
          y: row * TILE_SIZE,
          dir: Math.random() < 0.5 ? -1 : 1,
          speed: 1.5,
          animTimer: Math.floor(Math.random() * 60) // スタートずらす
        });
        map[row][col] = 0; // マップ上から消す
      }
    }
  }
}
initEnemies();

function updateEnemies() {
  for (const enemy of enemyObjs) {
    enemy.x += enemy.speed * enemy.dir;
    enemy.animTimer = (enemy.animTimer || 0) + 1;
    // 足元と正面で折返し
    const aheadX = enemy.x + (enemy.dir > 0 ? TILE_SIZE : -2);
    const footY = enemy.y + TILE_SIZE;
    const tileAhead = getTile(aheadX, enemy.y);
    const tileBelowAhead = getTile(aheadX, footY);
    if (
      tileBelowAhead === 0 ||
      tileAhead === 1 || tileAhead === 2 || tileAhead === 5
    ) {
      enemy.dir *= -1;
      enemy.x += enemy.speed * enemy.dir;
    }
  }
}

function drawEnemies() {
  for (const enemy of enemyObjs) {
    const frame = Math.floor((enemy.animTimer || 0) / 10) % 2;
    const img = frame === 0 ? enemyMoveImg1 : enemyMoveImg2;
    ctx.drawImage(img, enemy.x, enemy.y, TILE_SIZE, TILE_SIZE);
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

function collideWithMap(px, py, w, h) {
  // プレイヤーの当たり判定だけ幅を狭く
  let marginX = 0;
  if (w === 28 && h === 28) marginX = 4; // プレイヤーのみ
  const tilesToCheck = [
    [px + marginX, py], [px + w - marginX, py], [px + marginX, py + h], [px + w - marginX, py + h],
  ];
  return tilesToCheck.some(([x, y]) => {
    const t = getTile(x, y);
    // レール（12,13,14）は当たり判定に含めない、棘（3）は普通のブロックとして判定
    return t === 1 || t === 2 || t === 3 || t === 5 || t === 11;
  });
}

// チェックポイント管理
if (!window.checkpoints) window.checkpoints = [];
if (!window.lastCheckpointPos) window.lastCheckpointPos = {x: -1, y: -1};

// 死亡処理（death.gifも）
function diePlayer(reason) {
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
  console.log("リスポーン位置:", respawnPoint.x, respawnPoint.y);
  player.x = respawnPoint.x;
  player.y = respawnPoint.y;
  player.vx = 0; player.vy = 0; player.onGround = false;
  for (let key in keys) keys[key] = false;
  deathFrozen = true;
}

// プレイヤー初期化時
const spawn = findSpawn();
player.x = spawn.x;
player.y = spawn.y;
respawnPoint.x = spawn.x;
respawnPoint.y = spawn.y;

// イベント登録
document.addEventListener("keydown", (e) => keys[e.key] = true);
document.addEventListener("keyup", (e) => keys[e.key] = false);

// カメラズーム制御用変数
if (typeof window.dynamicScale === 'undefined') window.dynamicScale = SCALE;
let targetScale = SCALE;

// 設定の読み込み
function loadGameSettings() {
  const settings = JSON.parse(localStorage.getItem('gameSettings') || '{}');
  const defaults = {
    cameraSpeed: 0.1,
    zoom: 2.0,
    difficulty: 'normal'
  };
  
  // カメラ追従速度
  window.cameraSpeed = settings.cameraSpeed !== undefined ? parseFloat(settings.cameraSpeed) : defaults.cameraSpeed;
  
  // ズーム倍率（設定値をそのまま使用）
  window.dynamicScale = settings.zoom !== undefined ? parseFloat(settings.zoom) : defaults.zoom;
  targetScale = window.dynamicScale;
  
  // 難易度設定
  window.gameDifficulty = settings.difficulty || defaults.difficulty;
  
  console.log('設定読み込み完了:', { cameraSpeed: window.cameraSpeed, zoom: window.dynamicScale, difficulty: window.gameDifficulty });
}
loadGameSettings();

// 設定変更時のリアルタイム反映
window.addEventListener('storage', (e) => {
  if (e.key === 'gameSettings') {
    console.log('設定が変更されました');
    loadGameSettings();
  }
});

// メイン更新
function update() {
  player.vx = 0; isMoving = false;
  if (keys["ArrowLeft"]) { player.vx = -player.speed; facingLeft = true; isMoving = true; }
  if (keys["ArrowRight"]) { player.vx = player.speed; facingLeft = false; isMoving = true; }
  if (keys[" "] && player.onGround) {
    player.vy = player.jumpPower;
    player.onGround = false;
  }

  // 移動・落下
  const nextX = player.x + player.vx;
  if (!collideWithMap(nextX, player.y, player.width, player.height)) player.x = nextX;
  player.vy += player.gravity;
  const nextY = player.y + player.vy;
  if (!collideWithMap(player.x, nextY, player.width, player.height)) {
    player.y = nextY;
    player.onGround = false;
  } else {
    if (player.vy > 0) player.onGround = true;
    player.vy = 0;
  }

  // ハシゴの上面で自然に立てる
  const underTile = getTile(player.x + player.width / 2, player.y + player.height + 2);
  const nowTile = getTile(player.x + player.width / 2, player.y + player.height / 2);
  if (underTile === 8 && nowTile !== 8) {
    player.onGround = true;
    player.vy = 0;
  }

  if (!isDead) {
    // プレイヤーがx軸でほぼ中心に来るようにカメラ調整
    const centerOffsetX = 0.0; // 0.0:完全中心, 0.1:少し左寄り
    cameraX = player.x + player.width / 2 - canvas.width / (2 * window.dynamicScale) - (canvas.width * centerOffsetX / window.dynamicScale);
    cameraY = player.y + player.height / 2 - canvas.height / (2 * window.dynamicScale);
    const mapPixelHeight = map.length * TILE_SIZE;
    const viewHeight = canvas.height / window.dynamicScale;
    const maxCameraY = mapPixelHeight - viewHeight;
    if (cameraY > maxCameraY - 32) cameraY = Math.min(cameraY, maxCameraY);
    if (cameraY < 0) cameraY = 0;
  } else {
    cameraX = cameraLockX;
    cameraY = cameraLockY;
  }
  if (cameraX < 0) cameraX = 0;
  animator.update(isMoving, !player.onGround);

  // 敵移動
  updateEnemies();

  // 動く敵との当たり判定
  for (const enemy of enemyObjs) {
    if (
      player.x + player.width > enemy.x &&
      player.x < enemy.x + TILE_SIZE &&
      player.y + player.height > enemy.y &&
      player.y < enemy.y + TILE_SIZE
    ) {
      if (!isDead) diePlayer("enemyMove");
    }
  }

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
  // 全ての落下ブロックのタイマーをチェック（プレイヤーが乗っていなくても）
  for (let row = 0; row < map.length; row++) {
    for (let col = 0; col < map[0].length; col++) {
      if (map[row][col] === 11) {
        const key = row + "," + col;
        if (window.breakTimers[key]) {
          const elapsed = performance.now() - window.breakTimers[key];
          if (elapsed > 500) {
            // 落下開始: fallingBreaksに追加
            window.fallingBreaks.push({
              row: row,
              col: col,
              y: row * TILE_SIZE,
              vy: 0
            });
            map[row][col] = 0;
            delete window.breakTimers[key];
          }
        }
      }
    }
  }

  // --- falling breakable blocks update ---
  for (let i = window.fallingBreaks.length - 1; i >= 0; i--) {
    const fb = window.fallingBreaks[i];
    fb.vy += 0.5; // gravity
    fb.y += fb.vy;
    const nextRow = Math.floor((fb.y + TILE_SIZE) / TILE_SIZE);
    if (nextRow >= map.length || (nextRow >= 0 && map[nextRow][fb.col] !== 0)) {
      if (nextRow >= map.length) {
        fb.fading = true;
        fb.alpha = 1.0;
        fb.fadeTimer = 0;
      } else {
        map[Math.floor(fb.y / TILE_SIZE)][fb.col] = 11;
        window.fallingBreaks.splice(i, 1);
        continue;
      }
    }
    if (fb.fading) {
      fb.fadeTimer += 1;
      fb.alpha -= 0.03;
      if (fb.alpha <= 0) {
        // 復活待ちリストに追加
        window.breakRespawns.push({row: fb.row, col: fb.col, timer: 180}); // 3秒(60fps)
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
    }
  }

  // --- タイルごとの判定 ---
  // 棘は上からのみダメージ判定（さらに上部に）
  const tileAbove = getTile(footX, footY - TILE_SIZE - 16);
  if (tileAbove === 3 && !isDead) {
    diePlayer("enemy");
    return;
  }
  if (tileBelow === 6 && !isDead) {
    diePlayer("poison");
    return;
  }
  if (tileBelow === 7 && player.vy > 0 && !isDead) {
    player.vy = player.jumpPower * 1.7; // きのこ
  }
  if (tileBelow === 8) {
    if (keys["w"]) player.vy = -2;
    else if (keys["s"]) player.vy = 2;
    else player.vy = 0;
    player.onGround = true;
  }
  
  // 胴体判定（プレイヤーの中心部分）
  const bodyX = player.x + player.width / 2;
  const bodyY = player.y + player.height / 2;
  const tileAtBody = getTile(bodyX, bodyY);
  
  if (tileAtBody === 15) {
    scoa += 100;
    const col = Math.floor(bodyX / TILE_SIZE);
    const row = Math.floor(bodyY / TILE_SIZE);
    if (map[row] && map[row][col] === 15) map[row][col] = 0;
  }
  if (tileAtBody === 16) {
    // 前回のチェックポイント位置との距離をチェック
    const dist = Math.sqrt((player.x - window.lastCheckpointPos.x) ** 2 + (player.y - window.lastCheckpointPos.y) ** 2);
    if (dist > 32) { // 32px以上離れている場合のみ新しいチェックポイントとして設定
      respawnPoint.x = player.x;
      respawnPoint.y = player.y;
      window.lastCheckpointPos.x = player.x;
      window.lastCheckpointPos.y = player.y;
      console.log("チェックポイント設定:", respawnPoint.x, respawnPoint.y);
    }
  }
  // 落下死
  const fallThreshold = map.length * TILE_SIZE + 64;
  if (player.y > fallThreshold && !isDead) {
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
    if (map[row] && map[row][col] === 4) map[row][col] = 0;
  }
  // ゴールドゴール
  if (tileAtBody === 17) {
    scoa += 2000;
    const col = Math.floor(bodyX / TILE_SIZE);
    const row = Math.floor(bodyY / TILE_SIZE);
    if (map[row] && map[row][col] === 17) map[row][col] = 0;
  }

  // 土と草の変換処理（0.5秒間に一度）
  if (!window.groundDirtTimer) window.groundDirtTimer = 0;
  window.groundDirtTimer++;
  if (window.groundDirtTimer >= 30) { // 60fps * 0.5秒 = 30フレーム
    for (let r = 0; r < map.length; r++) {
      for (let c = 0; c < map[0].length; c++) {
        if (map[r][c] === 1 && r > 0 && map[r-1][c] !== 0) {
          // スコアをゲットできるブロック、チェックポイント、スポーン地点、動く敵は除外
          const tileAbove = map[r-1][c];
          if (tileAbove !== 4 && tileAbove !== 15 && tileAbove !== 16 && tileAbove !== 17 && tileAbove !== 10 && tileAbove !== 3) {
            map[r][c] = 2; // groundの上に何かあればdirtに変換
          }
        }
        if (map[r][c] === 2 && (r === 0 || map[r-1][c] === 0)) {
          map[r][c] = 1; // dirtの上に何もなければgroundに変換
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
  cameraX += (player.x + player.width / 2 - cameraX - canvas.width / (2 * window.dynamicScale)) * window.cameraSpeed;
  cameraY += (player.y + player.height / 2 - cameraY - canvas.height / (2 * window.dynamicScale)) * window.cameraSpeed;
  // カメラ制限
  cameraX = Math.max(0, Math.min(cameraX, map[0].length * TILE_SIZE - canvas.width / window.dynamicScale));
  cameraY = Math.max(0, Math.min(cameraY, map.length * TILE_SIZE - canvas.height / window.dynamicScale));
}

// 描画
function draw() {
  ctx.setTransform(window.dynamicScale, 0, 0, window.dynamicScale, -cameraX * window.dynamicScale, -cameraY * window.dynamicScale);
  ctx.clearRect(cameraX, cameraY, canvas.width / window.dynamicScale, canvas.height / window.dynamicScale);
  ctx.fillStyle = "#aee";
  ctx.fillRect(cameraX, cameraY, canvas.width / window.dynamicScale, canvas.height / window.dynamicScale);
  // まずレールだけ描画
  for (let row = 0; row < map.length; row++) {
    for (let col = 0; col < map[0].length; col++) {
      const tile = map[row][col];
      const x = col * TILE_SIZE;
      const y = row * TILE_SIZE;
      if (tile === 12) ctx.drawImage(rail1Img, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 13) {
        const left = col > 0 && map[row][col-1] >= 12 && map[row][col-1] <= 14;
        if (left) ctx.drawImage(rail2Img, x, y, TILE_SIZE, TILE_SIZE);
        else {
          ctx.save();
          ctx.translate(x + TILE_SIZE, y);
          ctx.scale(-1, 1);
          ctx.drawImage(rail2Img, 0, 0, TILE_SIZE, TILE_SIZE);
          ctx.restore();
        }
      } else if (tile === 14) ctx.drawImage(rail3Img, x, y, TILE_SIZE, TILE_SIZE);
    }
  }
  // 落下中の壊れるブロック描画
  if (window.fallingBreaks) {
    for (const fb of window.fallingBreaks) {
      ctx.save();
      if (fb.fading) ctx.globalAlpha = Math.max(0, fb.alpha);
      ctx.drawImage(breakableImg, fb.col * TILE_SIZE, fb.y, TILE_SIZE, TILE_SIZE);
      ctx.globalAlpha = 1.0;
      ctx.restore();
    }
  }
  // 次に他のタイルを描画
  for (let row = 0; row < map.length; row++) {
    for (let col = 0; col < map[0].length; col++) {
      const tile = map[row][col];
      const x = col * TILE_SIZE;
      const y = row * TILE_SIZE;
      if (tile === 1) ctx.drawImage(groundImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 2) ctx.drawImage(dirtImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 3) ctx.drawImage(enemyImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 4) ctx.drawImage(goalImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 5) ctx.drawImage(stoneImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 6) ctx.drawImage(poisonImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 7) ctx.drawImage(trampolineImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 8) ctx.drawImage(ladderImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 11) ctx.drawImage(breakableImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 15) ctx.drawImage(coinImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 16) ctx.drawImage(checkpointImg, x, y, TILE_SIZE, TILE_SIZE);
      else if (tile === 17) ctx.drawImage(goldgoalImg, x, y, TILE_SIZE, TILE_SIZE);
    }
  }
  drawEnemies();
  if (!deathFrozen) {
    animator.draw(ctx, player.x, player.y, player.width, player.height, isMoving, facingLeft, !player.onGround);
  }
  if (useFallDeathScreen) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(deathScreenFallImg, 0, 0, canvas.width, canvas.height);
  } else if (showDeathScreen) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(deathScreenImg, 0, 0, canvas.width, canvas.height);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 20px Arial";
  ctx.fillText(`SCORE: ${scoa}`, canvas.width - 160, 30);
}

function gameLoop() {
  update();
  draw();
  requestAnimationFrame(gameLoop);
}

Promise.all([
  new Promise(resolve => groundImg.onload = resolve),
  new Promise(resolve => dirtImg.onload = resolve),
  new Promise(resolve => enemyImg.onload = resolve),
  new Promise(resolve => goalImg.onload = resolve),
  new Promise(resolve => stoneImg.onload = resolve),
  new Promise(resolve => poisonImg.onload = resolve),
  new Promise(resolve => trampolineImg.onload = resolve),
  new Promise(resolve => ladderImg.onload = resolve),
  new Promise(resolve => enemyMoveImg1.onload = resolve),
  new Promise(resolve => enemyMoveImg2.onload = resolve),
  new Promise(resolve => breakblockImg.onload = resolve), // breakable block
  new Promise(resolve => rail1Img.onload = resolve),
  new Promise(resolve => rail2Img.onload = resolve),
  new Promise(resolve => rail3Img.onload = resolve),
  new Promise(resolve => coinImg.onload = resolve),
  new Promise(resolve => checkpointImg.onload = resolve),
  new Promise(resolve => goldgoalImg.onload = resolve),
]).then(() => {
  gameLoop();
});

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

// --- サムネイル保存ボタンを削除 ---
const oldThumbBtn = document.getElementById('saveThumbBtn');
if (oldThumbBtn) oldThumbBtn.remove();

const homeBtn = document.getElementById("backHomeBtn");
if (homeBtn) {
  homeBtn.onclick = () => {
    location.href = "home.html";
  };
}
