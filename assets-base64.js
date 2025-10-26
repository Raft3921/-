// 自動生成: assetsフォルダ内の画像をURLマニフェストに登録
(function () {
  const basePath = "assets/";
  const assetFiles = [
    "breakblock.png",
    "checkpoint.png",
    "clear.png",
    "coin.png",
    "color.png",
    "color1.png",
    "color10.png",
    "color2.png",
    "color3.png",
    "color4.png",
    "color5.png",
    "color6.png",
    "color7.png",
    "color8.png",
    "color9.png",
    "death.gif",
    "death_screen.png",
    "death_screen_fall.png",
    "dirt.png",
    "dummy.png",
    "enemy-move1.png",
    "enemy-move2.png",
    "enemy.png",
    "eraser.png",
    "goal.png",
    "goldgoal.png",
    "ground.png",
    "hand.png",
    "ladder.png",
    "mai-jump1.png",
    "mai-jump2.png",
    "mai-run1.png",
    "mai-run2.png",
    "mai.png",
    "player-jump1.png",
    "player-jump2.png",
    "player-run1.png",
    "player-run2.png",
    "player.png",
    "poison.png",
    "rail1.png",
    "rail2.png",
    "rail3.png",
    "spawn.png",
    "stone.png",
    "tanutsuna-jump1.png",
    "tanutsuna-jump2.png",
    "tanutsuna-run1.png",
    "tanutsuna-run2.png",
    "tanutsuna.png",
    "trampoline.png",
  ];

  const manifest = {};
  for (const file of assetFiles) {
    manifest[file] = basePath + file;
  }

  window.ASSETS_BASE64 = manifest;
  window.getAssetURL = function getAssetURL(name) {
    if (!name) return "";
    if (manifest[name]) return manifest[name];
    if (/^https?:|^data:/.test(name)) return name;
    return basePath + name;
  };
})();
