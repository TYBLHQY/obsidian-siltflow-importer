/**
 * Markdown formatter — converts Siltflow DB data into Obsidian Markdown notes.
 *
 * Output format: one note per document. Each note has YAML frontmatter +
 * document title + AI summary callout + a card-style callout for every
 * annotation (word/phrase/sentence). Empty sections are omitted at generation
 * time, so nothing shows for annotations without AI data.
 *
 * Each annotation callout embeds an HTML comment with its siltflow-annotation
 * ID and AI version for incremental import diffing.
 */
import type {
  DocumentRenderData,
  AnnotationRow,
  ParsedAIResult,
} from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the best available translation from a ParsedAIResult,
 * handling both V1 and V2 data formats.
 */
export function extractAITranslation(ai: ParsedAIResult | undefined): string | null {
  if (!ai) return null;
  // V1: flat translation field
  if (ai.translation) return ai.translation;

  // V2: word — use first meaning's translation
  if (ai.output?.meanings && ai.output.meanings.length > 0) {
    return ai.output.meanings[0].translation;
  }
  // V2: phrase or sentence — shared translation field
  if (ai.output?.translation) return ai.output.translation;

  return null;
}

/**
 * Infer granularity: "word", "phrase", or "sentence".
 * V2 has explicit `ai.input.type`; V1 uses a heuristic matching the upstream
 * `inferGranularity()` in annotation-helpers.ts.
 */
function inferGranularity(ai: ParsedAIResult, text: string): string {
  if (ai.input?.type) return ai.input.type;
  const t = text.trim();
  if (t.includes("\n") || t.split(" ").length > 30) return "sentence";
  if (t.split(/[.!?;]+/).filter(Boolean).length > 1) return "sentence";
  if (t.split(" ").length > 2) return "phrase";
  return "word";
}

/** V2 granularity of an annotation, or null when it has no V2 `input.type`. */
export type AnnotationGranularity = "word" | "phrase" | "sentence";

/**
 * Return the explicit V2 granularity (`ai.input.type`) of an annotation, or
 * null when there is none (no AI result, or V1 data). Only V2-typed
 * annotations are gated by the per-type include settings; everything else is
 * always included.
 */
export function v2Granularity(
  ai: ParsedAIResult | undefined,
): AnnotationGranularity | null {
  const t = ai?.input?.type;
  if (t === "word" || t === "phrase" || t === "sentence") return t;
  return null;
}

// ── V1 / V2 detail rendering (matches upstream Siltflow card layout) ──────────

interface DetailLines {
  core: string[];    // always shown (definitions block in V1; translation + CEFR/lemma + meanings in V2 word)
  details: string[]; // collapsible / secondary (examples, collocations, alternatives, synonyms)
}

/**
 * Build detail blocks matching the upstream Siltflow card layout.
 * V1: meta tags + definitions (core), examples + collocations + alternatives (details)
 * V2: type-specific sub-views (Word / Phrase / Sentence)
 */
export function buildAIDetailBlocks(
  ai: ParsedAIResult | undefined,
  text: string,
): DetailLines {
  if (!ai) return { core: [], details: [] };
  // ── V1 rendering ──
  if (!ai.input?.type) return buildV1Blocks(ai, text);

  // ── V2 rendering ──
  return buildV2Blocks(ai);
}

// ==========================================================================
// V1 block builder — matches AIAnnotationResultV1 layout
// ==========================================================================

