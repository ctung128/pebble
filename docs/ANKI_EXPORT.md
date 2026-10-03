# Anki CSV export

**Learning items → Export CSV for Anki** downloads `pebble-learning-items-YYYY-MM-DD.csv`. The
file is generated in the browser; nothing is uploaded and there is no direct Anki integration.

## Format

UTF-8 (no BOM), comma-separated, `\n` line endings, RFC 4180 quoting. The file starts with
Anki's import header lines:

```
#separator:Comma
#html:false
#columns:Chinese,Pinyin,Translation,Note,Source,Tags
#tags column:6
```

| Column      | Content                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| Chinese     | Line text as saved (your correction, if you edited it)                   |
| Pinyin      | Generated pinyin, if it was shown before saving; otherwise empty         |
| Translation | English, if it was opened before saving; otherwise empty                 |
| Note        | Your note; may span several lines                                        |
| Source      | `Episode title · m:ss`                                                   |
| Tags        | `pebble pebble::<episode-id>`, plus `pebble::edited` for corrected lines |

- Fields containing `,` `"` or line breaks, or starting with `#` or whitespace, are quoted;
  `"` is doubled. Full-width Chinese punctuation (`，`) needs no quoting.
- `#html:false`: Anki treats every field as plain text, so nothing is interpreted as markup.
- Rows are ordered oldest-saved first.

## Importing in Anki

1. **File → Import** and choose the CSV. Anki reads the header lines and sets the separator,
   HTML handling and tag column.
2. Pick a note type and deck, then map the columns to your note type's fields (e.g. Chinese →
   Front; Pinyin, Translation, Note → Back). Columns you don't map are ignored.
3. Import. Re-importing the same file may create duplicates depending on your duplicate
   settings in the import dialog.

Pebble does not schedule reviews; spaced repetition stays in Anki.
