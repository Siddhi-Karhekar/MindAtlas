"""Uploads existing notes (md, txt, and optionally pdf/docx from UPLOAD_DIR) through the UI."""
import os
import tempfile
import time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("MINDATLAS_URL", "http://localhost:5173").rstrip("/")
UPLOAD_DIR = os.environ.get("UPLOAD_DIR")  # optional folder with extra .pdf/.docx samples

tmp = tempfile.mkdtemp()
md = os.path.join(tmp, "genetics_notes.md")
txt = os.path.join(tmp, "mitosis.txt")
bad = os.path.join(tmp, "junk.xyz")
open(md, "w").write("# Genetics\n\nGenes are segments of DNA that encode proteins. Alleles are variants of a gene. "
                    "Dominant alleles mask recessive alleles in heterozygous organisms.\n")
open(txt, "w").write("Mitosis is cell division producing two identical daughter cells. The phases are prophase, "
                     "metaphase, anaphase and telophase. DNA is replicated before mitosis begins.\n")
open(bad, "w").write("nope")
files = [md, txt]
if UPLOAD_DIR:
    for name in ("enzymes.docx", "membranes.pdf"):
        p = os.path.join(UPLOAD_DIR, name)
        if os.path.exists(p):
            files.append(p)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(f"{BASE}/sign-in")
    page.click("text=Create a personal library")
    page.fill('input[type="email"]', f"upload-test-{int(time.time())}@example.com")
    page.fill('input[type="password"]', "password123")
    page.click('button:has-text("Create your account")')
    page.wait_for_url(f"{BASE}/", timeout=10000)
    page.fill('input[placeholder="e.g. Neuroscience"]', "Biology")
    page.click('button:has-text("New subject")')
    page.wait_for_url("**/subjects/*", timeout=10000)

    page.click('button:has-text("New Record")')
    page.click('button:has-text("Upload Notes")')
    page.wait_for_url("**/new?mode=upload", timeout=10000)

    # an unsupported file is flagged and never sent
    page.set_input_files('[data-testid="note-file-input"]', [bad] + files)
    page.wait_for_selector('[data-testid="upload-list"] li')
    assert page.locator('[data-testid="upload-list"] li').count() == len(files) + 1
    assert "Unsupported type" in page.locator('[data-testid="upload-list"]').inner_text()
    page.screenshot(path=os.path.join(HERE, "20_upload_queue.png"))
    page.get_by_role("button", name="Remove junk.xyz").click()
    assert page.locator('[data-testid="upload-list"] li').count() == len(files)

    page.click(f'button:has-text("Add {len(files)} notes")')
    page.wait_for_url(f"{BASE}/subjects/*", timeout=30000)
    page.wait_for_selector("text=notes added")
    page.wait_for_timeout(500)
    page.screenshot(path=os.path.join(HERE, "21_upload_done.png"))
    body = page.inner_text("body")
    for t in ("genetics notes", "mitosis"):
        assert t in body, t
    assert f"curated folio ({len(files)})" in body.lower(), body[:400]
    page.get_by_text("mitosis", exact=False).first.click()
    page.wait_for_timeout(300)
    assert "Uploaded file" in page.inner_text("body")

    # single-file upload keeps the optional title and opens the new note
    page.click('button:has-text("New Record")')
    page.click('button:has-text("Upload Notes")')
    page.wait_for_url("**/new?mode=upload", timeout=10000)
    one = os.path.join(tmp, "osmosis.txt")
    open(one, "w").write("Osmosis is the diffusion of water across a semipermeable membrane toward higher solute concentration.")
    page.set_input_files('[data-testid="note-file-input"]', one)
    page.fill('input[aria-label="Note title"]', "Osmosis basics")
    page.click('button:has-text("Add note")')
    page.wait_for_url("**/subjects/*?note=*", timeout=15000)
    page.wait_for_selector("text=Osmosis basics", timeout=8000)
    page.screenshot(path=os.path.join(HERE, "22_upload_single.png"))
    print("UPLOAD E2E PASS")
    browser.close()
