// What the public demo bundle may never contain (check-demo-bundle.mjs runs this on the build).
// Every file is checked in full; nothing is skipped because it also holds schema code.

/** Local-mode markers: worker URL, upload UI, local speech-recognition copy and model ids. */
export const LOCAL_MODE_MARKERS = [
  "127.0.0.1:8790", // worker URL
  "Process audio locally", // upload page
  "Run processing preview",
  "ownershipConfirmed", // upload request field
  "pebble-worker",
  "FunASR", // local transcript notice and provider names
  "Paraformer",
  "iic/speech_", // model identifiers
  "iic/punc_",
  "Create a transcript locally", // provider-aware local copy
  "Checking local speech models",
  "Local transcription is ready",
  "local transcription needs setup",
];

/**
 * Local translation (ADR 0008): provider copy, attribution, routes, consent and settings UI,
 * and local implementation. "DeepL" (any capitalisation) is handled separately below.
 */
export const TRANSLATION_MARKERS = [
  "translation/consent", // consent route
  "/translations", // translation and cache routes
  "Translate with", // consent dialog
  "record your choice",
  "consent is out of date",
  "Allow translation", // fixed error copy
  "Show saved English",
  "Hide saved English",
  "earlier version of this line",
  "Translate again",
  "Translated by", // attribution
  "English translation with", // settings
  "allowed for this computer",
  "Saved English stays readable",
  "Withdraw",
  "DEEPL_AUTH_KEY",
];

/**
 * Local speaker labels (ADR 0009): routes, controls and model copy. The reader's generic speaker
 * letter ("Speaker A", used by the demo's authored fixtures) is not local and isn't listed.
 */
export const SPEAKER_MARKERS = [
  "/speakers", // speaker routes (start, read, corrections, cancel)
  "Detect speakers", // controls and copy
  "Speakers in this episode",
  "Mark speaker",
  "Merge speakers",
  "Correct lines",
  "Save speaker changes",
  "Expected number of speakers",
  "pull --speaker", // model setup copy
  "speaker model",
  "built-in sandbox",
];

/**
 * The one permitted provider occurrence: the shared schema's provider identifier
 * (`TRANSLATION_PROVIDER` in packages/schema/src/lineTranslation.ts), which the demo bundles
 * with the contract validators. It is recognised only in its compiled context: the literal
 * `deepl` followed directly by that module's next constants, the target language `EN-US`, the
 * 2,000-code-point limit and the start of the Han-range table:
 *
 *   rm=`deepl`,im=`EN-US`,am=2e3,om=[[13312,19903],...
 *
 * Any other /deepl/i match (the brand, deepl.com, a consent version such as "deepl-2026-10", a
 * lone literal elsewhere, or a second one) is a leak. If the schema module or the minifier's
 * output changes shape, this fails closed: update the pattern after checking the build.
 */
export const SCHEMA_PROVIDER_CONTEXT =
  /(["'`])deepl\1(?=,[\w$]+=(["'`])EN-US\2,[\w$]+=2e3,[\w$]+=\[\[13312,19903\])/g;
export const MAX_SCHEMA_PROVIDER_LITERALS = 1;

/** @param {{ name: string, text: string }[]} files @returns {string[]} leaks */
export function findDemoBundleLeaks(files) {
  const leaks = [];
  let literals = 0;
  for (const { name, text } of files) {
    for (const marker of [...LOCAL_MODE_MARKERS, ...TRANSLATION_MARKERS, ...SPEAKER_MARKERS]) {
      if (text.includes(marker)) leaks.push(`${name}: "${marker}"`);
    }
    literals += [...text.matchAll(SCHEMA_PROVIDER_CONTEXT)].length;
    // Only the schema identifier itself is set aside; the rest of the file is still checked.
    const rest = text.replace(SCHEMA_PROVIDER_CONTEXT, "$1$1");
    if (/deepl/i.test(rest)) leaks.push(`${name}: provider name outside the schema identifier`);
  }
  if (literals > MAX_SCHEMA_PROVIDER_LITERALS) {
    leaks.push(
      `${literals} provider identifiers (at most ${MAX_SCHEMA_PROVIDER_LITERALS} allowed)`,
    );
  }
  return leaks;
}
