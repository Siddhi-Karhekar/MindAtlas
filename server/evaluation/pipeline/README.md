# Pipeline evaluation set

Inputs for `npm run eval:pipeline` (server/evaluation/pipeline.mjs), beside the
repo's other samples it reads:

- `ocr_noisy_paging.txt` - the text a poor OCR read of a photographed page
  gives ("rnernory", "tbe", "callcd"). The records should mark it as not read
  reliably, and no question should come from it.
- `missing_context.txt` - sentences that only make sense after one the
  student never sees ("It picks ...", "As shown in the figure above ...").
  Nothing in it should become an MCQ.

Written for this evaluation; not real student notes.
