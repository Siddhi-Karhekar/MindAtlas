import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { timeAgo, wordCount } from "../lib/format.js";
import Icon from "../components/Icon.jsx";
import { isTopicNote, noteTree } from "../lib/notes.js";

// One selectable row in "Draw questions from these notes". Used for plain
// notes, split documents (checkbox selects all their subtopics, `partial` when
// only some are picked) and, indented, for individual subtopics.
function NoteRow({ note, on, partial = false, onToggle, mastery, subtitle, words, trailing, compact = false }) {
  const pct = mastery ? Math.round(mastery.pKnown * 100) : null;
  return (
    <label
      className={`group flex items-center justify-between ${compact ? "px-space-md py-space-sm" : "p-space-md"} rounded-lg bg-surface-container-low hover:bg-surface-container transition-all cursor-pointer ${on || partial ? "" : "opacity-70 hover:opacity-100"}`}
    >
      <div className="flex items-center gap-space-md min-w-0">
        <div
          className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${
            on || partial ? "bg-primary text-on-primary" : "bg-surface-container-highest text-transparent"
          }`}
        >
          <Icon name={partial ? "remove" : "check"} className="text-xs" />
        </div>
        <input type="checkbox" className="hidden" checked={on} onChange={onToggle} />
        <div className="flex flex-col min-w-0">
          <span className={`${compact ? "font-ui-body text-ui-body" : "font-ui-title text-ui-title"} text-on-surface truncate`}>{note.title}</span>
          <span className="font-body-sm text-body-sm text-on-surface-variant truncate">
            {subtitle ?? (note.keywords?.slice(0, 5).join(" · ") || note.rawText.slice(0, 80))}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-space-md shrink-0">
        {!compact && (
          <div className="hidden sm:flex flex-col items-end">
            <span className="font-label-sm text-label-sm text-on-surface-variant">Added</span>
            <span className="font-label-md text-label-md text-on-surface">{timeAgo(note.createdAt)}</span>
          </div>
        )}
        {mastery && (
          <div
            title={mastery.partial ? `Average mastery, ${mastery.partial}` : `${pct}% mastery from ${mastery.observations} answered`}
            className={`px-space-sm py-space-2xs rounded font-label-md text-label-md font-semibold ${
              mastery.pKnown < 0.5 ? "bg-tertiary-container text-on-tertiary-container" : "bg-secondary-container text-on-secondary-container"
            }`}
          >
            {pct}% mastery
          </div>
        )}
        <div className="px-space-sm py-space-2xs rounded bg-surface-container-highest font-label-md text-label-md text-primary">
          {words ?? wordCount(note.rawText)} words
        </div>
        {trailing}
      </div>
    </label>
  );
}

function Stepper({ label, icon, value, onChange, min = 0, max = 99, unit, hint, id }) {
  const set = (v) => onChange(Math.max(min, Math.min(max, Number.isFinite(v) ? v : min)));
  return (
    <div className="flex flex-col gap-space-sm p-space-md rounded-lg bg-surface-container-low">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="font-label-lg text-label-lg text-on-surface">{label}</label>
        <Icon name={icon} className="text-sm text-on-surface-variant" />
      </div>
      <div className="flex items-center justify-between pt-space-xs">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => set(value - 1)}
          className="w-8 h-8 rounded-lg bg-surface-container-highest hover:bg-surface-dim flex items-center justify-center text-on-surface transition-colors active:scale-95"
        >
          <Icon name="remove" className="text-sm" />
        </button>
        <div className="flex items-baseline gap-space-2xs">
          <input
            id={id}
            type="number"
            min={min}
            max={max}
            value={value}
            onChange={(e) => set(parseInt(e.target.value, 10))}
            className="w-14 text-center bg-transparent font-headline-md text-headline-md text-primary font-bold focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="font-ui-body text-ui-body text-on-surface-variant">{unit}</span>
        </div>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => set(value + 1)}
          className="w-8 h-8 rounded-lg bg-surface-container-highest hover:bg-surface-dim flex items-center justify-center text-on-surface transition-colors active:scale-95"
        >
          <Icon name="add" className="text-sm" />
        </button>
      </div>
      {hint && <p className="font-body-sm text-body-sm text-on-surface-variant pt-space-xs text-center">{hint}</p>}
    </div>
  );
}

const MIXES = [
  { key: "mcq", title: "Rapid MCQ", body: "Only multiple choice, for quick retrieval practice." },
  { key: "balanced", title: "Balanced Hybrid", body: "About 60% multiple choice, 40% written theory answers." },
  { key: "theory", title: "Deep Theory", body: "Only written answers that ask you to explain in your own words." },
];

export default function Tests() {
  const { subjectId } = useParams();
  const [subject, setSubject] = useState(null);
  const [notes, setNotes] = useState(null);
  const [tests, setTests] = useState(null);
  const [progress, setProgress] = useState(null);
  const [title, setTitle] = useState("");
  // Always TOPIC note ids: plain notes and individual subtopics. Selecting a
  // whole document selects all of its subtopics.
  const [selectedNoteIds, setSelectedNoteIds] = useState([]);
  const [expandedDocs, setExpandedDocs] = useState([]);
  const [mcqCount, setMcqCount] = useState(4);
  const [theoryCount, setTheoryCount] = useState(0);
  const [marksPerQuestion, setMarksPerQuestion] = useState(2);
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.listNotes(subjectId).then((d) => setNotes(d.notes)).catch((e) => setError(e.message));
    api.listTests(subjectId).then((d) => setTests(d.tests)).catch((e) => setError(e.message));
    // Mastery drives both the suggestion below and, server-side, which notes the
    // generated pool leans toward. Failing to load it is not fatal.
    api.getProgress(subjectId).then(setProgress).catch(() => setProgress(null));
  }

  useEffect(() => {
    refresh();
    api.listSubjects().then((d) => setSubject(d.subjects.find((s) => String(s._id) === String(subjectId)) || null)).catch(() => {});
  }, [subjectId]);

  const total = mcqCount + theoryCount;
  const mix = theoryCount === 0 ? "mcq" : mcqCount === 0 ? "theory" : "balanced";

  function applyMix(key) {
    const n = Math.max(1, total);
    if (key === "mcq") {
      setMcqCount(n);
      setTheoryCount(0);
    } else if (key === "theory") {
      setMcqCount(0);
      setTheoryCount(n);
    } else {
      const m = Math.max(1, Math.round(n * 0.6));
      setMcqCount(m);
      setTheoryCount(Math.max(1, n - m));
    }
  }

  function toggleNote(id) {
    setSelectedNoteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleDoc(childIds, select) {
    setSelectedNoteIds((prev) => (select ? [...new Set([...prev, ...childIds])] : prev.filter((x) => !childIds.includes(x))));
  }

  const tree = useMemo(() => noteTree(notes), [notes]);
  const topicNotes = useMemo(() => (notes || []).filter(isTopicNote), [notes]);

  const masteryByTopic = useMemo(() => new Map((progress?.topics || []).map((t) => [String(t.topicId), t])), [progress]);
  const weakest = (progress?.recommendedTopicIds || []).map((id) => masteryByTopic.get(String(id))).filter(Boolean);

  const selectedNotes = useMemo(() => topicNotes.filter((n) => selectedNoteIds.includes(n._id)), [topicNotes, selectedNoteIds]);
  const selectedWords = selectedNotes.reduce((n, x) => n + wordCount(x.rawText), 0);

  async function handleBuild(e) {
    e.preventDefault();
    setError("");
    setResult(null);
    if (!title.trim()) return setError("title is required");
    if (selectedNoteIds.length === 0) return setError("pick at least one note to build the test from");
    if (total < 1) return setError("pick at least 1 MCQ or theory question");
    if (total > 20) return setError("a test can have at most 20 questions in total");

    setBusy(true);
    try {
      const data = await api.createTest(subjectId, {
        title: title.trim(),
        noteIds: selectedNoteIds,
        mcqCount,
        theoryCount,
        marksPerQuestion,
        durationMinutes,
      });
      setResult(data);
      setTitle("");
      setSelectedNoteIds([]);
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const step = (n) => (
    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-on-primary font-label-sm text-label-sm">{n}</span>
  );

  return (
    <div className="flex flex-col w-full">
      <form onSubmit={handleBuild} className="flex flex-col gap-space-2xl pb-space-xl max-w-7xl mx-auto w-full">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md pt-space-xs">
          <div className="flex flex-col gap-space-2xs">
            <div className="flex items-center gap-space-xs text-on-surface-variant font-label-md text-label-md tracking-wider uppercase">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-secondary"></span>
              <span>Adaptive Evaluation</span>
              <span className="text-outline-variant">/</span>
              <Link to={`/subjects/${subjectId}`} className="hover:text-primary">{subject?.name || "Subject"}</Link>
            </div>
            <h1 className="font-headline-lg text-headline-lg text-primary tracking-tight">Compose Knowledge Test</h1>
            <p className="font-body-md text-body-md text-on-surface-variant max-w-2xl">
              Build an assessment straight from your own notes. Questions are generated from the text you pick, and each
              attempt adapts its difficulty to how you answer.
            </p>
          </div>
          <div className="flex items-center gap-space-sm self-start md:self-auto">
            <div className="flex items-center gap-space-xs px-space-md py-space-xs rounded-lg bg-surface-container-high text-on-surface font-label-md text-label-md shadow-sm">
              <Icon name="database" className="text-sm text-secondary" />
              <span>
                Note Pool: {notes ? tree.top.length : "…"} {tree.top.length === 1 ? "note" : "notes"}
                {notes && topicNotes.length !== tree.top.length ? ` · ${topicNotes.length} topics` : ""}
              </span>
            </div>
            <Link
              to={`/subjects/${subjectId}/progress`}
              className="flex items-center gap-space-xs px-space-md py-space-xs rounded-lg bg-surface-container-high text-primary hover:bg-surface-container-highest font-label-md text-label-md shadow-sm transition-colors"
            >
              <Icon name="lightbulb" className="text-sm" />
              <span>Progress</span>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-start">
          <div className="lg:col-span-8 flex flex-col gap-space-xl">
            {/* 1 */}
            <div className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col gap-space-lg">
              <div className="flex items-center gap-space-sm">
                {step(1)}
                <h2 className="font-ui-title text-ui-title text-on-surface">Name your test</h2>
              </div>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Test title"
                placeholder="Test title, e.g. Neuro quiz 1"
                className="w-full h-11 px-space-base rounded-lg bg-surface-container-low text-on-surface font-ui-body text-ui-body placeholder:text-on-surface-variant/50 focus:outline-none focus:bg-surface focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {/* 2 */}
            <div className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col gap-space-lg">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs">
                <div className="flex items-center gap-space-sm">
                  {step(2)}
                  <h2 className="font-ui-title text-ui-title text-on-surface">Draw questions from these notes</h2>
                </div>
                <div className="flex items-center gap-space-sm flex-wrap">
                  {weakest.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="font-label-md text-label-md text-tertiary hover:underline"
                        onClick={() => setSelectedNoteIds(weakest.map((t) => t.topicId))}
                      >
                        Select my {weakest.length} weakest {weakest.length === 1 ? "topic" : "topics"}
                      </button>
                      <span className="text-outline-variant">|</span>
                    </>
                  )}
                  <button
                    type="button"
                    className="font-label-md text-label-md text-secondary hover:underline"
                    onClick={() => setSelectedNoteIds(selectedNoteIds.length === topicNotes.length ? [] : topicNotes.map((n) => n._id))}
                  >
                    {selectedNoteIds.length === topicNotes.length && selectedNoteIds.length > 0 ? "Clear selection" : "Select all"}
                  </button>
                  <span className="text-outline-variant">|</span>
                  <span className="font-label-md text-label-md text-on-surface-variant">{selectedNoteIds.length} selected</span>
                </div>
              </div>
              <div className="flex flex-col gap-space-sm">
                {notes === null && <p className="font-body-sm text-body-sm text-on-surface-variant">Loading notes…</p>}
                {notes && notes.length === 0 && (
                  <p className="font-body-md text-body-md text-on-surface-variant">
                    Add some notes to this subject first —{" "}
                    <Link to={`/subjects/${subjectId}/new`} className="text-secondary underline">write one now</Link>.
                  </p>
                )}
                {tree.top.map((n) => {
                  const kids = tree.childrenOf(n);
                  if (kids.length === 0) {
                    return (
                      <NoteRow
                        key={n._id}
                        note={n}
                        on={selectedNoteIds.includes(n._id)}
                        onToggle={() => toggleNote(n._id)}
                        mastery={masteryByTopic.get(String(n._id))}
                      />
                    );
                  }
                  const kidIds = kids.map((c) => c._id);
                  const picked = kidIds.filter((id) => selectedNoteIds.includes(id)).length;
                  const state = picked === 0 ? "none" : picked === kidIds.length ? "all" : "some";
                  const open = expandedDocs.includes(n._id) || state === "some";
                  const withData = kids.map((c) => masteryByTopic.get(String(c._id))).filter(Boolean);
                  const docMastery = withData.length
                    ? { pKnown: withData.reduce((a, m) => a + m.pKnown, 0) / withData.length, observations: withData.reduce((a, m) => a + m.observations, 0), partial: `${withData.length} of ${kids.length} subtopics tested` }
                    : null;
                  return (
                    <div key={n._id} className="flex flex-col gap-space-2xs" data-testid="test-doc">
                      <NoteRow
                        note={n}
                        on={state === "all"}
                        partial={state === "some"}
                        onToggle={() => toggleDoc(kidIds, state !== "all")}
                        mastery={docMastery}
                        subtitle={`${kids.length} subtopics${picked ? ` · ${picked} selected` : ""}`}
                        words={kids.reduce((a, c) => a + wordCount(c.rawText), 0)}
                        trailing={
                          <button
                            type="button"
                            aria-label={open ? `Hide subtopics of ${n.title}` : `Show subtopics of ${n.title}`}
                            onClick={(e) => {
                              e.preventDefault();
                              setExpandedDocs((prev) => (prev.includes(n._id) ? prev.filter((x) => x !== n._id) : [...prev, n._id]));
                            }}
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high"
                          >
                            <Icon name={open ? "expand_less" : "expand_more"} className="text-base" />
                          </button>
                        }
                      />
                      {open && (
                        <div className="flex flex-col gap-space-2xs pl-space-lg ml-space-md border-l-2 border-secondary/30">
                          {kids.map((c) => (
                            <NoteRow
                              key={c._id}
                              compact
                              note={c}
                              on={selectedNoteIds.includes(c._id)}
                              onToggle={() => toggleNote(c._id)}
                              mastery={masteryByTopic.get(String(c._id))}
                              subtitle={c.sectionGroup || undefined}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3 */}
            <div className="bg-surface-container-lowest rounded-xl p-space-xl shadow-sm flex flex-col gap-space-xl">
              <div className="flex items-center gap-space-sm">
                {step(3)}
                <h2 className="font-ui-title text-ui-title text-on-surface">Time &amp; question mix</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-space-lg">
                <Stepper id="mcq-count" label="MCQ questions" icon="checklist" value={mcqCount} onChange={setMcqCount} min={0} max={20} unit="items" hint="Scored instantly when you answer" />
                <Stepper id="theory-count" label="Theory questions" icon="edit_note" value={theoryCount} onChange={setTheoryCount} min={0} max={20} unit="items" hint="Written answers, graded when you submit" />
                <Stepper id="marks" label="Marks per question" icon="grade" value={marksPerQuestion} onChange={setMarksPerQuestion} min={1} max={20} unit="marks" />
                <Stepper
                  id="duration"
                  label="Duration"
                  icon="timer"
                  value={durationMinutes}
                  onChange={setDurationMinutes}
                  min={1}
                  max={240}
                  unit="minutes"
                  hint={total > 0 ? `About ${(durationMinutes / total).toFixed(1)} min per question` : undefined}
                />
              </div>
              <div className="flex flex-col gap-space-sm">
                <span className="font-label-lg text-label-lg text-on-surface">Composition</span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm pt-space-2xs">
                  {MIXES.map((m) => {
                    const on = mix === m.key;
                    return (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => applyMix(m.key)}
                        className={`p-space-md rounded-lg text-left flex flex-col gap-space-2xs transition-all ${
                          on ? "bg-surface-container-high" : "bg-surface-container-low hover:bg-surface-container"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className={`font-ui-title text-ui-title text-on-surface ${on ? "font-semibold" : ""}`}>{m.title}</span>
                          <span className={`w-2 h-2 rounded-full ${on ? "bg-primary" : "bg-transparent"}`}></span>
                        </div>
                        <span className="font-body-sm text-body-sm text-on-surface-variant">{m.body}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Projection */}
          <div className="lg:col-span-4 lg:sticky lg:top-0 flex flex-col gap-space-lg">
            <div className="bg-surface-container-lowest rounded-xl p-space-xl shadow-md flex flex-col gap-space-lg">
              <div className="flex items-center justify-between pb-space-xs">
                <div className="flex flex-col">
                  <span className="font-label-sm text-label-sm uppercase tracking-widest text-secondary font-bold">Summary</span>
                  <h3 className="font-headline-sm text-headline-sm text-primary">Test Shape</h3>
                </div>
                <Icon name="insights" className="text-secondary text-xl" />
              </div>
              <div className="p-space-md rounded-lg bg-surface-container-low flex flex-col gap-space-sm">
                <div className="flex items-center justify-between text-on-surface-variant font-label-md text-label-md">
                  <span>Topics covered</span>
                  <span className="text-on-surface font-bold">
                    {selectedNoteIds.length} of {topicNotes.length}
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-surface-container-highest overflow-hidden">
                  <div
                    className="h-full bg-secondary rounded-full transition-all"
                    style={{ width: `${topicNotes.length ? (selectedNoteIds.length / topicNotes.length) * 100 : 0}%` }}
                  ></div>
                </div>
                <div className="flex justify-between font-body-sm text-body-sm text-on-surface-variant pt-space-2xs">
                  <span>{selectedWords.toLocaleString()} words of source text</span>
                </div>
              </div>
              <div className="flex flex-col gap-space-md py-space-xs">
                {[
                  { icon: "format_list_numbered", label: "Questions", value: `${total} (${mcqCount} MCQ · ${theoryCount} theory)` },
                  { icon: "grade", label: "Total marks", value: `${total * marksPerQuestion}` },
                  { icon: "schedule", label: "Time limit", value: `${durationMinutes} minutes` },
                ].map((row) => (
                  <div key={row.label} className="flex items-start gap-space-md">
                    <div className="p-space-xs rounded bg-surface-container text-secondary shrink-0 mt-0.5">
                      <Icon name={row.icon} className="text-sm" />
                    </div>
                    <div className="flex flex-col">
                      <span className="font-label-sm text-label-sm text-on-surface-variant uppercase">{row.label}</span>
                      <span className="font-ui-title text-ui-title text-on-surface">{row.value}</span>
                    </div>
                  </div>
                ))}
              </div>

              {error && (
                <p role="alert" className="font-body-sm text-body-sm text-error">
                  {error}
                </p>
              )}
              {result && (
                <div className="p-space-md rounded-lg bg-secondary-container/50 text-on-secondary-container font-body-sm text-body-sm flex flex-col gap-space-xs">
                  <span className="font-semibold">Test ready.</span>
                  <span>
                    Generated a pool of {result.accepted} question{result.accepted === 1 ? "" : "s"} grounded in your notes
                    {result.discarded > 0 ? ` (${result.discarded} discarded — not supported by the source text)` : ""}; each
                    attempt adaptively picks {result.deliverable} of them.
                  </span>
                  <span className="opacity-80">
                    {result.mcqGeneratedBy && result.mcqGeneratedBy !== "none"
                      ? `MCQs via ${result.mcqGeneratedBy === "llm" ? "LLM" : "rule-based fallback"}`
                      : ""}
                    {result.mcqGeneratedBy !== "none" && result.theoryGeneratedBy !== "none" ? " · " : ""}
                    {result.theoryGeneratedBy && result.theoryGeneratedBy !== "none"
                      ? `Theory via ${result.theoryGeneratedBy === "llm" ? "LLM" : "rule-based fallback"}`
                      : ""}
                  </span>
                </div>
              )}

              <div className="pt-space-xs flex flex-col gap-space-sm">
                <button
                  disabled={busy}
                  className="w-full py-space-md px-space-lg rounded-lg bg-primary text-on-primary hover:opacity-90 font-ui-title text-ui-title flex items-center justify-center gap-space-sm shadow-md transition-all active:scale-[0.99] group disabled:opacity-60"
                >
                  <span>{busy ? "Generating…" : "Build test"}</span>
                  {!busy && <Icon name="arrow_forward" className="text-base group-hover:translate-x-0.5 transition-transform" />}
                </button>
              </div>
            </div>

            <div className="p-space-lg rounded-xl bg-surface-container-low flex items-start gap-space-md">
              <Icon name="school" className="text-on-surface-variant text-base mt-0.5" />
              <div className="flex flex-col gap-space-2xs">
                <span className="font-label-md text-label-md text-on-surface font-semibold">Adaptive algorithm</span>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Get a question right and the next one is harder; miss one and it eases off, so the test homes in on what you
                  don&apos;t know yet.
                </p>
              </div>
            </div>
          </div>
        </div>
      </form>

      <section className="max-w-7xl mx-auto w-full mt-space-lg">
        <div className="flex items-baseline justify-between mb-space-md px-space-xs">
          <div className="flex items-center gap-space-sm">
            <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant font-bold">Your tests</span>
            <span className="text-outline-variant text-label-md font-body-sm">— {tests ? tests.length : "…"}</span>
          </div>
        </div>
        {tests && tests.length === 0 && (
          <p className="font-body-md text-body-md text-on-surface-variant px-space-xs">No tests yet — build one above.</p>
        )}
        <ul className="flex flex-col gap-space-sm">
          {(tests || []).map((t) => (
            <li
              key={t._id}
              className="flex items-center justify-between rounded-xl bg-surface-container-lowest shadow-sm hover:shadow-md transition-shadow p-space-lg"
            >
              <div className="flex items-center gap-space-md min-w-0">
                <span className="w-8 h-8 rounded-lg bg-surface-container-low flex items-center justify-center text-primary shrink-0">
                  <Icon name="fact_check" className="text-lg" />
                </span>
                <div className="min-w-0">
                  <div className="font-ui-title text-ui-title text-on-surface truncate">{t.title}</div>
                  <div className="font-label-md text-label-md text-on-surface-variant">
                    {t.targetQuestionCount ? `${t.targetQuestionCount} questions · ` : ""}
                    {t.durationMinutes} min · {t.marksPerQuestion} marks/question · created {timeAgo(t.createdAt)}
                  </div>
                </div>
              </div>
              <Link
                to={`/tests/${t._id}/attempt`}
                className="px-space-lg py-space-sm rounded-lg bg-primary text-on-primary font-ui-title text-ui-title shadow-sm hover:opacity-90 transition-all flex items-center gap-space-xs shrink-0"
              >
                <span>Take test</span>
                <Icon name="arrow_forward" className="text-base" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
