// web/frontend/src/lib/aiText.ts
// Model replies occasionally come back as a list instead of prose; when such a reply was
// stored as text it looks like a broken Python literal: ['Пункт 1', "Пункт 2"].
// normalizeAiText turns it back into one point per line so every screen shows clean bullets.

/** `['a', "b"]` / `["a","b"]` → "a\nb"; any other text is returned trimmed and unchanged. */
export function normalizeAiText(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (t.length > 1 && t.startsWith("[") && t.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean).join("\n");
    } catch {
      /* not JSON — try the Python-style quoted list below */
    }
    const items = [...t.slice(1, -1).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => (m[1] ?? m[2] ?? "").replace(/\\(['"])/g, "$1").trim())
      .filter(Boolean);
    if (items.length) return items.join("\n");
  }
  return t;
}

/** One piece of an AI block: a paragraph of prose or a bullet of a list. */
export interface AiItem {
  kind: "p" | "li";
  text: string;
}

/** AI block text → paragraphs and bullets (list-like lines, numbered or dashed, become bullets;
 *  prose stays prose; a reply stored as a list becomes bullets). Markdown bold marks are dropped. */
export function parseAiBlock(raw: string | null | undefined): AiItem[] {
  const trimmed = (raw ?? "").trim();
  const text = normalizeAiText(trimmed);
  const wasList = text !== trimmed;
  const out: AiItem[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\*\*|__/g, "").trim();
    if (!line) continue;
    const m = line.match(/^(?:[•\-–—*]+|\d+[.)])\s+(.*)$/);
    if (m) out.push({ kind: "li", text: m[1].trim() });
    else out.push({ kind: wasList ? "li" : "p", text: line });
  }
  return out;
}
