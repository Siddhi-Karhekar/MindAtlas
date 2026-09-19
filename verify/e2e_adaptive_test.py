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
    email = f"adaptive-ui-{int(time.time())}@example.com"
    page.fill('input[type="email"]', email)
    page.fill('input[type="password"]', "password123")
    page.click('button:has-text("Create your account")')
    page.wait_for_url(f"{BASE}/", timeout=10000)

    page.fill('input[placeholder="e.g. Neuroscience"]', "Chemistry")
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
        "Atomic structure",
        "An atom consists of a nucleus containing protons and neutrons, surrounded by electrons in "
        "shells. The number of protons determines the atomic number and defines the element. Isotopes "
        "of an element have the same number of protons but a different number of neutrons.",
    )
    add_note(
        "Chemical bonding",
        "Ionic bonds form when electrons are transferred between atoms, creating oppositely charged "
        "ions that attract each other. Covalent bonds form when atoms share electron pairs. Metallic "
        "bonding involves a lattice of positive ions surrounded by a sea of delocalized electrons.",
    )

    page.get_by_role("link", name="Tests", exact=True).first.click()
    page.wait_for_url("**/tests", timeout=10000)
    page.wait_for_timeout(300)

    page.fill('input[placeholder="Test title, e.g. Neuro quiz 1"]', "Adaptive Chem Quiz")
    page.click('label:has(span:text-is("Atomic structure"))')
    page.click('label:has(span:text-is("Chemical bonding"))')
    page.fill("#mcq-count", "3")
    page.fill("#theory-count", "1")
    page.click('button:has-text("Build test")')
    page.wait_for_timeout(1200)
    page.screenshot(path=os.path.join(HERE, "13_adaptive_test_built.png"), full_page=True)

    body_text = page.inner_text("body")
    assert "adaptively picks" in body_text, "adaptive pool/delivery summary line missing"
    print("build summary OK:", [l for l in body_text.splitlines() if "adaptively" in l])

    page.click('a:has-text("Take test")')
    page.wait_for_url("**/attempt", timeout=10000)
    page.wait_for_timeout(500)

    header_text = page.inner_text("body")
    assert "adaptive" in header_text.lower(), "'adaptive' label missing from attempt screen"

    for i in range(6):
        next_btn = page.locator('button:has-text("Next question"), button:has-text("Submit test")')
        if next_btn.count() == 0:
            break

        is_theory = page.locator("text=Theory").count() > 0
        page.screenshot(path=os.path.join(HERE, f"14_adaptive_q{i+1}.png"))

        if is_theory:
            page.fill("textarea", "Electrons protons neutrons nucleus shells bonding ions.")
        else:
            # always pick the first option -> mixed correctness, exercises both directions
            page.locator('button.w-full.text-left').first.click()

        page.wait_for_timeout(150)
        btn = page.locator('button:has-text("Next question"), button:has-text("Submit test")').first
        label = btn.inner_text()
        btn.click()
        page.wait_for_timeout(500)
        if "Submit" in label:
            break

    page.wait_for_url("**/feedback", timeout=10000)
    page.wait_for_timeout(500)
    page.screenshot(path=os.path.join(HERE, "15_adaptive_feedback.png"), full_page=True)

    assert "**" not in page.inner_text("body"), "raw **markdown** leaked onto the results page"

    browser.close()
    print("done")
