const slotsContainer = document.getElementById("slots");
const createBtn = document.getElementById("createWorld");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const pageInfo = document.getElementById("pageInfo");
const importBtn = document.getElementById("importWorldBtn");
const importInput = document.getElementById("importWorldInput");


// キャラクター選択の読み込みと保存
function loadCharacterSelection() {
  const settings = JSON.parse(localStorage.getItem('gameSettings') || '{}');
  const selectedCharacter = settings.character || 'raft';
  
  // ラジオボタンを設定
  const radioButton = document.querySelector(`input[name="homeCharacter"][value="${selectedCharacter}"]`);
  if (radioButton) {
    radioButton.checked = true;
  }
}

function saveCharacterSelection() {
  const selectedRadio = document.querySelector('input[name="homeCharacter"]:checked');
  if (selectedRadio) {
    const settings = JSON.parse(localStorage.getItem('gameSettings') || '{}');
    settings.character = selectedRadio.value;
    localStorage.setItem('gameSettings', JSON.stringify(settings));
  }
}

// キャラクター選択のイベントリスナー
document.querySelectorAll('input[name="homeCharacter"]').forEach(radio => {
  radio.addEventListener('change', saveCharacterSelection);
});

let currentPage = 0;
const slotsPerPage = 15;

function resolveAssetPath(name) {
  if (!name) return "";
  if (/^https?:|^data:|^assets\//.test(name)) return name;
  if (typeof window.getAssetURL === 'function') {
    return window.getAssetURL(name);
  }
  if (window.ASSETS_BASE64 && window.ASSETS_BASE64[name]) {
    return window.ASSETS_BASE64[name];
  }
  return `assets/${name}`;
}

const thumbImageCache = {};
let thumbRefreshScheduled = false;

function scheduleThumbRefresh() {
  if (thumbRefreshScheduled) return;
  thumbRefreshScheduled = true;
  requestAnimationFrame(() => {
    thumbRefreshScheduled = false;
    loadSlots();
  });
}

function getThumbImage(name) {
  if (!name) return null;
  const resolved = resolveAssetPath(name);
  if (!thumbImageCache[resolved]) {
    const img = new Image();
    if (typeof location === 'undefined' || location.protocol !== 'file:') {
      img.crossOrigin = "anonymous";
    }
    const finalize = () => {
      img.onload = null;
      img.onerror = null;
      scheduleThumbRefresh();
    };
    img.onload = finalize;
    img.onerror = finalize;
    img.src = resolved;
    thumbImageCache[resolved] = img;
  }
  return thumbImageCache[resolved];
}

function getThumbTileValue(data, absRow, absCol) {
  if (!data) return 0;
  if (Array.isArray(data.map)) {
    if (typeof data.offsetRow === 'number' && typeof data.offsetCol === 'number') {
      const localRow = absRow - data.offsetRow;
      const localCol = absCol - data.offsetCol;
      if (localRow >= 0 && localCol >= 0 && localRow < data.map.length) {
        const rowArr = data.map[localRow];
        if (Array.isArray(rowArr) && localCol < rowArr.length) {
          const value = rowArr[localCol];
          return Number.isFinite(value) ? value : Number(value) || 0;
        }
      }
      return 0;
    }
    const rowArr = data.map[absRow];
    if (Array.isArray(rowArr)) {
      const value = rowArr[absCol];
      return Number.isFinite(value) ? value : Number(value) || 0;
    }
  }
  return 0;
}

function getThumbOverlayValue(data, absRow, absCol) {
  if (!data || !data.dummyOverlays) return undefined;
  const key = `${absRow},${absCol}`;
  const raw = data.dummyOverlays[key];
  if (raw === undefined) return undefined;
  return Number.isFinite(raw) ? raw : Number(raw);
}

function showConfirm(text, onYes, onNo) {
  let old = document.getElementById("confirmDialog");
  if (old) old.remove();
  const dialog = document.createElement("div");
  dialog.id = "confirmDialog";
  dialog.style.position = "fixed";
  dialog.style.top = "50%";
  dialog.style.left = "50%";
  dialog.style.transform = "translate(-50%,-50%)";
  dialog.style.background = "#fff";
  dialog.style.color = "#1a2a4f";
  dialog.style.padding = "24px 32px";
  dialog.style.borderRadius = "18px";
  dialog.style.boxShadow = "0 6px 20px rgba(0,0,0,0.15)";
  dialog.style.zIndex = "99999";
  dialog.style.fontWeight = "bold";
  dialog.style.fontFamily = "\"Yu Gothic\", sans-serif";
  dialog.innerHTML = `
    <div style="margin-bottom:18px;font-size:18px;text-align:center;">${text}</div>
    <div style="display:flex;gap:24px;justify-content:center;">
      <button id="yesBtn" style="padding:10px 32px;border:none;border-radius:12px;background:#22335b;color:#fff;font-size:16px;font-weight:bold;cursor:pointer;box-shadow:0 1px 4px #22335b;">はい</button>
      <button id="noBtn" style="padding:10px 32px;border:none;border-radius:12px;background:#ccc;color:#1a2a4f;font-size:16px;font-weight:bold;cursor:pointer;">いいえ</button>
    </div>
  `;
  document.body.appendChild(dialog);
  document.getElementById("yesBtn").onclick = () => {
    dialog.remove();
    if (onYes) onYes();
  };
  document.getElementById("noBtn").onclick = () => {
    dialog.remove();
    if (onNo) onNo();
  };
}

function getWorldSlots() {
  return JSON.parse(localStorage.getItem("worldSlots") || "[]");
}
function saveWorldSlots(slots) {
  localStorage.setItem("worldSlots", JSON.stringify(slots));
}
function getUniqueWorldName(baseName) {
  const slots = getWorldSlots();
  let name = baseName;
  let i = 1;
  while (slots.includes(name)) {
    name = `${baseName}(${i})`;
    i++;
  }
  return name;
}

function loadSlots() {
  let slots = getWorldSlots();
  // オブジェクト型スロットを除外
  slots = slots.filter(s => typeof s === 'string');
  saveWorldSlots(slots);
  slotsContainer.innerHTML = "";
  console.log("[スロットリスト]", slots);
  const totalPages = Math.max(1, Math.ceil(slots.length / slotsPerPage));
  const startIndex = currentPage * slotsPerPage;
  const endIndex = Math.min(startIndex + slotsPerPage, slots.length);
  for (let i = startIndex; i < endIndex; i++) {
    const slotIndex = i;
    const worldName = String(slots[slotIndex]);
    const div = document.createElement("div");
    div.className = "slot";

    // 並び替え用の上下ボタン
    const moveControls = document.createElement('div');
    moveControls.className = 'slot-move-controls';
    const upBtn = document.createElement('button');
    upBtn.className = 'slot-move-up';
    upBtn.textContent = '▲';
    upBtn.title = '上へ移動';
    upBtn.disabled = slotIndex === 0;
    upBtn.onclick = () => {
      if (slotIndex === 0) return;
      const slots = getWorldSlots();
      const moved = slots.splice(slotIndex, 1)[0];
      const newIndex = slotIndex - 1;
      slots.splice(newIndex, 0, moved);
      saveWorldSlots(slots);
      currentPage = Math.max(0, Math.floor(newIndex / slotsPerPage));
      loadSlots();
    };

    const downBtn = document.createElement('button');
    downBtn.className = 'slot-move-down';
    downBtn.textContent = '▼';
    downBtn.title = '下へ移動';
    downBtn.disabled = slotIndex === slots.length - 1;
    downBtn.onclick = () => {
      const slots = getWorldSlots();
      if (slotIndex >= slots.length - 1) return;
      const moved = slots.splice(slotIndex, 1)[0];
      const newIndex = slotIndex + 1;
      slots.splice(newIndex, 0, moved);
      saveWorldSlots(slots);
      const maxPage = Math.max(0, Math.ceil(slots.length / slotsPerPage) - 1);
      currentPage = Math.min(maxPage, Math.floor(newIndex / slotsPerPage));
      loadSlots();
    };

    moveControls.appendChild(upBtn);
    moveControls.appendChild(downBtn);
    div.appendChild(moveControls);

    // サムネイル画像
    const thumbDataStr = localStorage.getItem("thumbdata_" + worldName);
    if (thumbDataStr) {
      // サムネイル用canvasを生成
      const thumbData = JSON.parse(thumbDataStr);
      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = 256;
      thumbCanvas.height = 160;
      thumbCanvas.className = "slot-thumbnail";
      const tctx = thumbCanvas.getContext("2d");
      // 1タイル=32pxで8x5タイル分を表示
      const tileW = 32;
      const tileH = 32;
      const viewCols = 8;
      const viewRows = 5;
      // スポーン地点（タイルID 10）を探す
      let spawnCol = 0, spawnRow = 0, found = false;
      for (let r = 0; r < thumbData.map.length; r++) {
        for (let c = 0; c < thumbData.map[0].length; c++) {
          if (thumbData.map[r][c] === 10) {
            spawnRow = r;
            spawnCol = c;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      // スポーン地点中心に8x5タイルを切り出す
      let startCol = Math.max(0, spawnCol - Math.floor(viewCols / 2));
      let startRow = Math.max(0, spawnRow - Math.floor(viewRows / 2));
      // はみ出し補正
      if (startCol + viewCols > thumbData.map[0].length) startCol = thumbData.map[0].length - viewCols;
      if (startRow + viewRows > thumbData.map.length) startRow = thumbData.map.length - viewRows;
      startCol = Math.max(0, startCol);
      startRow = Math.max(0, startRow);
      // 画像リストを用意
      const tileImages = {
        1: "ground.png",
        2: "dirt.png",
        3: "enemy.png",
        4: "goal.png",
        5: "stone.png",
        6: "poison.png",
        7: "trampoline.png",
        8: "ladder.png",
        9: "enemy-move1.png",
        10: "spawn.png",
        11: "breakblock.png",
        12: "rail1.png",
        13: "rail2.png",
        14: "rail3.png",
        15: "coin.png",
        16: "checkpoint.png",
        17: "goldgoal.png",
        19: "dummy.png"
      };
      
      // 色ブロック用の画像を追加（ID 20-30）
      tileImages[20] = "color.png";
      tileImages[21] = "color1.png";
      tileImages[22] = "color2.png";
      tileImages[23] = "color3.png";
      tileImages[24] = "color4.png";
      tileImages[25] = "color5.png";
      tileImages[26] = "color6.png";
      tileImages[27] = "color7.png";
      tileImages[28] = "color8.png";
      tileImages[29] = "color9.png";
      tileImages[30] = "color10.png";
      // まず背景を空色で塗る
      tctx.fillStyle = "#aee";
      tctx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
      // 画像キャッシュ
      let hasBlock = false;
      for (let r = 0; r < viewRows; r++) {
        for (let c = 0; c < viewCols; c++) {
          const mapR = startRow + r;
          const mapC = startCol + c;
          let tile = getThumbTileValue(thumbData, mapR, mapC);
          // ダミーブロックは元の見た目で描画
          if (tile === 19) {
            const overlayTile = getThumbOverlayValue(thumbData, mapR, mapC);
            if (overlayTile !== undefined) {
              tile = overlayTile;
            }
          }
          const assetKey = tileImages[tile];
          if (assetKey) {
            const img = getThumbImage(assetKey);
            if (img && img.complete && img.naturalWidth > 0) {
              tctx.drawImage(img, c * tileW, r * tileH, tileW, tileH);
              hasBlock = true;
            }
          } else if (tile !== 0) {
            hasBlock = true;
          }
        }
      }
      // 何もブロックがなければ空色で塗る
      if (!hasBlock) {
        tctx.fillStyle = "#aee";
        tctx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
      }
      div.appendChild(thumbCanvas);
    } else {
      // 旧サムネイル画像またはデフォルト
    const thumbUrl = localStorage.getItem("thumb_" + worldName);
    let src;
    if (thumbUrl && thumbUrl.startsWith("data:image/")) {
      src = thumbUrl; // data URLはそのまま
    } else if (thumbUrl) {
      src = thumbUrl + "?t=" + Date.now(); // 通常URLのみキャッシュバスター
    } else {
      src = "assets/ground.png";
    }
    const thumbImg = document.createElement("img");
    thumbImg.className = "slot-thumbnail";
    thumbImg.src = src;
    thumbImg.onerror = function() { this.src = "assets/ground.png"; };
    div.appendChild(thumbImg);
    }

    const contentDiv = document.createElement("div");
    contentDiv.className = "slot-content";

    const input = document.createElement("input");
    input.value = worldName;
    input.id = "world-name-" + worldName;
    input.name = "world-name";
    input.onchange = () => {
      let newName = input.value.trim();
      if (!newName) {
        input.value = worldName;
        return;
      }
      if (newName !== worldName) {
        newName = getUniqueWorldName(newName);
        // データの移動
        const data = localStorage.getItem("world_" + worldName);
        if (data) {
          localStorage.setItem("world_" + newName, data);
          localStorage.removeItem("world_" + worldName);
        }
        // サムネイルも移動
        const thumb = localStorage.getItem("thumb_" + worldName);
        if (thumb) {
          localStorage.setItem("thumb_" + newName, thumb);
          localStorage.removeItem("thumb_" + worldName);
        }
        const thumbData = localStorage.getItem("thumbdata_" + worldName);
        if (thumbData) {
          localStorage.setItem("thumbdata_" + newName, thumbData);
          localStorage.removeItem("thumbdata_" + worldName);
        }
        // スロット名の更新
        const slots = getWorldSlots();
        slots[i] = String(newName);
        saveWorldSlots(slots);
        input.value = newName;
        loadSlots();
      }
    };

    const playBtn = document.createElement("button");
    playBtn.textContent = "\u25B6"; // ▶
    playBtn.style.fontSize = "32px";
    playBtn.style.width = "48px";
    playBtn.style.height = "48px";
    playBtn.style.padding = "0";
    playBtn.onclick = () => {
      localStorage.setItem("currentSlot", worldName);
      location.href = `index.html?slot=${encodeURIComponent(worldName)}`;
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "編集";
    editBtn.onclick = () => {
      localStorage.setItem("currentSlot", worldName);
      location.href = `editor.html?slot=${encodeURIComponent(worldName)}`;
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.onclick = () => {
      showConfirm("このワールドを削除しますか？", () => {
        // データ削除
        localStorage.removeItem("world_" + worldName);
        localStorage.removeItem("thumb_" + worldName);
        localStorage.removeItem("thumbdata_" + worldName);
        // スロットリストから削除
        const slots = getWorldSlots();
        slots.splice(i, 1);
        saveWorldSlots(slots);
        // ページ調整
        const newTotalPages = Math.max(1, Math.ceil(slots.length / slotsPerPage));
        if (currentPage >= newTotalPages) {
          currentPage = Math.max(0, newTotalPages - 1);
        }
        loadSlots();
        updateNavigation();
      }, () => {});
    };

    // ボタンをslot-buttonsでまとめて横並び
    const buttonsDiv = document.createElement("div");
    buttonsDiv.className = "slot-buttons";
    buttonsDiv.appendChild(playBtn);
    buttonsDiv.appendChild(editBtn);
    buttonsDiv.appendChild(delBtn);

    contentDiv.appendChild(input);
    contentDiv.appendChild(buttonsDiv);
    div.appendChild(contentDiv);
    slotsContainer.appendChild(div);
  }
  updateNavigation();
}

function updateNavigation() {
  const slots = getWorldSlots();
  const totalPages = Math.max(1, Math.ceil(slots.length / slotsPerPage));
  prevBtn.disabled = currentPage === 0;
  nextBtn.disabled = currentPage >= totalPages - 1;
  pageInfo.textContent = `${currentPage + 1} / ${totalPages}`;
}

// ナビゲーションボタンのイベント
prevBtn.onclick = () => {
  if (currentPage > 0) {
    currentPage--;
    loadSlots();
  }
};
nextBtn.onclick = () => {
  const slots = getWorldSlots();
  const totalPages = Math.max(1, Math.ceil(slots.length / slotsPerPage));
  if (currentPage < totalPages - 1) {
    currentPage++;
    loadSlots();
  }
};

createBtn.onclick = () => {
  let slots = getWorldSlots();
  let baseName = "新しいワールド";
  let name = getUniqueWorldName(baseName);
  slots.push(String(name));
  saveWorldSlots(slots);
  // 新しいワールドのデータも空で作成
  localStorage.setItem("world_" + name, JSON.stringify({}));
  // 新しいスロットが作成されたら最後のページに移動
  const totalPages = Math.max(1, Math.ceil(slots.length / slotsPerPage));
  currentPage = totalPages - 1;
  loadSlots();
};

function importWorldData(parsed, fallbackName) {
  const mapArray = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.map) ? parsed.map : null);
  if (!mapArray) {
    return;
  }

  const baseNameSource = (parsed && typeof parsed.name === 'string' && parsed.name.trim()) || fallbackName || "インポート";
  const baseName = baseNameSource.replace(/\.[^.]+$/, '').trim() || "インポート";
  const worldName = getUniqueWorldName(baseName);
  const slots = getWorldSlots();
  slots.push(worldName);
  saveWorldSlots(slots);

  let dataToSave;
  if (Array.isArray(parsed)) {
    dataToSave = { map: parsed };
  } else {
    dataToSave = Object.assign({}, parsed);
    dataToSave.map = mapArray;
  }
  dataToSave.name = worldName;

  localStorage.setItem("world_" + worldName, JSON.stringify(dataToSave));
  localStorage.setItem("currentSlot", worldName);

  const totalPages = Math.max(1, Math.ceil(slots.length / slotsPerPage));
  currentPage = totalPages - 1;
  return worldName;
}

if (importBtn && importInput) {
  importBtn.onclick = () => {
    importInput.click();
  };
  importInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const processNext = (index) => {
      if (index >= files.length) {
        importInput.value = "";
        loadSlots();
        return;
      }
      const file = files[index];
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          importWorldData(parsed, file.name);
        } catch (error) {
          console.error("Import error:", error);
        } finally {
          processNext(index + 1);
        }
      };
      reader.readAsText(file, "utf-8");
    };

    processNext(0);
  });
}

