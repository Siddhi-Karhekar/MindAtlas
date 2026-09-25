"""Long-document upload -> subtopic notes -> subtopic-level test feedback, through the UI.

Uploads a multi-section lecture deck (verify/fixtures/os_unit3.pptx by default;
set SPLIT_FILE to try your own PDF / DOCX / PPTX) and checks that:
  1. the upload screen previews the detected subtopics before saving,
  2. the document is saved as a parent note with one child note per subtopic,
  3. the knowledge graph shows the document and its subtopics,
  4. a test built from the whole document is scored per SUBTOPIC, and the
     results page breaks the document down subtopic by subtopic.
Regenerate the fixtures with:  cd verify/fixtures && python make_fixtures.py
"""
import os
import time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("MINDATLAS_URL", "http://localhost:5173").rstrip("/")
FILE = os.environ.get("SPLIT_FILE", os.path.join(HERE, "fixtures", "os_unit3.pptx"))
shot = lambda page, name: page.screenshot(path=os.path.join(HERE, name), full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1360, "height": 900})
    page.goto(f"{BASE}/sign-in")
    page.click("text=Create a personal library")
    page.fill('input[type="email"]', f"split-{int(time.time())}@example.com")
    page.fill('input[type="password"]', "password123")
    page.click('button:has-text("Create your account")')
    page.wait_for_url(f"{BASE}/", timeout=10000)
    page.fill('input[placeholder="e.g. Neuroscience"]', "Operating Systems")
    page.click('button:has-text("New subject")')
    page.wait_for_url("**/subjects/*", timeout=10000)

    # 1. preview
    page.click('button:has-text("New Record")')
    page.click('button:has-text("Upload Notes")')
    page.wait_for_url("**/new?mode=upload", timeout=10000)
    page.set_input_files('[data-testid="note-file-input"]', FILE)
    page.wait_for_selector('[data-testid="split-preview"]', timeout=20000)
    preview = page.inner_text('[data-testid="split-preview"]')
    assert "subtopics" in preview, preview
    print("preview OK:", preview.splitlines()[0])
    shot(page, "30_split_preview.png")

    # 2. save -> parent + children
    page.click('button:has-text("Add note")')
    page.wait_for_url("**/subjects/*?note=*", timeout=30000)
    page.wait_for_selector('[data-testid="document-subtopics"]', timeout=10000)
    body = page.inner_text("body")
    assert "split into" in body.lower(), "success banner should mention the split"
    subtopics = page.locator('[data-testid="subtopic-item"]').count()
    assert subtopics >= 2, f"expected subtopics in the shelf, got {subtopics}"
    print(f"saved as a document with {subtopics} subtopics")
    shot(page, "31_document_overview.png")
    page.locator('[data-testid="subtopic-item"]').nth(1).click()
    page.wait_for_selector('[data-testid="subtopic-breadcrumb"]', timeout=5000)
    assert "Subtopic 2 of" in page.inner_text('[data-testid="subtopic-breadcrumb"]')
    shot(page, "32_subtopic_view.png")

    # 3. graph
    page.click('a:has-text("Graph view")')
    page.wait_for_url("**/graph", timeout=10000)
    page.wait_for_selector('[data-node-kind="document"]', timeout=10000)
    assert page.locator('[data-testid="graph-node"]').count() == subtopics + 1
    page.locator('[data-node-kind="document"]').first.dispatch_event("pointerdown", {"button": 0, "pointerId": 1, "clientX": 0, "clientY": 0})
    page.locator('[data-testid="graph-viewport"]').dispatch_event("pointerup", {"pointerId": 1})
    page.wait_for_selector('[data-testid="inspector-subtopics"]', timeout=5000)
    shot(page, "33_graph_document.png")

    # 4. test from the whole document, scored per subtopic
    page.goto(page.url.replace("/graph", "/tests"))
    page.wait_for_selector('[data-testid="test-doc"]', timeout=10000)
    page.fill('input[placeholder="Test title, e.g. Neuro quiz 1"]', "Unit 3 check")
    page.locator('[data-testid="test-doc"] label').first.click()
    page.fill("#mcq-count", "6")
    page.fill("#theory-count", "0")
    page.locator('[data-testid="test-doc"]').first.screenshot(path=os.path.join(HERE, "34_test_builder_document.png"))
    page.click('button:has-text("Build test")')
    page.wait_for_selector("text=adaptively picks", timeout=30000)
    page.click('a:has-text("Take test")')
    page.wait_for_url("**/attempt", timeout=10000)
    page.wait_for_timeout(500)
    for i in range(10):
        page.locator("button.w-full.text-left").first.click()
        page.wait_for_timeout(120)
        btn = page.locator('button:has-text("Next question"), button:has-text("Submit test")').first
        label = btn.inner_text()
        btn.click()
        page.wait_for_timeout(400)
        if "Submit" in label:
            break
    page.wait_for_url("**/feedback", timeout=15000)
    page.wait_for_selector('[data-testid="document-breakdown"]', timeout=10000)
    scores = page.locator('[data-testid="subtopic-score"]').count()
    assert scores >= 2, f"expected per-subtopic scores, got {scores}"
    assert "in " in page.inner_text('[data-testid="topic-rank"] >> nth=0'), "topic ranking should name the document"
    assert "**" not in page.inner_text("body")
    print(f"results break the document into {scores} subtopic scores")
    shot(page, "35_subtopic_feedback.png")
    page.locator('[data-testid="document-breakdown"]').screenshot(path=os.path.join(HERE, "36_subtopic_breakdown.png"))
    browser.close()
    print("DOCUMENT SPLIT E2E PASS")