function buildV1Blocks(ai: ParsedAIResult, text: string): DetailLines {
  const core: string[] = [];
  const details: string[] = [];

  const granularity = inferGranularity(ai, text);
  const isWord = granularity === "word" || granularity === "phrase";
  const difficulty = ai.metadata?.difficulty;
  const register = ai.metadata?.register;
  const ipa = ai.pronunciation?.ipa;

  // ── Translation (core) ──
  const translation = ai.translation;
  if (translation) {
    core.push(`**Translation**  \n${translation}`);
  }

  // ── Meta tags row (core) — difficulty, IPA, register ──
  const tags: string[] = [];
  if (difficulty) tags.push(`\`${difficulty}\``);
  if (ipa && isWord) tags.push(`\`/${ipa.startsWith("/") ? ipa.slice(1) : ipa}\``);
  if (register) tags.push(`\`${register}\``);
  if (tags.length > 0) {
    core.push(tags.join(" "));
  }

  // ── Definitions block (core) ──
  const defs = (ai.definitions || []).filter((d) => d.definition || d.gloss);
  if (defs.length > 0) {
    core.push("");
    core.push("**Definitions**");
    for (const d of defs.slice(0, 5)) {
      const posTag = d.pos ? `\`${d.pos}\` ` : "";
      const gloss = d.gloss ? ` ${d.gloss}` : "";
      core.push(`- ${posTag}${d.definition}${gloss}`);
    }
  }

  // ── Examples (details) ──
  const examples = ai.examples || [];
  if (examples.length > 0) {
    details.push("**Examples**");
    for (const ex of examples.slice(0, 5)) {
      details.push(`- ${ex.sentence}`);
      if (ex.translation) details.push(`  ${ex.translation}`);
    }
  }

  // ── Collocations (details) ──
  const colls = ai.collocations || [];
  if (colls.length > 0) {
    details.push("");
    details.push("**Collocations**");
    for (const c of colls) {
      details.push(`- **${c.phrase}** ${c.translation}`);
    }
  }

  // ── Alternatives (details) ──
  const alts = ai.alternatives || [];
  if (alts.length > 0) {
    details.push("");
    details.push("**Alternatives**");
    for (const a of alts) {
      const reg = a.register ? ` \`${a.register}\`` : "";
      details.push(`- **${a.expression}**${reg}`);
    }
  }

  return { core, details };
}

// ==========================================================================
// V2 block builders — match AIAnnotationResultV2 sub-views
// ==========================================================================

function buildV2Blocks(ai: ParsedAIResult): DetailLines {
  const output = ai.output;
  if (!output) return { core: [], details: [] };

  // Word output — has meanings array (distinct from PhraseOutputV2)
  if (output.meanings) {
    return buildV2WordBlocks(ai, output);
  }
  // Phrase output: translation + examples (no meanings)
  if (output.translation && output.examples) {
    return buildV2PhraseBlocks(output);
  }
  // Sentence output: translation only (no examples, no meanings)
  if (output.translation) {
    return buildV2SentenceBlocks(output);
  }

  return { core: [], details: [] };
}

function buildV2WordBlocks(
  ai: ParsedAIResult,
  output: NonNullable<ParsedAIResult["output"]>,
): DetailLines {
  const core: string[] = [];
  const details: string[] = [];

  // ── CEFR & Lemma (core) ──
  const tags: string[] = [];
  if (output.cefr) tags.push(`\`${output.cefr}\``);
  if (ai.input?.lemma) tags.push(`\`${ai.input.lemma}\``);
  if (tags.length > 0) {
    core.push("**CEFR & Lemma**");
    core.push("");
    core.push(tags.join(" "));
  }

  // ── Meanings (core) — ordered by frequency ──
  if (output.meanings && output.meanings.length > 0) {
    core.push("");
    core.push("**Meanings**");
    core.push("");
    for (const m of output.meanings) {
      core.push(`- \`${m.pos}\` ${m.translation}`);
    }
  }

  // ── Definitions (details) ──
  if (output.definitions && output.definitions.length > 0) {
    details.push("");
    details.push("**Definitions**");
    details.push("");
    for (const d of output.definitions) {
      details.push(`- \`${d.pos}\` ${d.definition.source}`);
      details.push(`  ${d.definition.target}`);
    }
  }

  // ── Examples (details) ──
  if (output.examples && output.examples.length > 0) {
    details.push("");
    details.push("**Examples**");
    details.push("");
    for (const ex of output.examples) {
      details.push(`- ${ex.sentence}`);
      if (ex.translation) details.push(`  ${ex.translation}`);
    }
  }

  // ── Collocations (details) ──
  if (output.collocations && output.collocations.length > 0) {
    details.push("");
    details.push("**Collocations**");
    details.push("");
    for (const c of output.collocations) {
      details.push(`- ${c.phrase} ${c.translation}`);
    }
  }

  // ── Synonyms (details) ──
  if (output.synonyms && output.synonyms.length > 0) {
    details.push("");
    details.push("**Synonyms**");
    details.push("");
    details.push(output.synonyms.join(", "));
  }

  return { core, details };
}

