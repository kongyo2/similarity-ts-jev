# Changelog

## 0.1.0

- similarity-ts and fallow (every detection mode) run together; their findings are one list.
- Each pair is judged by Jev (`refactor` score with `same_logic` / `same_concept`), and only pairs scoring 1.9 or more are reported, grouped into families.
- `--cache` records Jev's answers for replay; `--dry-run`, `--all`, `--fail-on-duplicates`, JSON output.
