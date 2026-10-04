// Measures computed from the generated questions themselves, with no human in
// the loop. They are cheap and repeatable, and they are NOT a substitute for
// the human ratings: each says something narrow.
//
// Read them with their limits in mind (docs/EVALUATION.md spells these out):
//   - "partial term" uses the app's own key-term finder as the reference for
//     what a whole term is, so it favours the strategies built on it. The
//     raters' `whole_term` column is the independent measure.
//   - "off topic" needs hand-written labels (see readOffTopicLabels). Without
//     labels it is not reported at all, rather than guessed.

import { mean, rate, round } from "./stats.js";
import { blocksOf } from "../../src/services/studyText.js";
import { termKey, termPattern } from "../../src/services/keyTerms.js";

const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const clozeText = (q) => String(q.prompt || "").match(/^Fill in the blank:\s*["“]([\s\S]*)["”]\s*$/)?.[1] ?? null;

/**
 * Is this text part of a hand-labelled off-topic line? True when the text
 * contains a label, or a label contains the text. The second direction is for
 * lines the sentence splitter cuts up ("Prepared by Prof. A. B. Kulkarni for
 * ..." breaks after the initials): label the whole line and every piece of it
 * counts.
 */
export function isOffTopic(text, labels) {
  const t = norm(text);
  if (!t) return false;
  return labels.some((l) => {
    const label = norm(l);
    return label && (t.includes(label) || (words(t).length >= 2 && label.includes(t)));
  });
}

/**
 * True when the blank hides only part of a term: the answer sits inside a
 * longer key term of the note, and the sentence the question came from uses
 * that longer term ("computing" where the note's term is "distributed
 * computing"). `terms` are the note's reference key terms. Approximate: it
 * does not check that the blanked occurrence is the one inside the longer
 * term, so a sentence using both forms is counted.
 */
export function isPartialTerm(question, terms) {
  const answer = termKey(words(String(question.answerKey || "").toLowerCase()));
  if (!answer) return false;
  const size = words(answer).length;
  const sentence = String(question.supportingExcerpt || "");
  return terms.some((t) => t.words > size && ` ${t.key} `.includes(` ${answer} `) && termPattern(t.term, "i").test(sentence));
}

/**
 * All automatic measures for one strategy's questions.
 * `context`: { requested, termsByNote: Map(noteId -> reference terms),
 *              labelsByFile: Map(file name -> off-topic labels of that file) }
 * A question is only ever checked against the labels of its own document.
 */
