import os
import time
from playwright.sync_api import sync_playwright

# Screenshots are written next to this script; point the test at a different
# frontend with e.g.  MINDATLAS_URL=http://localhost:4173 python <script>
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("MINDATLAS_URL", "http://localhost:5173").rstrip("/")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})

    page.goto(f"{BASE}/sign-in")
    page.click("text=Create a personal library")
    email = f"mixed-test-{int(time.time())}@example.com"
    page.fill('input[type="email"]', email)
    page.fill('input[type="password"]', "password123")
    page.click('button:has-text("Create your account")')
    page.wait_for_url(f"{BASE}/", timeout=10000)

    page.fill('input[placeholder="e.g. Neuroscience"]', "Botany")
    page.click('button:has-text("New subject")')
    # creating a subject drops you straight into its workspace
    page.wait_for_url("**/subjects/*", timeout=10000)

    def add_note(title, content):
        # Workspace -> New Record -> Typed Note opens the full-page editor
        page.click('button:has-text("New Record")')
        page.click('button:has-text("Typed Note")')
        page.wait_for_url("**/new", timeout=10000)
        page.fill('input[aria-label="Note title"]', title)
        page.fill('textarea[aria-label="Note body"]', content)
        page.click('button:has-text("Save note")')
        # saving returns to the workspace with the new note selected
        page.wait_for_url("**/subjects/*?note=*", timeout=10000)
        page.wait_for_timeout(300)

    add_note(
        "Photosynthesis",
        "Photosynthesis is the process by which plants convert light energy into chemical energy. "
        "Chlorophyll in the chloroplasts absorbs sunlight. The process produces glucose and releases "
        "oxygen as a byproduct.",
    )
    add_note(
        "Cell Respiration",
        "Cellular respiration breaks down glucose to release energy stored as ATP. It occurs in the "
        "mitochondria. Unlike photosynthesis, respiration consumes oxygen and releases carbon dioxide.",
    )

    page.get_by_role("link", name="Tests", exact=True).first.click()
    page.wait_for_url("**/tests", timeout=10000)
    page.wait_for_timeout(300)

    page.fill('input[placeholder="Test title, e.g. Neuro quiz 1"]', "Mixed Quiz")
    page.click('label:has(span:text-is("Photosynthesis"))')
    page.click('label:has(span:text-is("Cell Respiration"))')
    # steppers: #mcq-count, #theory-count, #marks, #duration
    page.fill("#mcq-count", "2")
    page.fill("#theory-count", "2")
    page.click('button:has-text("Build test")')
    page.wait_for_timeout(1200)
    page.screenshot(path=os.path.join(HERE, "10_mixed_test_built.png"), full_page=True)

    # sanity check the result line mentions both generation paths
    body_text = page.inner_text("body")
    assert "MCQs via" in body_text, "MCQ generation summary missing"
    assert "Theory via" in body_text, "Theory generation summary missing"
    print("build summary line OK:", [l for l in body_text.splitlines() if "via" in l])

    page.click('a:has-text("Take test")')
    page.wait_for_url("**/attempt", timeout=10000)
    page.wait_for_timeout(500)

    for i in range(6):
        next_btn = page.locator('button:has-text("Next question"), button:has-text("Submit test")')
        if next_btn.count() == 0:
            break

        is_theory = page.locator("text=Theory").count() > 0
        page.screenshot(path=os.path.join(HERE, f"11_attempt_q{i+1}_{'theory' if is_theory else 'mcq'}.png"))

        if is_theory:
            page.fill("textarea", "This explains the key process described in the note, including the main terms.")
        else:
            page.locator('button.w-full.text-left').first.click()

        page.wait_for_timeout(150)
        btn = page.locator('button:has-text("Next question"), button:has-text("Submit test")').first
        label = btn.inner_text()
        btn.click()
        page.wait_for_timeout(600)
        if "Submit" in label:
            break

    page.wait_for_url("**/feedback", timeout=10000)
    page.wait_for_timeout(500)
    page.screenshot(path=os.path.join(HERE, "12_mixed_feedback.png"), full_page=True)

    body_text = page.inner_text("body")
    assert "marks" in body_text.lower(), "marks summary missing from feedback page"
    print("feedback page OK, contains marks summary")

    assert "**" not in page.inner_text("body"), "raw **markdown** leaked onto the results page"

    browser.close()
    print("done")
