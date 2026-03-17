---
name: review-prs
description: Review overnight NanoClaw PRs — fact-check, assess against repo conventions, summarize, and offer merge/revise/close for each.
user-invocable: true
---

# Review NanoClaw PRs

Review open pull requests created by NanoClaw overnight. For each PR: read the diff, assess quality, fact-check where possible, and present a summary with a recommendation.

## Step 0: Discover repos

Read the Wayfind context registry to find repos to scan:

```bash
cat ~/.claude/team-context/context.json 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const teams = d.teams || {};
  Object.values(teams).forEach(t => {
    if (t.repos) t.repos.forEach(r => console.log(r));
    if (t.path) console.log(t.path);
  });
" 2>/dev/null
```

If no context registry exists, ask the user which repos to scan. Store the list for subsequent steps.

Also detect the GitHub owner by reading git remote from each repo path, or ask the user.

## Step 1: Find open NanoClaw PRs

For each discovered repo, check for open NanoClaw PRs:

```bash
for repo in {owner/repo list from Step 0}; do
  echo "=== $repo ==="
  gh pr list --repo "$repo" --state open --json number,title,headRefName,createdAt,additions,deletions,changedFiles 2>/dev/null | jq -r '.[] | select(.headRefName | startswith("nanoclaw/")) | "PR #\(.number): \(.title) (+\(.additions)/-\(.deletions), \(.changedFiles) files)"'
done
```

If no open NanoClaw PRs found, report "No overnight PRs to review" and stop.

## Step 2: Review each PR in parallel

**Spawn one Agent per PR** using the Agent tool with `run_in_background: true`. Each agent reviews its assigned PR independently. If there are 2+ PRs, all agents run concurrently. If there is only 1 PR, still spawn an agent for the review and a second agent to fact-check sources in parallel.

Each agent should:

1. **Get the full diff:**
   ```bash
   gh pr diff {number} --repo {owner/repo}
   ```

2. **Get PR metadata:**
   ```bash
   gh pr view {number} --repo {owner/repo} --json title,body,headRefName,createdAt
   ```

3. **Assess the content:**

   For **competitive intel** PRs (files in `docs/competitive-intel/`):
   - Read `docs/competitive-intel/MONITORING.md` for the required template
   - Does it follow the template?
   - Are sources cited? Do URLs look plausible (not hallucinated)?
   - Are threat assessments reasonable given what we know?
   - Does it claim `Verified: Yes` without evidence of verification?
   - Are there new HIGH-threat competitors that need a full analysis file?
   - Spot-check 2-3 factual claims using `gh api` or web search

   For **code** PRs:
   - Does it compile/pass tests? (`npm test` if applicable)
   - Are changes scoped correctly (not too broad)?
   - Any obvious bugs, security issues, or style violations?
   - Does it match the repo's conventions?

   For **documentation** PRs:
   - Is the content accurate and well-structured?
   - Does it duplicate existing docs?

4. **Check the PR title.** NanoClaw often uses the raw prompt as the title. Flag if it needs fixing.

Wait for all agents to complete, then synthesize their findings into the summary below.

## Step 3: Present summary

For each PR, present:

```
### PR #{number}: {title} ({repo})
**Files:** {list}
**Quality:** {Good / Needs revision / Reject}

**Summary:** {2-3 sentences on what the PR does}

**Issues found:**
- {issue 1}
- {issue 2}
(or "None — clean PR")

**Fact-check results:**
- {claim}: {verified/unverified/incorrect}

**Recommendation:** Merge / Merge after fixes / Request revision / Close

{If merge after fixes: list the specific fixes needed}
```

## Step 4: Act on decisions

After presenting all summaries, ask the user what to do with each PR. Support these actions:

- **Merge**: `gh pr merge {number} --repo {repo} --merge --delete-branch`
- **Fix title then merge**: `gh pr edit {number} --repo {repo} --title "{new title}"` then merge
- **Request changes**: Post a review comment and leave open
- **Close**: `gh pr close {number} --repo {repo}`
- **Skip**: Leave for later

After merging any PRs, pull main:
```bash
git checkout main && git pull
```
