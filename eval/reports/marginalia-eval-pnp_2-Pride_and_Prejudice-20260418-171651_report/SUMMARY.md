# Eval report summary

Generated from **1** score file(s).

## Cross-book

- **Pooled mean judge weighted overall:** 3.81

**Pooled mean judge rubric scores (1–5, only rows with that criterion scored):**

- `faithfulness` 3.8 · `chunk_relevance` 4.022 · `answer_completeness` 3.644 · `claim_precision` 3.822

**Pooled judge flag rates (mean of 0/1; averaged over merged rows where that flag exists in judge output):**

- `unsupported_claims` 0.378 · `retrieval_problem` 0.333 · `incomplete_response` 0.267 · `imprecise_or_overbroad` 0.289
- **Hardest category (pooled mean evidence recall):** `cross-section` → 0.5
- **Noisiest books (mean non-dedupe flags per row):**
  - `pride_and_prejudice`: 0.3778

## Per book

### `pride_and_prejudice`

- Rows: **45**
- Problem questions (heuristic): **5**
- Likely hallucination rows (judge): **23**

**Book-level judge means (all rows with scores):**

- Weighted overall: 3.81
- `faithfulness` 3.8 · `chunk_relevance` 4.022 · `answer_completeness` 3.644 · `claim_precision` 3.822

**Book-level judge flag rates (mean 0–1):**

- `unsupported_claims` 0.378 · `retrieval_problem` 0.333 · `incomplete_response` 0.267 · `imprecise_or_overbroad` 0.289


| Condition        | n   | mean recall | mean chunk prec | mean judge overall |
| ---------------- | --- | ----------- | --------------- | ------------------ |
| passage_only     | 15  | —           | —               | 3.3733             |
| smart_scan_tools | 15  | 0.85        | 0.9111          | 4.27               |
| tools            | 15  | 0.6         | 0.7778          | 3.7867             |


**Mean judge rubric scores by condition (1–5)**


| Condition        | n   | faithfulness | chunk_relevance | answer_completeness | claim_precision |
| ---------------- | --- | ------------ | --------------- | ------------------- | --------------- |
| passage_only     | 15  | 3.2          | 4.2             | 2.933               | 3.4             |
| smart_scan_tools | 15  | 4.333        | 4.333           | 4.133               | 4.267           |
| tools            | 15  | 3.867        | 3.533           | 3.867               | 3.8             |



| Category            | n   | mean recall | mean chunk prec | mean judge overall |
| ------------------- | --- | ----------- | --------------- | ------------------ |
| book-level-thematic | 9   | 0.5833      | 1.0             | 3.3889             |
| cross-section       | 9   | 0.5         | 0.44            | 3.5611             |
| nearby-context      | 12  | 1.0         | 1.0             | 3.6458             |
| passage-local       | 15  | —           | —               | 4.3433             |


**Mean judge rubric scores by category (1–5)**


| Category            | n   | faithfulness | chunk_relevance | answer_completeness | claim_precision |
| ------------------- | --- | ------------ | --------------- | ------------------- | --------------- |
| book-level-thematic | 9   | 3.333        | 3.444           | 3.111               | 3.778           |
| cross-section       | 9   | 3.778        | 3.889           | 3.0                 | 3.556           |
| nearby-context      | 12  | 3.5          | 4.333           | 3.417               | 3.5             |
| passage-local       | 15  | 4.333        | 4.2             | 4.533               | 4.267           |


**Mean judge rubric scores by category and condition (1–5)**


