# Trying Pebble: a guide for pilot testers

Thank you for trying Pebble. Pebble turns an audio file you choose into a Mandarin transcript
you can read along with, replay line by line, and save lines from for Anki.

**Everything stays on your computer.** Pebble doesn't upload your audio, transcripts or saved
items anywhere. You never need to send them to us, and please don't.

## What you need

- A Mac with Apple Silicon (M1 or newer), about 4 GB of free disk space.
- [Node.js](https://nodejs.org) 22 or newer, [uv](https://docs.astral.sh/uv/) and FFmpeg.
  If you use Homebrew: `brew install node uv ffmpeg`.
- A short audio file (2–5 minutes) that **you recorded yourself or have permission to use**.
  Please don't use podcast episodes or other people's recordings.

## Set up (once)

Open Terminal in the Pebble folder and run:

```bash
npm run pebble:doctor
```

It only checks; it changes nothing. For anything that isn't ready, it tells you the one thing
to do next. Then run:

```bash
npm run pebble:setup
```

Setup asks before every change and explains it first:

- the app's packages (inside the Pebble folder);
- Pebble's private Python environment (inside the Pebble folder);
- the **speech models: a one-time download of about 1.3 GB**, saved in `~/.pebble/models`.
  They run only on your computer.

You can say no to any step; setup tells you what, if anything, was changed, and you can run it
again later. If a download is interrupted, run `npm run pebble:setup` again.

## Start and stop

```bash
npm run pebble:start
```

When it says **"Pebble is starting"**, open <http://localhost:5175>. For a few seconds the app
shows "Checking local speech models…", then "Local transcription is ready."

To stop Pebble, press **Ctrl+C** in that Terminal window (or run `npm run pebble:stop` from
another one).

## Using Pebble

1. **Create a transcript locally**, choose your audio file, confirm you may use it, and start.
   A few minutes of audio takes about a minute.
   The **Episode title** starts as the file name. It appears in your saved learning items
   and Anki exports, so rename it first if the file name is private. Once the audio is
   processed, Pebble shows only this title, never the file name.
2. **Open the transcript.** Click a line (or its play button) to hear it again.
3. Turn on **pinyin** to see pronunciation.
4. **Edit** any line that looks wrong; **Revert** undoes your edit.
5. **Save** lines you want to study. They appear in **Learning items**, where you can add a
   note and **Export CSV for Anki**.
6. To remove audio from Pebble, use **Delete** in your library. Pebble removes the audio, its
   transcript and your edits from your computer. Lines you saved stay in Learning items, marked
   "Source deleted."

> Pebble creates a machine transcript on your computer. It can mishear or miss parts of fast or
> conversational speech. Replay the audio and edit any line that looks wrong.

English translations aren't available for your own audio yet.

Learning items are saved in your browser. Clearing the browser's data for this site removes
them, so export to Anki to keep a copy.

## If something goes wrong

| What you see                                          | What to do                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| "Pebble isn't set up yet …"                           | Run the command it names (usually `npm run pebble:setup`).                 |
| "Port 8790 is used by another program …"              | Start on another port: `PEBBLE_PORT=8791 npm run pebble:start`             |
| "Pebble is already running …"                         | Open <http://localhost:5175>, or stop it first with `npm run pebble:stop`  |
| The app says the worker isn't running                 | Start Pebble with `npm run pebble:start`.                                  |
| "Pebble's local transcription needs setup."           | Run `npm run pebble:setup`.                                                |
| A transcript failed, or you stopped Pebble during one | Start Pebble again and choose **Retry**.                                   |
| Anything else                                         | Run `npm run pebble:doctor` and tell us which line says "needs attention". |

## Removing Pebble completely

Stop Pebble, then delete the Pebble folder and the `~/.pebble` folder. That removes everything
Pebble stored, including the speech models.

## Feedback

Please use the [feedback form](PILOT_FEEDBACK.md). It asks how the tasks went and what you
thought. It never needs your audio, transcript text, file names, screenshots or anything from
`~/.pebble`.