function buildV2PhraseBlocks(
  output: NonNullable<ParsedAIResult["output"]>,
): DetailLines {
  const core: string[] = [];
  const details: string[] = [];

  // ── Translation (core) ──
  if (output.translation) {
    core.push(`**Translation**  \n${output.translation}`);
  }

  // ── Examples (details) ──
  if (output.examples && output.examples.length > 0) {
    details.push("");
    details.push("**Examples**");
    for (const ex of output.examples) {
      details.push(`- ${ex.sentence}`);
      if (ex.translation) details.push(`  ${ex.translation}`);
    }
  }

  return { core, details };
}

function buildV2SentenceBlocks(
  output: NonNullable<ParsedAIResult["output"]>,
): DetailLines {
  const core: string[] = [];

  // ── Translation (core, only section) ──
  if (output.translation) {
    core.push(`**Translation**  \n${output.translation}`);
  }

  return { core, details: [] };
}

/**
 * Build a complete Markdown note for one Siltflow document.
 *
 * Single-file layout: frontmatter + title + AI summary callout + one
 * card-style callout per annotation. Cards render their sections only when
 * that section has content (empty fields never appear).
 */
export function buildMarkdownNote(
  data: DocumentRenderData,
  options: FormatterOptions,
): string {
  const sections: string[] = [];

  // 1. YAML frontmatter (provenance)
  sections.push(buildFrontmatter(data));

  // 2. Document title
  sections.push(`# ${escapeYamlValue(data.doc.title)}`);
  sections.push("");

  // 3. AI summary (if present)
  if (data.summary) {
    sections.push(buildSummaryCallout(data.summary.text, data.aiVersion));
  }

  // 4. Annotation cards
  if (data.annotations.length > 0) {
    sections.push("---");
    sections.push("");
    sections.push("## Annotations");
    sections.push("");

    for (const ann of data.annotations) {
      sections.push(buildAnnotationCard(ann, data, options));
    }
  }

  return sections.join("\n") + "\n";
}

