# data/

Input data for the pipeline, split by role per the project structure:

- `samples/<course>/` — **Массив ответов** workbooks (user answer arrays).
- `etalon/<course>/`  — **Эталон ответов** workbooks (reference answer keys).

The per-course subfolders (`001`, `021`, `069`, …) are **required**: the parser
derives `course_id` from the parent folder name, and the reference key is linked
to its answer array by matching course. Keep both file types for one course under
the same course id in their respective trees.

These are real client LMS exports (the durable source copies). Filenames are kept
exactly as delivered — including any client-side typos — so do not rename them.