| Category            | faithfulness (passage_only) | faithfulness (tools) | faithfulness (smart_scan_tools) | chunk_relevance (passage_only) | chunk_relevance (tools) | chunk_relevance (smart_scan_tools) | answer_completeness (passage_only) | answer_completeness (tools) | answer_completeness (smart_scan_tools) | claim_precision (passage_only) | claim_precision (tools) | claim_precision (smart_scan_tools) |
| ------------------- | --------------------------- | -------------------- | ------------------------------- | ------------------------------ | ----------------------- | ---------------------------------- | ---------------------------------- | --------------------------- | -------------------------------------- | ------------------------------ | ----------------------- | ---------------------------------- |
| book-level-thematic | 2.0                         | 4.0                  | 4.0                             | 3.667                          | 3.667                   | 3.0                                | 2.333                              | 3.667                       | 3.333                                  | 3.333                          | 4.0                     | 4.0                                |
| cross-section       | 4.0                         | 2.667                | 4.667                           | 5.0                            | 2.667                   | 4.0                                | 2.0                                | 3.0                         | 4.0                                    | 3.667                          | 2.667                   | 4.333                              |
| nearby-context      | 2.0                         | 4.25                 | 4.25                            | 3.0                            | 5.0                     | 5.0                                | 1.75                               | 4.25                        | 4.25                                   | 2.0                            | 4.25                    | 4.25                               |
| passage-local       | 4.4                         | 4.2                  | 4.4                             | 5.0                            | 2.8                     | 4.8                                | 4.8                                | 4.2                         | 4.6                                    | 4.4                            | 4.0                     | 4.4                                |


**Mean judge flag rates by condition (0–1; flag_rows = rows with judge flag data)**


| Condition        | n   | flag_rows | unsupported_claims | retrieval_problem | incomplete_response | imprecise_or_overbroad |
| ---------------- | --- | --------- | ------------------ | ----------------- | ------------------- | ---------------------- |
| passage_only     | 15  | 15        | 0.6                | 0.4               | 0.467               | 0.267                  |
| smart_scan_tools | 15  | 15        | 0.2                | 0.267             | 0.133               | 0.2                    |
| tools            | 15  | 15        | 0.333              | 0.333             | 0.2                 | 0.4                    |


**Mean judge flag rates by category (0–1)**


| Category            | n   | flag_rows | unsupported_claims | retrieval_problem | incomplete_response | imprecise_or_overbroad |
| ------------------- | --- | --------- | ------------------ | ----------------- | ------------------- | ---------------------- |
| book-level-thematic | 9   | 9         | 0.556              | 0.556             | 0.444               | 0.222                  |
| cross-section       | 9   | 9         | 0.333              | 0.667             | 0.444               | 0.222                  |
| nearby-context      | 12  | 12        | 0.5                | 0.167             | 0.25                | 0.417                  |
| passage-local       | 15  | 15        | 0.2                | 0.133             | 0.067               | 0.267                  |


**Mean judge flag rates by category and condition (0–1)**


| Category            | unsupported_claims (passage_only) | unsupported_claims (tools) | unsupported_claims (smart_scan_tools) | retrieval_problem (passage_only) | retrieval_problem (tools) | retrieval_problem (smart_scan_tools) | incomplete_response (passage_only) | incomplete_response (tools) | incomplete_response (smart_scan_tools) | imprecise_or_overbroad (passage_only) | imprecise_or_overbroad (tools) | imprecise_or_overbroad (smart_scan_tools) |
| ------------------- | --------------------------------- | -------------------------- | ------------------------------------- | -------------------------------- | ------------------------- | ------------------------------------ | ---------------------------------- | --------------------------- | -------------------------------------- | ------------------------------------- | ------------------------------ | ----------------------------------------- |
| book-level-thematic | 1.0                               | 0.333                      | 0.333                                 | 0.667                            | 0.333                     | 0.667                                | 0.667                              | 0.333                       | 0.333                                  | 0.0                                   | 0.333                          | 0.333                                     |
| cross-section       | 0.333                             | 0.667                      | 0.0                                   | 0.667                            | 0.667                     | 0.667                                | 0.667                              | 0.333                       | 0.333                                  | 0.0                                   | 0.667                          | 0.0                                       |
| nearby-context      | 1.0                               | 0.25                       | 0.25                                  | 0.5                              | 0.0                       | 0.0                                  | 0.75                               | 0.0                         | 0.0                                    | 0.75                                  | 0.25                           | 0.25                                      |
| passage-local       | 0.2                               | 0.2                        | 0.2                                   | 0.0                              | 0.4                       | 0.0                                  | 0.0                                | 0.2                         | 0.0                                    | 0.2                                   | 0.4                            | 0.2                                       |


