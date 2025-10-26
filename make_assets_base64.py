import os

ASSETS_DIR = "assets"
OUTPUT_JS = "assets-base64.js"

def main():
    asset_files = []
    for fname in sorted(os.listdir(ASSETS_DIR)):
        fpath = os.path.join(ASSETS_DIR, fname)
        if not os.path.isfile(fpath):
            continue
        if fname.startswith('.'):
            continue
        asset_files.append(fname)

    with open(OUTPUT_JS, "w", encoding="utf-8") as out:
        out.write("// 自動生成: assetsフォルダ内の画像をURLマニフェストに登録\n")
        out.write("(function () {\n")
        out.write('  const basePath = "assets/";\n')
        out.write("  const assetFiles = [\n")
        for fname in asset_files:
            out.write(f'    "{fname}",\n')
        out.write("  ];\n\n")
        out.write("  const manifest = {};\n")
        out.write("  for (const file of assetFiles) {\n")
        out.write("    manifest[file] = basePath + file;\n")
        out.write("  }\n\n")
        out.write("  window.ASSETS_BASE64 = manifest;\n")
        out.write("  window.getAssetURL = function getAssetURL(name) {\n")
        out.write("    if (!name) return \"\";\n")
        out.write("    if (manifest[name]) return manifest[name];\n")
        out.write("    if (/^https?:|^data:/.test(name)) return name;\n")
        out.write("    return basePath + name;\n")
        out.write("  };\n")
        out.write("})();\n")
    print(f"Done! -> {OUTPUT_JS}")

if __name__ == "__main__":
    main()
