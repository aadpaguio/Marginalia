# Eval report summary

Generated from **1** score file(s).

## Cross-book

- **Pooled mean judge weighted overall:** 3.842

**Pooled mean judge rubric scores (1–5, only rows with that criterion scored):**

- `faithfulness` 3.889 · `chunk_relevance` 3.933 · `answer_completeness` 3.667 · `claim_precision` 3.889

**Pooled judge flag rates (mean of 0/1; averaged over merged rows where that flag exists in judge output):**

- `unsupported_claims` 0.356 · `retrieval_problem` 0.378 · `incomplete_response` 0.2 · `imprecise_or_overbroad` 0.222
- **Hardest category (pooled mean evidence recall):** `cross-section` → 0.1667
- **Noisiest books (mean non-dedupe flags per row):**
  - `frankenstein`: 0.3333

## Per book

### `frankenstein`

- Rows: **45**
- Problem questions (heuristic): **7**
- Likely hallucination rows (judge): **24**

**Book-level judge means (all rows with scores):**

- Weighted overall: 3.842
- `faithfulness` 3.889 · `chunk_relevance` 3.933 · `answer_completeness` 3.667 · `claim_precision` 3.889

**Book-level judge flag rates (mean 0–1):**

- `unsupported_claims` 0.356 · `retrieval_problem` 0.378 · `incomplete_response` 0.2 · `imprecise_or_overbroad` 0.222


| Condition        | n   | mean recall | mean chunk prec | mean judge overall |
| ---------------- | --- | ----------- | --------------- | ------------------ |
| passage_only     | 15  | —           | —               | 3.57               |
| smart_scan_tools | 15  | 0.5         | 0.5357          | 4.08               |
| tools            | 15  | 0.4         | 0.4             | 3.8767             |


**Mean judge rubric scores by condition (1–5)**


| Condition        | n   | faithfulness | chunk_relevance | answer_completeness | claim_precision |
| ---------------- | --- | ------------ | --------------- | ------------------- | --------------- |
| passage_only     | 15  | 3.6          | 3.933           | 3.267               | 3.533           |
| smart_scan_tools | 15  | 4.133        | 4.333           | 3.867               | 4.0             |
| tools            | 15  | 3.933        | 3.533           | 3.867               | 4.133           |



| Category            | n   | mean recall | mean chunk prec | mean judge overall |
| ------------------- | --- | ----------- | --------------- | ------------------ |
| book-level-thematic | 9   | 0.3333      | 0.3125          | 3.3389             |
| cross-section       | 9   | 0.1667      | 0.0833          | 2.7556             |
| nearby-context      | 12  | 0.75        | 0.8571          | 4.25               |
| passage-local       | 15  | —           | —               | 4.47               |


**Mean judge rubric scores by category (1–5)**


| Category            | n   | faithfulness | chunk_relevance | answer_completeness | claim_precision |
| ------------------- | --- | ------------ | --------------- | ------------------- | --------------- |
| book-level-thematic | 9   | 3.556        | 3.556           | 2.778               | 3.444           |
| cross-section       | 9   | 3.0          | 2.444           | 2.556               | 2.889           |
| nearby-context      | 12  | 4.167        | 4.5             | 4.167               | 4.25            |
| passage-local       | 15  | 4.4          | 4.6             | 4.467               | 4.467           |


**Mean judge rubric scores by category and condition (1–5)**