export interface FormatterOptions {
  /** Controls the fold marker on each annotation callout. */
  calloutFold: "expanded" | "collapsed" | "none";
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function buildFrontmatter(data: DocumentRenderData): string {
  const fm: Record<string, unknown> = {
    siltflow_doc_id: data.doc.id,
    siltflow_source: data.doc.original_name || data.doc.title,
    // Keep the original import date on re-renders; only fresh notes stamp today.
    siltflow_imported: data.importedAt || new Date().toISOString().slice(0, 10),
    siltflow_ai_version: data.aiVersion || 0,
    pages: data.doc.total_pages ?? null,
  };

  fm["tags"] = ["siltflow"];

  // `siltflow_imported` must be a bare date so Obsidian types it as Date.
  return "---\n" + toWordYAML(fm, new Set(["siltflow_imported"])) + "\n---\n";
}

// ---------------------------------------------------------------------------
// Callout builders
// ---------------------------------------------------------------------------

function buildSummaryCallout(text: string, aiVersion: number): string {
  const lines: string[] = [];
  // No fold marker (`+`/`-`) — an always-expanded callout that can't be
  // collapsed in Obsidian.
  lines.push(`> [!summary] Summary`);
  if (aiVersion > 0) {
    lines.push(`> <!-- siltflow-ai-version: ${aiVersion} -->`);
  }
  for (const line of text.split("\n")) {
    lines.push(`> ${line}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render one annotation as a card-style callout.
 *
 * Layout:
 *   [!siltflow] word                ← title (fold per calloutFold setting)
 *   <!-- siltflow-annotation: ID, ai-version: N -->   ← diff anchor
 *   **翻译**                        ← big translation (first paragraph)
 *   <AI sections: CEFR/Lemma, Meanings, Definitions, Examples, ...>
 *
 * Empty sections are omitted at generation time.
 */
function buildAnnotationCard(
  ann: AnnotationRow,
  data: DocumentRenderData,
  options: FormatterOptions,
): string {
  const ai = data.aiResults.get(ann.id);
  const aiVersion = data.aiVersions.get(ann.id) ?? 0;

  const word =
    ai?.input?.normalized || ai?.input?.text || ann.text || ann.type || "untitled";
  const titleText = word.replace(/\n/g, " ").trim().slice(0, 80);

  const fold =
    options.calloutFold === "collapsed"
      ? "-"
      : options.calloutFold === "expanded"
        ? "+"
        : "";

  const parts: string[] = [];
  parts.push(`> [!siltflow]${fold} ${titleText}`);

  // Embedded metadata for incremental import
  const meta: string[] = [`siltflow-annotation: ${ann.id}`];
  if (aiVersion > 0) {
    meta.push(`ai-version: ${aiVersion}`);
  }
  parts.push(`> <!-- ${meta.join(", ")} -->`);

  const body: string[] = [];

  // ── Big translation (card's visual anchor) ──
  const translation = extractAITranslation(ai);
  if (translation) {
    body.push(`<span class="card-translation">${escapeInline(translation)}</span>`);
  }

  // ── AI detail sections (translation already shown in the header — strip it) ──
  if (ai) {
    const { core, details } = buildAIDetailBlocks(ai, ann.text ?? "");
    const coreFiltered = core.filter((l) => !l.startsWith("**Translation**"));
    if (coreFiltered.length > 0 || details.length > 0) {
      body.push("");
    }
    body.push(...coreFiltered, ...details);
  }

  // If nothing was rendered (no AI), fall back to the raw text.
  if (body.length === 0 && ann.text) {
    body.push(ann.text);
  }

  for (const line of body) {
    if (line === "") {
      parts.push(">");
    } else {
      parts.push("> " + line.replace(/\n/g, "\n> "));
    }
  }

  parts.push("");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

/**
 * Minimal YAML serializer for frontmatter.
 *
 * Deliberately avoids external YAML dependency — Obsidian plugins should
 * keep bundle size minimal. Only handles strings, numbers, booleans,
 * null, arrays, and flat objects.
 */
function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    // YAML quoting: quote if contains special chars, starts with quote, or empty
    if (
      /[:{}[\]&*#?|!%@`]/.test(value) ||
      value === "" ||
      /^\d/.test(value) ||
      /^['"]/.test(value)
    ) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `"${String(value)}"`;
}

/**
 * YAML serializer for word-note frontmatter.
 *
 * String values that belong to a `dateKeys` key are emitted **unquoted** so
 * Obsidian infers the Date type (a quoted date is Text). All other strings
 * go through `formatScalar` as before.
 */
function toWordYAML(
  obj: Record<string, unknown>,
  dateKeys: Set<string>,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${formatScalar(item)}`);
      }
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k2}: ${formatScalar(v2)}`);
      }
    } else if (typeof value === "string" && dateKeys.has(key)) {
      // Emit dates bare so Obsidian types them as Date.
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return lines.join("\n");
}

function escapeYamlValue(value: string): string {
  // Escape characters that would break Markdown or YAML
  return value.replace(/"/g, '\\"');
}

/**
 * Escape a raw string for safe embedding inside inline HTML (`<span>`) in
 * markdown. HTML entities are escaped so the content renders as plain text;
 * markdown inside the span is still parsed by Obsidian.
 */
function escapeInline(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
