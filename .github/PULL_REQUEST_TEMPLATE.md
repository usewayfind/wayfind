## What

<!-- One sentence: what does this change do? -->

## Why

<!-- Issue link or context: fixes #NNN, or brief motivation -->

---

## Merge checklist

> Skip items that don't apply.

- [ ] Tests pass locally (`npm test`)
- [ ] If this touches `bin/`, `templates/`, `specializations/`, `tests/`, `setup.sh`, `install.sh`, `uninstall.sh`, `doctor.sh`, `simulation/`, `package.json`, or `Dockerfile`:
  - [ ] Bump version in `package.json`
  - [ ] Add `public-staging/CHANGELOG.md` entry
  - [ ] Run `wayfind sync-public` after merging