| Category            | faithfulness (passage_only) | faithfulness (tools) | faithfulness (smart_scan_tools) | chunk_relevance (passage_only) | chunk_relevance (tools) | chunk_relevance (smart_scan_tools) | answer_completeness (passage_only) | answer_completeness (tools) | answer_completeness (smart_scan_tools) | claim_precision (passage_only) | claim_precision (tools) | claim_precision (smart_scan_tools) |
| ------------------- | --------------------------- | -------------------- | ------------------------------- | ------------------------------ | ----------------------- | ---------------------------------- | ---------------------------------- | --------------------------- | -------------------------------------- | ------------------------------ | ----------------------- | ---------------------------------- |
| book-level-thematic | 3.0                         | 4.0                  | 3.667                           | 3.667                          | 3.667                   | 3.333                              | 2.0                                | 4.0                         | 2.333                                  | 2.667                          | 4.333                   | 3.333                              |
| cross-section       | 3.0                         | 2.0                  | 4.0                             | 2.333                          | 1.0                     | 4.0                                | 2.0                                | 2.0                         | 3.667                                  | 2.667                          | 2.333                   | 3.667                              |
| nearby-context      | 3.25                        | 4.25                 | 5.0                             | 4.0                            | 4.5                     | 5.0                                | 3.75                               | 4.0                         | 4.75                                   | 3.5                            | 4.25                    | 5.0                                |
| passage-local       | 4.6                         | 4.8                  | 3.8                             | 5.0                            | 4.2                     | 4.6                                | 4.4                                | 4.8                         | 4.2                                    | 4.6                            | 5.0                     | 3.8                                |


**Mean judge flag rates by condition (0–1; flag_rows = rows with judge flag data)**


| Condition        | n   | flag_rows | unsupported_claims | retrieval_problem | incomplete_response | imprecise_or_overbroad |
| ---------------- | --- | --------- | ------------------ | ----------------- | ------------------- | ---------------------- |
| passage_only     | 15  | 15        | 0.467              | 0.533             | 0.333               | 0.333                  |
| smart_scan_tools | 15  | 15        | 0.267              | 0.2               | 0.133               | 0.267                  |
| tools            | 15  | 15        | 0.333              | 0.4               | 0.133               | 0.067                  |


**Mean judge flag rates by category (0–1)**


| Category            | n   | flag_rows | unsupported_claims | retrieval_problem | incomplete_response | imprecise_or_overbroad |
| ------------------- | --- | --------- | ------------------ | ----------------- | ------------------- | ---------------------- |
| book-level-thematic | 9   | 9         | 0.444              | 0.667             | 0.333               | 0.333                  |
| cross-section       | 9   | 9         | 0.667              | 0.778             | 0.444               | 0.333                  |
| nearby-context      | 12  | 12        | 0.25               | 0.167             | 0.083               | 0.083                  |
| passage-local       | 15  | 15        | 0.2                | 0.133             | 0.067               | 0.2                    |


**Mean judge flag rates by category and condition (0–1)**


| Category            | unsupported_claims (passage_only) | unsupported_claims (tools) | unsupported_claims (smart_scan_tools) | retrieval_problem (passage_only) | retrieval_problem (tools) | retrieval_problem (smart_scan_tools) | incomplete_response (passage_only) | incomplete_response (tools) | incomplete_response (smart_scan_tools) | imprecise_or_overbroad (passage_only) | imprecise_or_overbroad (tools) | imprecise_or_overbroad (smart_scan_tools) |
| ------------------- | --------------------------------- | -------------------------- | ------------------------------------- | -------------------------------- | ------------------------- | ------------------------------------ | ---------------------------------- | --------------------------- | -------------------------------------- | ------------------------------------- | ------------------------------ | ----------------------------------------- |
| book-level-thematic | 0.667                             | 0.333                      | 0.333                                 | 1.0                              | 0.333                     | 0.667                                | 0.667                              | 0.0                         | 0.333                                  | 0.667                                 | 0.0                            | 0.333                                     |
| cross-section       | 0.667                             | 1.0                        | 0.333                                 | 1.0                              | 1.0                       | 0.333                                | 0.667                              | 0.333                       | 0.333                                  | 0.667                                 | 0.0                            | 0.333                                     |
| nearby-context      | 0.5                               | 0.25                       | 0.0                                   | 0.5                              | 0.0                       | 0.0                                  | 0.0                                | 0.25                        | 0.0                                    | 0.0                                   | 0.25                           | 0.0                                       |
| passage-local       | 0.2                               | 0.0                        | 0.4                                   | 0.0                              | 0.4                       | 0.0                                  | 0.2                                | 0.0                         | 0.0                                    | 0.2                                   | 0.0                            | 0.4                                       |