export function automaticMetrics(questions, { requested, termsByNote = new Map(), labelsByFile = new Map() } = {}) {
  const accepted = questions.filter((q) => q.status === "accepted");
  const mcq = accepted.filter((q) => q.type === "mcq");
  const theory = accepted.filter((q) => q.type === "theory");
  const cloze = mcq.filter((q) => clozeText(q) !== null);

  const answerWords = mcq.map((q) => words(q.answerKey).length);
  const partial = cloze.filter((q) => isPartialTerm(q, termsByNote.get(String(q.topicId)) || []));
  const distractors = mcq.flatMap((q) => (q.options || []).filter((o) => o !== q.answerKey).map((o) => ({ q, o })));
  const placeholder = mcq.filter((q) => (q.options || []).some((o) => /related term \d+$/.test(o)));
  const duplicateOptions = mcq.filter((q) => new Set((q.options || []).map(norm)).size !== (q.options || []).length);
  const leaked = mcq.filter((q) => (q.options || []).some((o) => o !== q.answerKey && words(o).length && norm(clozeText(q) ?? "").includes(norm(o))));
  const answers = mcq.map((q) => norm(q.answerKey));
  const repeated = answers.length - new Set(answers).size;
  // an answer that can still be read in its own question
  const answerVisible = cloze.filter((q) => new RegExp(`(?<![A-Za-z0-9])${norm(q.answerKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(clozeText(q)));

  const command = (q) => String(q.prompt || "").trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, "");
  const commandWords = {};
  for (const q of theory) commandWords[command(q)] = (commandWords[command(q)] || 0) + 1;

  const out = {
    requested,
    produced: accepted.length,
    discarded: questions.length - accepted.length,
    yield: rate(accepted.length, requested),
    mcq: {
      count: mcq.length,
      multi_word_answer_rate: rate(answerWords.filter((n) => n >= 2).length, mcq.length),
      mean_answer_words: round(mean(answerWords), 2),
      partial_term_rate: rate(partial.length, cloze.length),
      answer_visible_in_question_rate: rate(answerVisible.length, cloze.length),
      repeated_answer_rate: rate(repeated, mcq.length),
      placeholder_option_rate: rate(placeholder.length, mcq.length),
      duplicate_option_rate: rate(duplicateOptions.length, mcq.length),
      option_shown_in_question_rate: rate(leaked.length, mcq.length),
      mean_option_length_gap_words: round(mean(distractors.map(({ q, o }) => Math.abs(words(o).length - words(q.answerKey).length))), 2),
    },
    theory: {
      count: theory.length,
      command_words: commandWords,
      distinct_command_words: Object.keys(commandWords).length,
      mentions_the_notes_rate: rate(theory.filter((q) => /\b(your|the) notes\b|in your own words/i.test(q.prompt)).length, theory.length),
      states_expected_length_rate: rate(theory.filter((q) => q.guidance).length, theory.length),
      mean_model_answer_words: round(mean(theory.map((q) => words(q.answerKey).length)), 1),
    },
  };
  // only the questions of documents that have labels can be judged at all
  const labelled = accepted.filter((q) => labelsByFile.get(q.file)?.length);
  if (labelled.length) {
    const off = labelled.filter((q) => {
      const labels = labelsByFile.get(q.file);
      return isOffTopic(q.supportingExcerpt, labels) || isOffTopic(clozeText(q) ?? "", labels);
    });
    out.off_topic = {
      questions_in_labelled_documents: labelled.length,
      questions_from_off_topic_text: off.length,
      off_topic_rate: rate(off.length, labelled.length),
      examples: off.slice(0, 5).map((q) => ({ file: q.file, type: q.type, prompt: q.prompt })),
    };
  }
  return out;
}

/** Every sentence of the note's paragraphs and list entries, before any filtering. */
export function allSentences(note) {
  const out = [];
  for (const b of blocksOf(note)) {
    if (b.type !== "para" && b.type !== "item") continue;
    const parts = String(b.text)
      .replace(/\s*\n\s*/g, " ")
      .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
      .map((x) => x.trim())
      .filter((x) => x.split(/\s+/).length >= 4);
    out.push(...(b.type === "item" && parts.length <= 1 ? [b.text.trim()] : parts));
  }
  return [...new Set(out)];
}

/**
 * How well a relevance gate separates subject matter from the rest, against
 * hand labels. "Positive" = off topic. `kept` is the set of sentence texts the
 * gate let through.
 *   precision: of the sentences it dropped, how many really were off topic
 *   recall:    of the off-topic sentences, how many it dropped
 *   subject_kept: of the real subject sentences, how many survived
 */
export function gateMetrics(sentences, kept, labels) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const s of sentences) {
    const off = isOffTopic(s, labels);
    const dropped = !kept.has(s);
    if (off && dropped) tp += 1;
    else if (!off && dropped) fp += 1;
    else if (off && !dropped) fn += 1;
    else tn += 1;
  }
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);
  return {
    sentences: sentences.length,
    off_topic: tp + fn,
    dropped: tp + fp,
    counts: { off_topic_dropped: tp, subject_dropped: fp, off_topic_kept: fn, subject_kept: tn },
    precision,
    recall,
    f1: precision && recall ? round((2 * precision * recall) / (precision + recall)) : precision === null || recall === null ? null : 0,
    subject_kept: rate(tn, tn + fp),
  };
}
