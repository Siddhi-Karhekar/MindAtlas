"""End-to-end proof that difficulty adapts ACROSS attempts, not just within one.

Two students work through the same subject and the same test. One answers
everything wrong, the other answers everything right. The assertion is that
their SECOND attempt opens at a different difficulty from each other and from
the first attempt's medium start - which can only happen if the first
attempt's results were carried forward.

Runs against the API directly (no browser) so the difficulty tier of each
served question can be inspected. Start the server first:  cd server && npm run dev
"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = os.environ.get("MINDATLAS_API", "http://localhost:4000/api").rstrip("/")

NOTES = [
    ("Atomic structure",
     "An atom consists of a nucleus containing protons and neutrons, surrounded by electrons in "
     "shells. The number of protons determines the atomic number and defines the element. Isotopes "
     "of an element have the same number of protons but a different number of neutrons."),
    ("Chemical bonding",
     "Ionic bonds form when electrons are transferred between atoms, creating oppositely charged "
     "ions that attract each other. Covalent bonds form when atoms share electron pairs. Metallic "
     "bonding involves a lattice of positive ions surrounded by a sea of delocalized electrons."),
    ("Periodic table",
     "Elements in the periodic table are arranged by atomic number. Elements in the same group "
     "share the same number of electrons in their outer shells, which determines their bonding "
     "behaviour and their chemical reactivity."),
]

failures = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  -> {detail}" if detail else ""))
    if not cond:
        failures.append(label)


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def setup_student(tag):
    """Register a student, add the notes, build one test. Returns (token, subjectId, testId)."""
    email = f"{tag}-{int(time.time() * 1000)}@example.com"
    status, d = call("POST", "/auth/register", {"email": email, "password": "password123"})
    assert status == 201, d
    token = d["token"]
    subject_id = call("POST", "/subjects", {"name": "Chemistry"}, token)[1]["subject"]["_id"]
    note_ids = [
        call("POST", f"/subjects/{subject_id}/notes", {"title": t, "content": c}, token)[1]["note"]["_id"]
        for t, c in NOTES
    ]
    status, d = call("POST", f"/subjects/{subject_id}/tests", {
        "title": "Chem quiz", "noteIds": note_ids, "mcqCount": 4, "theoryCount": 1,
        "marksPerQuestion": 2, "durationMinutes": 10,
    }, token)
    assert status == 201, d
    return token, subject_id, d["test"]["_id"]


def take_attempt(token, test_id, answer_correctly):
    """Work through one whole attempt. Returns (opening_tier, tiers_seen, feedback)."""
    status, d = call("POST", f"/tests/{test_id}/attempts", token=token)
    assert status == 200 or status == 201, d
    attempt_id = d["attempt"]["_id"]
    opening_tier = d["attempt"]["currentDifficulty"]
    question = d["question"]
    tiers = []

    # Answer keys are never sent to the client mid-attempt, so to answer
    # "correctly" we read the test's builder view, which only the owner can see.
    keys = {}
    for q in call("GET", f"/tests/{test_id}", token=token)[1]["questions"]:
        keys[str(q["_id"])] = q.get("answerKey")

    while question:
        tiers.append(question.get("difficulty"))
        if question["type"] == "theory":
            answer = keys.get(str(question["_id"])) or "electrons protons neutrons nucleus shells"
            if not answer_correctly:
                answer = "no idea"
        else:
            correct = keys.get(str(question["_id"]))
            if answer_correctly:
                answer = correct
            else:
                wrong = [o for o in question["options"] if o != correct]
                answer = wrong[0] if wrong else question["options"][0]
        status, r = call("POST", f"/attempts/{attempt_id}/responses", {
            "questionId": question["_id"], "answer": answer, "timeMs": 1500,
        }, token)
        assert status == 200, r
        question = r["nextQuestion"]

    status, d = call("POST", f"/attempts/{attempt_id}/submit", token=token)
    assert status == 200, d
    return opening_tier, tiers, d["feedback"]


print("\n=== Setting up two students on identical material ===")
weak_token, weak_subject, weak_test = setup_student("weak")
strong_token, strong_subject, strong_test = setup_student("strong")
print("  both registered, notes added, test built")

print("\n=== Attempt 1 — no history, so both should open at medium ===")
weak_open_1, weak_tiers_1, weak_fb_1 = take_attempt(weak_token, weak_test, answer_correctly=False)
strong_open_1, strong_tiers_1, strong_fb_1 = take_attempt(strong_token, strong_test, answer_correctly=True)
check("struggling student opens attempt 1 at medium", weak_open_1 == "medium", weak_open_1)
check("strong student opens attempt 1 at medium", strong_open_1 == "medium", strong_open_1)
check("first-attempt feedback makes no progress claim",
      "moved from" not in weak_fb_1["feedbackText"] and "slipped from" not in weak_fb_1["feedbackText"])

print("\n=== Mastery was recorded ===")
weak_prog = call("GET", f"/subjects/{weak_subject}/progress", token=weak_token)[1]
strong_prog = call("GET", f"/subjects/{strong_subject}/progress", token=strong_token)[1]
check("mastery rows exist after one attempt", len(weak_prog["topics"]) > 0, f"{len(weak_prog['topics'])} topics")
weak_mean = sum(t["pKnown"] for t in weak_prog["topics"]) / len(weak_prog["topics"])
strong_mean = sum(t["pKnown"] for t in strong_prog["topics"]) / len(strong_prog["topics"])
check("wrong answers produced lower mastery than right ones", weak_mean < strong_mean,
      f"weak {weak_mean:.3f} vs strong {strong_mean:.3f}")
check("attempt history is recorded", len(weak_prog["history"]) == 1, f"{len(weak_prog['history'])} attempts")
check("weakest topics are recommended", len(weak_prog["recommendedTopicIds"]) > 0)

print("\n=== Attempt 2 — the same test, now seeded by attempt 1 ===")
weak_open_2, weak_tiers_2, weak_fb_2 = take_attempt(weak_token, weak_test, answer_correctly=False)
strong_open_2, strong_tiers_2, strong_fb_2 = take_attempt(strong_token, strong_test, answer_correctly=True)
print(f"  struggling student: attempt 1 opened {weak_open_1}, attempt 2 opened {weak_open_2}")
print(f"  strong student:     attempt 1 opened {strong_open_1}, attempt 2 opened {strong_open_2}")

check("struggling student now opens EASIER than medium", weak_open_2 == "easy", weak_open_2)
check("strong student now opens HARDER than medium", strong_open_2 == "hard", strong_open_2)
check("the two students no longer get the same opening difficulty", weak_open_2 != strong_open_2,
      f"{weak_open_2} vs {strong_open_2}")
check("second-attempt feedback references movement across attempts",
      "moved from" in strong_fb_2["feedbackText"] or "slipped from" in weak_fb_2["feedbackText"],
      strong_fb_2["feedbackText"][:90])

print("\n=== Progress view after two attempts ===")
weak_prog2 = call("GET", f"/subjects/{weak_subject}/progress", token=weak_token)[1]
check("history now shows two attempts", len(weak_prog2["history"]) == 2, f"{len(weak_prog2['history'])}")
trended = [t for t in weak_prog2["topics"] if len(t["trend"]) >= 2]
check("at least one topic has a plottable trend", len(trended) > 0, f"{len(trended)} topics with 2+ points")
check("topics are returned weakest-first",
      all(weak_prog2["topics"][i]["pKnown"] <= weak_prog2["topics"][i + 1]["pKnown"]
          for i in range(len(weak_prog2["topics"]) - 1)))

print(f"\n{'All checks passed.' if not failures else str(len(failures)) + ' FAILING CHECK(S): ' + ', '.join(failures)}")
raise SystemExit(0 if not failures else 1)
