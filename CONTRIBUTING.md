# Contributing to Meridian

Thanks for your interest in contributing. This guide covers the practical steps.

## Reporting Issues

Open a [GitHub issue](https://github.com/usemeridian/meridian/issues) for:

- **Bug reports** — Include your Meridian version (`meridian --version`), OS, and the AI tool you're using (Claude Code, Cursor, etc.). Paste the relevant error output.
- **Feature requests** — Describe the problem you're solving, not just the solution you want.

## Submitting Pull Requests

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Run `npm test` and make sure everything passes.
4. Open a PR against `main` with a clear description of what changed and why.

Keep PRs focused. One concern per PR.

## Tech Stack

- **CLI**: Node.js
- **Hooks and templates**: Bash scripts, JSON configuration
- **State and context**: Plain markdown files
- **No external databases or services** — everything runs locally

## Good First Contributions

### Specializations

Meridian supports specializations for different AI tools. If you use a tool that isn't covered yet (Windsurf, Aider, Continue, etc.), adding a specialization is a great way to contribute. Look at the existing specializations in `specializations/` for the pattern.

### Signal Connectors

Signal connectors follow a standard interface and are designed to be contribution-friendly. If you want Meridian to pull context from a new source (CI system, project tracker, etc.), a connector is the right approach. See `bin/` for existing connector implementations.

## Style

- Keep it simple. Plain files over abstractions.
- Bash scripts should work on macOS and Linux.
- Node.js code uses standard style — no transpilation, no framework overhead.
- Markdown files are the data format. No databases.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
