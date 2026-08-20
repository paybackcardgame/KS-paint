#!/usr/bin/env python3
"""Generate Magic Wand toolbox icons, cursor, help GIF, and SVG overlays."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

# 16x16 pixel art. . transparent, K black, Y yellow, W white, T tan, D dark tan, H highlight
PIXELS = [
	"................",
	".........K.K.K..",
	"..........KYK...",
	".........KYWYK..",
	"..........KYK...",
	".........K.KTK..",
	"........K.KTTK..",
	".......K.KTTK...",
	"......K.KTDK....",
	".....K.KTTK.....",
	"....K.KTTK......",
	"...K.KTTK.......",
	"..K.KTK.........",
	".K.KK...........",
	"..K.............",
	"................",
]

COLORS = {
	"K": (0, 0, 0, 255),
	"Y": (255, 220, 0, 255),
	"W": (255, 255, 255, 255),
	"T": (196, 128, 48, 255),
	"D": (140, 80, 24, 255),
	"H": (232, 180, 100, 255),
	".": (0, 0, 0, 0),
}


def render_icon(scale=1):
	w = 16 * scale
	h = 16 * scale
	im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
	px = im.load()
	for y, row in enumerate(PIXELS):
		for x, ch in enumerate(row):
			color = COLORS[ch]
			if color[3] == 0:
				continue
			for dy in range(scale):
				for dx in range(scale):
					px[x * scale + dx, y * scale + dy] = color
	return im


def paste_slot(path, xy, icon):
	path = ROOT / path
	if not path.exists():
		print(f"skip missing {path}")
		return
	im = Image.open(path).convert("RGBA")
	cleared = Image.new("RGBA", icon.size, (0, 0, 0, 0))
	im.paste(cleared, xy)
	im.paste(icon, xy, icon)
	im.save(path)
	print(f"patched {path} at {xy}")


def wand_svg_group():
	rects = []
	for y, row in enumerate(PIXELS):
		for x, ch in enumerate(row):
			color = COLORS[ch]
			if color[3] == 0:
				continue
			hex_color = f"#{color[0]:02x}{color[1]:02x}{color[2]:02x}"
			rects.append(
				f'  <rect x="{x}" y="{y}" width="1" height="1" style="fill:{hex_color};stroke:none"/>'
			)
	body = "\n".join(rects)
	return (
		'<g id="g-magic-wand" transform="translate(272,-16)" inkscape:label="Magic Wand">\n'
		f"{body}\n"
		"</g>"
	)


def inject_svg(path):
	path = ROOT / path
	if not path.exists():
		print(f"skip missing {path}")
		return
	text = path.read_text()
	text = text.replace(
		'style="display:inline"\n       style="display:none" inkscape:label="Airbrush"',
		'style="display:none" inkscape:label="Airbrush"',
	)
	if 'inkscape:label="Magic Wand"' in text:
		path.write_text(text)
		print(f"already has wand (styles cleaned): {path}")
		return
	if 'inkscape:label="Airbrush"' not in text:
		print(f"no Airbrush group: {path}")
		return
	# Hide every Airbrush-labeled group (keep original art, just not shown).
	text = text.replace(
		'inkscape:label="Airbrush"',
		'style="display:none" inkscape:label="Airbrush"',
		1,
	)
	group = wand_svg_group()
	# Insert wand immediately before the (now hidden) Airbrush group.
	needle = 'inkscape:label="Airbrush"'
	# Find the opening <g of that group by searching backwards from the label.
	idx = text.find(needle)
	g_start = text.rfind("<g", 0, idx)
	text = text[:g_start] + group + "\n    " + text[g_start:]
	path.write_text(text)
	print(f"injected wand SVG into {path}")


def main():
	icon = render_icon(1)
	cursor = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
	# Place 16x16 wand in top-left; hotspot is the star (~10, 3)
	cursor.paste(icon, (0, 0), icon)
	cursor.save(ROOT / "images/cursors/magic-wand.png")
	print("wrote images/cursors/magic-wand.png")

	icon.save(ROOT / "help/p_wand.png")
	print("wrote help/p_wand.png")

	# 16 tools × 16px
	for rel in [
		"images/classic/tools.png",
		"images/dark/tools.png",
		"images/modern/vista-tools.png",
		"images/occult/tools.png",
		"images/winter/tools.png",
	]:
		paste_slot(rel, (128, 0), icon)

	# SVG layout 528×48, icon-index 8 at (16*(8*2+1), 16) = (272, 16)
	for rel in [
		"images/classic/tools-spaced-for-svg.png",
		"images/dark/tools-spaced-for-svg.png",
		"images/modern/modern-dark-tools.png",
	]:
		paste_slot(rel, (272, 16), icon)

	for rel in [
		"images/classic/tools.svg",
		"images/dark/tools.svg",
		"images/modern/modern-light-tools.svg",
		"images/modern/modern-dark-tools.svg",
		"images/bubblegum/bubblegum-tools.svg",
		"images/occult/tools.svg",
	]:
		inject_svg(rel)


if __name__ == "__main__":
	main()
