# Contributing to Pebble

## Before every commit

1. **Checks** (from the repository root):

   ```bash
   npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
   npm run test:worker
   ```

   With FunASR installed and models pulled, also run the real-model test (network blocked,
   synthetic speech):

   ```bash
   cd services/worker && PEBBLE_FUNASR_INTEGRATION=1 uv run pytest tests/test_funasr_integration.py
   ```

2. **Privacy check.** Local mode processes private audio. Nothing from a real recording —
   audio, recognized text, file names, episode or job IDs, or paths — may enter the
   repository, including tests, fixtures, snapshots, docs, error messages and commit
   messages. Stage files explicitly (never `git add -A` with untracked files you haven't
   looked at), then inspect what is staged:

   ```bash
   git status --short
   git diff --cached --stat
   # Staged audio, model weights, databases, logs, environments or build output:
   git diff --cached --name-only | grep -Ei '\.(m4a|mp3|wav|flac|ogg|opus|aac|webm|pt|bin|db|sqlite|log)$|\.venv/|/dist|uv-cache'
   # Local data paths, real episode/job IDs and home-directory paths in the staged text:
   git diff --cached | grep -nE '\.pebble/(smoke|episodes|models/iic/.+/)|/Users/|/home/|(ep|job)-[0-9a-f]{12}'
   ```

   Read every hit. Expected ones are the committed demo fixture audio
   (`fixtures/demo/demo-001/audio.m4a`), documentation of the `~/.pebble` layout, and the
   synthetic test IDs `ep-0123456789ab` / `job-0123456789ab`. Anything else — a real episode
   ID, a clip name, a path under your home directory — must be removed before committing.

   Then read the diff itself (`git diff --cached`) for recognized Chinese text that didn't
   come from invented test sentences or the demo script. Don't commit a list of private
   phrases to search for; check by reading, or with a throwaway command that isn't saved.

3. **Tests use invented or synthetic content only**: made-up sentences, generated tones, or
   speech synthesized on the fly. Never a real recording or its transcript.
