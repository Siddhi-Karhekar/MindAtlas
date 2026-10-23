# Key-term evaluation

8 documents, 190 marked terms (labels: Key terms an examiner would expect a student to know from each document, marked from the text alone, before any system output was looked at. Written by an AI session on 23 Oct 2026). Run 2026-10-23.

## Question terms (test generation, top 16 per note)

| Condition | Precision (strict) | Recall (strict) | F1 (strict) | Precision (lenient) | Recall (lenient) |
| --- | --- | --- | --- | --- | --- |
| Before (concept-records branch) | 50% (99/199) | 52% | 0.51 | 64% | 72% |
| Rules, tagger off | 50% (101/201) | 53% | 0.52 | 66% | 75% |
| Rules + tagger | 51% (129/253) | 68% | 0.58 | 67% | 85% |
| Rules + tagger + syllabus | 51% (130/255) | 68% | 0.58 | 68% | 83% |

## Shown terms (reading pane, top 10 per note)

| Condition | Precision (strict) | Recall (strict) | F1 (strict) | Precision (lenient) | Recall (lenient) |
| --- | --- | --- | --- | --- | --- |
| Before (concept-records branch) | 76% (87/114) | 46% | 0.57 | 87% | 62% |
| Rules, tagger off | 81% (88/109) | 46% | 0.59 | 92% | 63% |
| Rules + tagger | 74% (115/155) | 61% | 0.67 | 84% | 77% |
| Rules + tagger + syllabus | 75% (116/154) | 61% | 0.67 | 86% | 77% |

## Keywords (TF-IDF, top 12 per note)

| Condition | Precision (strict) | Recall (strict) | F1 (strict) | Precision (lenient) | Recall (lenient) |
| --- | --- | --- | --- | --- | --- |
| Before (concept-records branch) | 14% (41/289) | 22% | 0.17 | 44% | 76% |
| Rules, tagger off | 14% (41/289) | 22% | 0.17 | 44% | 76% |
| Rules + tagger | 15% (42/276) | 22% | 0.18 | 51% | 81% |
| Rules + tagger + syllabus | 15% (42/276) | 22% | 0.18 | 51% | 81% |

## Per document (question terms, strict)

| Document | Before (concept-records branch) | Rules, tagger off | Rules + tagger | Rules + tagger + syllabus |
| --- | --- | --- | --- | --- |
| Electrical engineering | P 25% R 27% | P 36% R 33% | P 38% R 40% | P 38% R 40% |
| Engineering mathematics | P 56% R 42% | P 55% R 50% | P 60% R 75% | P 60% R 75% |
| Programming | P 38% R 50% | P 38% R 50% | P 31% R 42% | P 31% R 42% |
| Systems programming | P 56% R 38% | P 56% R 38% | P 56% R 38% | P 63% R 42% |
| Information and cyber security | P 58% R 68% | P 57% R 68% | P 57% R 87% | P 58% R 90% |
| Database management systems | P 61% R 65% | P 60% R 65% | P 48% R 74% | P 47% R 72% |
| Distributed systems | P 42% R 62% | P 42% R 62% | P 50% R 90% | P 50% R 90% |
| Operating systems | P 45% R 41% | P 45% R 41% | P 58% R 69% | P 55% R 69% |

## What changed, per document (question terms, strict)

- **Electrical engineering**: found kirchhoff voltage law, siemen; lost nothing; unmarked terms dropped 1 r, 1 r1, 1 r2, r1; unmarked terms added state, reciprocal.
- **Engineering mathematics**: found derivative, continuous function, power rule, stationary point; lost nothing; unmarked terms dropped solve; unmarked terms added change, frac, continuous.
- **Programming**: found nothing new; lost stack overflow; unmarked terms dropped form, key, loop, memory; unmarked terms added return, recursive, half, constant stack space, recursive function return.
- **Systems programming**: found nothing new; lost nothing; unmarked terms dropped linking; unmarked terms added load.
- **Information and cyber security**: found man in the middle attack, prime number, primitive root, discrete logarithm, sponge construction, merkle damgard construction; lost nothing; unmarked terms dropped none; unmarked terms added secure channel, alpha, insecure channel, fixed length hash value, block.
- **Database management systems**: found concurrency control manager, lock manager, victim transaction, serial order; lost nothing; unmarked terms dropped none; unmarked terms added logical unit, consistent state, concurrency control component, relational database, trade safety, weaker isolation, state, state change, phase, concurrent access, serializable schedule, data item.
- **Distributed systems**: found synchronous message passing, communication channel, client stub, vector clock, physical clock, concurrent event; lost nothing; unmarked terms dropped none; unmarked terms added procedure.
- **Operating systems**: found memory management scheme, external fragmentation, segment table, mutual exclusion, banker algorithm, safe state, deadlock detection, cpu burst, context switching; lost nothing; unmarked terms dropped memory, stack, cpu, turn; unmarked terms added fixed size block, logical unit, segment limit, shortest job.

"Unmarked" terms are not necessarily wrong: a rater may have left out a fair term. Precision here is a lower bound.