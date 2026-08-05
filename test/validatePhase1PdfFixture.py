from pathlib import Path
import re

from PIL import Image, ImageChops
from pypdf import PdfReader

ROOT = Path(__file__).parent / "output"
PDF = ROOT / "phase1-inspection-report.pdf"
reader = PdfReader(PDF)
pages = [page.extract_text() or "" for page in reader.pages]
combined = "\n".join(pages)

assert len(pages) >= 4
assert combined.count("Powered by Fathom Tech") == len(pages)
assert combined.count("NexaPort Inspection Report") == len(pages)
assert "NexaPort Inspector" in combined
assert "Marina Name Dock/Pier Number" not in combined
assert "Date Inspector Name" not in combined
assert "2026-08-05T06:11:33.358Z" not in combined
assert "Bow access evidence" in combined and "Emergency equipment evidence" in combined
assert "Inspector Signature" not in combined  # image-only sign-off, never raw signature text
for index, page_text in enumerate(pages, 1):
    assert f"Page {index} of {len(pages)}" in page_text

pngs = sorted(ROOT.glob("phase1-page-*.png"), key=lambda path: int(re.search(r"(\d+)$", path.stem).group(1)))
assert len(pngs) == len(pages)
for png in pngs:
    image = Image.open(png).convert("RGB")
    bounds = ImageChops.difference(image, Image.new("RGB", image.size, "white")).getbbox()
    assert bounds is not None
    left, top, right, bottom = bounds
    assert left >= 30 and top >= 25
    assert right <= image.width - 30 and bottom <= image.height - 25

print(f"validated {len(pages)} PDF pages and {len(pngs)} rendered PNGs")
