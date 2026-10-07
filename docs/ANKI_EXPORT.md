# Anki CSV export

**Learning items → Export CSV for Anki** downloads `pebble-learning-items-YYYY-MM-DD.csv`. The
file is generated in the browser; nothing is uploaded and there is no direct Anki integration.
Pebble does not schedule reviews; spaced repetition stays in Anki.

## What the file contains

UTF-8 (no BOM), comma-separated, `\n` line endings, RFC 4180 quoting. The file starts with
Anki's import header lines (supported by Anki 2.1.55 and newer):

```
#separator:Comma
#html:false
#columns:Chinese,Pinyin,Translation,Note,Source,Tags
#tags column:6
```

| #   | Column      | Content                                                                                                                                                                             |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Chinese     | Line text as saved (your correction, if you edited it)                                                                                                                              |
| 2   | Pinyin      | Generated pinyin for the saved text. Filled in automatically on export if it wasn't generated before saving; empty only if pinyin couldn't be generated                             |
| 3   | Translation | English. Filled in automatically on export when a translation is available; empty for edited lines (prepared translations match only the original text) or if it couldn't be loaded |
| 4   | Note        | Your note; may span several lines                                                                                                                                                   |
| 5   | Source      | `Episode title · m:ss`, plus ` · source deleted` if the audio was deleted from Pebble                                                                                               |
| 6   | Tags        | `pebble pebble::<episode-id>`, plus `pebble::edited` for corrected lines and `pebble::source-deleted` when the audio was deleted                                                    |

- English and pinyin are added automatically: on export, Pebble fills in whichever is missing
  (only then; nothing is fetched in the background) and keeps the results on the learning
  items. After the download, Pebble reports any items exported without English or pinyin.
  For your own (local) transcripts, English is never added on export: items keep the English
  saved with them, if any ([TRANSLATION.md](TRANSLATION.md)).
- Every row has exactly six fields. Empty values stay empty in place, so a missing
  translation never shifts Note or Source into the wrong column.
- Fields containing `,` `"` or line breaks, or starting with `#` or whitespace, are quoted, and
  `"` is doubled. Full-width Chinese punctuation (`，`) needs no quoting.
- `#html:false`: Anki treats every field as plain text, so nothing is interpreted as markup.
- Rows are ordered oldest-saved first.

## Why Anki doesn't show the translation automatically

A CSV file carries **data**, not **card design**. In Anki, what a card shows is decided by its
**note type**: the note type defines the fields a note has, and its **card templates** decide
which of those fields appear on the front and back.

- Importing a CSV never creates fields or templates. It only fills the fields of a note type
  you choose in the import dialog.
- **`#columns:` only labels the file's columns** so the import dialog can show readable names
  when you map them. It does not create Anki fields called Chinese, Pinyin or Translation.
- If you import into Anki's built-in **Basic** note type (fields _Front_ and _Back_), there is
  nowhere to put Pinyin, Translation, Note and Source. Anki maps the first columns it can and
  leaves the rest unmapped, which is why you can end up with only the Chinese.
- Even with a matching field, the card shows a field only if the template references it, for
  example `{{Translation}}` on the Back Template.

So the reliable setup is a note type with all five fields and a template that displays them.
You create it once in Anki and reuse it for every import.

## Recommended note type: "Pebble Mandarin"

Required fields, in this order:

1. **Chinese**
2. **Pinyin**
3. **Translation**
4. **Note**
5. **Source**

### One-time setup

1. **Tools → Manage Note Types → Add → Add: Basic**, and name it `Pebble Mandarin`.
2. Select it and click **Fields…**. Rename _Front_ → `Chinese` and _Back_ → `Pinyin`, then
   **Add** `Translation`, `Note` and `Source`.
3. Click **Cards…** and paste the templates and styling below.

### Front Template

```html
<div class="zh">{{Chinese}}</div>
```

### Back Template

<!-- prettier-ignore -->
```html
{{FrontSide}}
<hr id="answer">
{{#Pinyin}}<div class="pinyin">{{Pinyin}}</div>{{/Pinyin}}
{{#Translation}}<div class="translation">{{Translation}}</div>{{/Translation}}
{{#Note}}<div class="note">{{Note}}</div>{{/Note}}
<div class="source">{{Source}}</div>
```

`{{#Field}}…{{/Field}}` shows a block only when that field is non-empty, so lines saved without
pinyin or a translation don't show empty gaps.

### Styling

```css
.card {
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
  font-size: 20px;
  line-height: 1.5;
  text-align: center;
  color: #24221e;
  background: #fffdf8;
}
.zh {
  font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  font-size: 32px;
}
.pinyin {
  margin-top: 8px;
  color: #67625a;
}
.translation {
  margin-top: 12px;
}
.note {
  margin-top: 12px;
  font-size: 16px;
  color: #67625a;
  white-space: pre-wrap;
}
.source {
  margin-top: 16px;
  font-size: 13px;
  color: #8f8a80;
}
.nightMode .card,
.night_mode .card {
  color: #ece8df;
  background: #1e1d1a;
}
```

## Importing

1. **File → Import** and choose the CSV. Anki reads the header lines and sets the separator,
   HTML handling and tag column.
2. Set **Note type** to `Pebble Mandarin` and choose a deck.
3. Check **Field mapping**:

   | File column (Pebble) | Anki field  |
   | -------------------- | ----------- |
   | Chinese              | Chinese     |
   | Pinyin               | Pinyin      |
   | Translation          | Translation |
   | Note                 | Note        |
   | Source               | Source      |
   | Tags                 | Tags        |

4. Click **Import**. Re-importing the same file may create duplicates, depending on the
   duplicate setting in the import dialog.

## Optional: preselect the note type with `#notetype`

Anki also supports a `#notetype:` header that preselects the note type on import. **Pebble does
not include it by default**: it names a note type that exists only if you created it, and
Pebble can't know that. If you have created `Pebble Mandarin` exactly as above, you can add this
line to the file's header block yourself (in a plain-text editor, not a spreadsheet app):

```
#notetype:Pebble Mandarin
```

The name must match your note type exactly, including capitalization and the space. Without a
matching note type, leave the line out and choose the note type in the import dialog instead.

## Troubleshooting

| Symptom                                                         | Likely cause                                                                                                                                                                                      | Fix                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **a. English translation does not appear** on the card          | The Back Template doesn't contain `{{Translation}}`, or the Translation field is empty (the line was edited, or its translation couldn't be loaded during export; Pebble says so after exporting) | Add `{{Translation}}` to the Back Template (see above). In **Browse**, check whether the note's Translation field has text. If it's empty and the line wasn't edited, export again. |
| **b. Translation field is ignored** during import               | The chosen note type has no Translation field (e.g. Basic), or the Translation column is mapped to _(Nothing)_                                                                                    | Import with `Pebble Mandarin`, and in **Field mapping** set Translation → Translation.                                                                                              |
| **c. Columns merge into one field**                             | Anki didn't use a comma as the separator: an Anki version older than 2.1.55 (header lines not read), or the file was re-saved by a spreadsheet app that changed the format                        | Update Anki, or set **Field separator** to **Comma** in the import dialog. Import the original downloaded file rather than a re-saved copy.                                         |
| **d. Pinyin/translation appears in Browse but not on the card** | The data imported correctly but the card template doesn't reference those fields                                                                                                                  | **Tools → Manage Note Types → Pebble Mandarin → Cards…** and use the Back Template above. Existing cards update immediately; no re-import needed.                                   |
