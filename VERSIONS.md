# Versioning

Wayfind uses semantic versioning. Releases are tagged on GitHub.

## Creating a Release

1. Update CHANGELOG.md with what changed
2. Tag the release: `git tag -a v1.0.1 -m "Release v1.0.1"`
3. Push the tag: `git push origin v1.0.1`
4. Create a GitHub Release from the tag
5. Users can install: `WAYFIND_VERSION=v1.0.1 bash <(curl -fsSL https://raw.githubusercontent.com/usewayfind/wayfind/main/install.sh)`

## Version Stability

- `main` branch always has the latest code (use for development)
- Tags are immutable pinned releases (use for production installs)
- The one-line installer defaults to `main` — use `WAYFIND_VERSION=` to pin