// 設定ボタン
const settingsBtn = document.getElementById("settingsBtn");
if (settingsBtn) {
  settingsBtn.onclick = () => {
    location.href = "settings.html";
  };
}

loadSlots();
loadCharacterSelection();

// キャラクターアニメーション機能
const homeCharacterAnimations = {
  raft: {
    idle: new Image(),
    run1: new Image(),
    run2: new Image()
  },
  mai: {
    idle: new Image(),
    run1: new Image(),
    run2: new Image()
  },
  tanutsuna: {
    idle: new Image(),
    run1: new Image(),
    run2: new Image()
  }
};

// 画像読み込み
homeCharacterAnimations.raft.idle.src = "assets/player.png";
homeCharacterAnimations.raft.run1.src = "assets/player-run1.png";
homeCharacterAnimations.raft.run2.src = "assets/player-run2.png";

homeCharacterAnimations.mai.idle.src = "assets/mai.png";
homeCharacterAnimations.mai.run1.src = "assets/mai-run1.png";
homeCharacterAnimations.mai.run2.src = "assets/mai-run2.png";

homeCharacterAnimations.tanutsuna.idle.src = "assets/tanutsuna.png";
homeCharacterAnimations.tanutsuna.run1.src = "assets/tanutsuna-run1.png";
homeCharacterAnimations.tanutsuna.run2.src = "assets/tanutsuna-run2.png";

// アニメーション状態
let homeAnimationFrame = 0;

// キャラクターアニメーション描画
function drawHomeCharacterAnimation(canvasId, characterName) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const images = homeCharacterAnimations[characterName];
  
  if (!images) return;
  
  // キャンバスをクリア
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // 走りアニメーション（2フレーム）
  const frame = Math.floor(homeAnimationFrame / 10) % 2;
  const img = frame === 0 ? images.run1 : images.run2;
  
  if (img.complete && img.naturalWidth > 0) {
    // 64x64に拡大描画
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
}

// アニメーション更新
function updateHomeAnimations() {
  homeAnimationFrame++;
  
  // 各キャラクターのアニメーションを描画
  drawHomeCharacterAnimation('homeRaftCanvas', 'raft');
  drawHomeCharacterAnimation('homeMaiCanvas', 'mai');
  drawHomeCharacterAnimation('homeTanutsunaCanvas', 'tanutsuna');
  
  requestAnimationFrame(updateHomeAnimations);
}

// アニメーション開始
updateHomeAnimations();
