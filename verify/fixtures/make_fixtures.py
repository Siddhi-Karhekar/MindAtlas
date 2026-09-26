from content import TITLE, SECTIONS
import docx
from pptx import Presentation
from pptx.util import Pt
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

# DOCX: Title style + Heading 1 + Heading 2
d = docx.Document()
d.add_heading(TITLE, level=0)
d.add_paragraph("Contents")
for h, subs in SECTIONS:
    d.add_heading(h, level=1)
    for sh, body in subs:
        d.add_heading(sh, level=2)
        d.add_paragraph(body)
d.save("os_unit3.docx")

# PPTX: cover + one slide per subsection; long ones split with (cont.)
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = TITLE; s.placeholders[1].text = "Lecture notes"
s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = "Agenda"; s.placeholders[1].text = "\n".join(h for h,_ in SECTIONS)
for h, subs in SECTIONS:
    for sh, body in subs:
        sent = body.split(". ")
        half = len(sent)//2
        for i, chunk in enumerate([". ".join(sent[:half]), ". ".join(sent[half:])]):
            s = p.slides.add_slide(p.slide_layouts[1])
            s.shapes.title.text = sh + (" (cont.)" if i else "")
            s.placeholders[1].text = chunk
s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = "Questions?"; s.placeholders[1].text = "Thank you"
p.save("os_unit3.pptx")

# PDF: typographic headings, running header + page numbers
c = canvas.Canvas("os_unit3.pdf", pagesize=A4)
W, H = A4
y = H - 60; page = 1
def header():
    c.setFont("Helvetica", 8); c.drawString(50, H - 30, "CS301 Operating Systems - Lecture Notes"); c.drawString(W/2, 25, str(page))
def need(h):
    global y, page
    if y - h < 50:
        c.showPage(); page += 1; header(); y = H - 60
header()
c.setFont("Helvetica-Bold", 22); c.drawString(50, y, TITLE); y -= 40
for h, subs in SECTIONS:
    need(60); c.setFont("Helvetica-Bold", 16); c.drawString(50, y, h); y -= 26
    for sh, body in subs:
        need(40); c.setFont("Helvetica-Bold", 13); c.drawString(50, y, sh); y -= 20
        c.setFont("Helvetica", 10.5)
        for line in simpleSplit(body, "Helvetica", 10.5, W - 100):
            need(14); c.setFont("Helvetica", 10.5); c.drawString(50, y, line); y -= 14
        y -= 10
c.save()

# long text, no headings
open("os_unit3_plain.txt","w").write("\n\n".join(b for _,subs in SECTIONS for _,b in subs) * 2)
# markdown
open("os_unit3.md","w").write(f"# {TITLE}\n\n" + "\n\n".join(f"## {h}\n\n" + "\n\n".join(f"### {sh}\n\n{b}" for sh,b in subs) for h,subs in SECTIONS))
print("done")
