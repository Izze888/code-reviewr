# Suds Review

An AI robot that reviews your GitHub pull requests and leaves notes on real
bugs. It comes with lessons learned from hundreds of real bugs other AI
reviewers missed.

## What it costs

It uses Claude through OpenRouter. You pay OpenRouter. Each pull request costs
about $3 to $7, depending on how big it is. Pushes that land close together
are reviewed once, about 10 minutes after they stop.

## Set it up (about 10 minutes)

1. **Copy two things into your project**, keeping the same folders:
   - the `.github/suds-review/` folder
   - the `.github/workflows/suds-review.yml` file
2. **Tell it about your app.** Open `.github/suds-review/instructions.md` and
   fill in the "About this app" part: what your app does and which mistakes
   would hurt most.
3. **Get an OpenRouter key** at https://openrouter.ai/keys and add some credit.
4. **Give the key to GitHub.** In your GitHub project, go to Settings, then
   Secrets and variables, then Actions. Make a new secret named
   `OPENROUTER_API_KEY` and paste your key. Or from a terminal in your project:

   ```bash
   gh secret set OPENROUTER_API_KEY
   ```

5. **Push to your main branch.** The robot reviews pull requests from then on.
   It skips drafts, so it starts when you mark a pull request ready.

## Using it

- Notes show up on the changed lines. Fix the bug and push: about 10 minutes
  after the pushes stop, it closes its own note. If it's wrong, reply with
  why. The next review reads replies.
- Add your own rules to `AGENTS.md` or `CLAUDE.md` in your project root. The
  robot reads them if they're there.
- Turn it off: in GitHub Settings, Secrets and variables, Actions, Variables,
  add `SUDS_REVIEW_PAUSED` with the value `true`.

## Getting new lessons

This project gets new lessons when the owner updates it. To get them, copy
`.github/suds-review/lessons.md` (and the `.mjs` files next to it) into your
project again. Keep your own "About this app" part in `instructions.md`.

## For the owner only

`tools/update.mjs` refreshes this kit from Suds: newest code plus lessons
rewritten with no Suds names, pull request numbers, or code names. It refuses
to save if anything private slips through.

```bash
node tools/update.mjs
```
