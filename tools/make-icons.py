# Draws the app icons in icons/ (needs Pillow: pip install pillow).
#   python tools/make-icons.py
from pathlib import Path
from PIL import Image, ImageDraw

BLUE = (31, 122, 224)
DARK = (13, 79, 163)
SKY = (137, 194, 255)
WHITE = (255, 255, 255)
out = Path(__file__).resolve().parent.parent / 'icons'
out.mkdir(exist_ok=True)


def draw(size, padding=0.0, rounded=False):
    s = size * 4  # draw large, then shrink for smooth edges
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0) if rounded else BLUE + (255,))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BLUE)
    # artwork lives in a 100x100 box, shrunk by `padding` for maskable icons
    scale = s * (1 - 2 * padding) / 100
    off = s * padding
    box = lambda x, y, w, h: [off + x * scale, off + y * scale, off + (x + w) * scale, off + (y + h) * scale]
    # back card (tilted look), front card, lines
    d.rounded_rectangle(box(26, 22, 56, 40), radius=8 * scale, fill=SKY)
    d.rounded_rectangle(box(18, 32, 56, 40), radius=8 * scale, fill=WHITE)
    d.rounded_rectangle(box(26, 41, 40, 6), radius=3 * scale, fill=BLUE)
    d.rounded_rectangle(box(26, 53, 28, 6), radius=3 * scale, fill=SKY)
    return img.resize((size, size), Image.LANCZOS)


draw(180, 0.06).convert('RGB').save(out / 'apple-touch-icon.png')
draw(192, 0.0, rounded=True).save(out / 'icon-192.png')
draw(512, 0.0, rounded=True).save(out / 'icon-512.png')
draw(512, 0.14).convert('RGB').save(out / 'icon-maskable-512.png')
print('icons written to', out)
