/**
 * Local, in-memory text matching for search fields. Unicode-safe: NFKC folds full-width and
 * compatibility forms (Ａ → A, ｱ → ア) and case is folded with the locale-aware lower-casing,
 * so Latin case differences don't matter and Chinese matches as written.
 */
export function normalizeForSearch(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

/**
 * Like normalizeForSearch, and also drops accents and tone marks (tiān → tian, café → cafe),
 * for pinyin and English. Chinese characters are unaffected.
 */
export function foldForSearch(text: string): string {
  return normalizeForSearch(text).normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

/** Whether `query` (already trimmed) occurs in `text`; an empty query matches everything. */
export function matchesQuery(text: string, query: string, fold = normalizeForSearch): boolean {
  const needle = fold(query.trim());
  return needle === "" || fold(text).includes(needle);
}
