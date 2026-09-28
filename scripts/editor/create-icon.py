"""Regenerate the Windows icon that matches static/img/favicon.svg.

Run from the repository root with ``python scripts/editor/create-icon.py``.
Pillow is only needed when the icon is regenerated, not when the Runner runs.
"""
from pathlib import Path

from PIL import Image, ImageDraw


HERE = Path(__file__).resolve().parent
SCALE = 8
S = lambda value: round(value * SCALE)
image = Image.new("RGBA", (S(64), S(64)), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((S(3), S(3), S(61), S(61)), radius=S(15), fill="#005AA9")
draw.polygon([(S(19), S(12)), (S(41), S(12)), (S(48), S(19)),
              (S(48), S(53)), (S(19), S(53))], fill="white")
draw.polygon([(S(41), S(12)), (S(41), S(20)), (S(48), S(20))], fill="#DCEAF6")
for y, end in ((28, 41), (34, 41), (40, 36)):
    draw.line((S(26), S(y), S(end), S(y)), fill="#005AA9", width=S(3))
draw.line((S(26), S(48), S(40), S(48)), fill="#A51C30", width=S(4))
draw.ellipse((S(43), S(46), S(48), S(51)), fill="#D29F3C")
target = HERE / "static" / "img" / "latex-runner.ico"
image.save(target, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(target)
