/**
 * Markdown formatter — converts Siltflow DB data into Obsidian Markdown notes.
 *
 * Output format: YAML frontmatter + document title + AI summary callout +
 * annotation callouts with bilingual content (Original / Translation / Analysis).
 *
 * Each annotation callout embeds an HTML comment with its siltflow-annotation
 * ID and AI version for incremental import diffing.
 */
import type {
  DocumentImportData,
  AnnotationRow,
  ParsedAIResult,
} from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to infer target language from AI data (V1 target_lang or V2 meanings translations).
 */
export function detectTargetLang(ai: ParsedAIResult): string | null {
  if (ai.target_lang) return ai.target_lang;
  // V2: no explicit target_lang; infer from context (most commonly zh-CN for Siltflow)
  if (ai.output?.meanings?.length) return "zh-CN";
  if (ai.output?.translation) return "zh-CN";
  return null;
}

/**
 * Extract the best available translation from a ParsedAIResult,
 * handling both V1 and V2 data formats.
 */
export function extractAITranslation(ai: ParsedAIResult): string | null {
  // V1: flat translation field
  if (ai.translation) return ai.translation;
  // V1 legacy: deprecated translate field
  if (ai.translate) return ai.translate;

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
export function buildAIDetailBlocks(ai: ParsedAIResult, text: string): DetailLines {
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
  const translation = ai.translation || ai.translate;
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

  // ── V1 legacy deprecated: words ──
  if (ai.words && ai.words.length > 0) {
    details.push("");
    details.push("**Words**");
    for (const w of ai.words) {
      const posTag = w.pos ? `\`${w.pos}\` ` : "";
      details.push(`- ${posTag}${w.meaning}`);
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
    core.push(`**CEFR & Lemma**  \n${tags.join(" ")}`);
  }

  // ── Meanings (core) — ordered by frequency ──
  if (output.meanings && output.meanings.length > 0) {
    core.push("");
    core.push("**Meanings**");
    for (const m of output.meanings) {
      core.push(`- \`${m.pos}\` ${m.translation}`);
    }
  }

  // ── Definitions (details) ──
  if (output.definitions && output.definitions.length > 0) {
    details.push("**Definitions**");
    for (const d of output.definitions) {
      details.push(`- \`${d.pos}\` ${d.definition.source}`);
      details.push(`  ${d.definition.target}`);
    }
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

  // ── Collocations (details) ──
  if (output.collocations && output.collocations.length > 0) {
    details.push("");
    details.push("**Collocations**");
    for (const c of output.collocations) {
      details.push(`- **${c.phrase}** ${c.translation}`);
    }
  }

  // ── Synonyms (details) ──
  if (output.synonyms && output.synonyms.length > 0) {
    details.push("");
    details.push(`**Synonyms**  \n${output.synonyms.join(", ")}`);
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
 */
export function buildMarkdownNote(
  data: DocumentImportData,
  options: FormatterOptions,
): string {
  const sections: string[] = [];

  // 1. YAML frontmatter
  sections.push(buildFrontmatter(data));

  // 2. Document title
  sections.push(`# ${escapeYamlValue(data.doc.title)}`);
  sections.push("");

  // 3. AI summary (if present)
  if (data.summary) {
    sections.push(buildSummaryCallout(data.summary.text, data.aiVersion));
  }

  // 4. Annotation header + callouts
  if (data.annotations.length > 0) {
    sections.push("---");
    sections.push("");
    sections.push("## Annotations");
    sections.push("");

    for (const ann of data.annotations) {
      const ai = data.aiResults.get(ann.id);
      sections.push(buildAnnotationCallout(ann, ai, data.aiVersion, options));
    }
  }

  return sections.join("\n") + "\n";
}

export interface FormatterOptions {
  includeAIResults: boolean;
  includeFSRSStats: boolean;
  calloutFold: "expanded" | "collapsed" | "none";
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function buildFrontmatter(data: DocumentImportData): string {
  const fm: Record<string, unknown> = {
    siltflow_doc_id: data.doc.id,
    siltflow_source: data.doc.original_name || data.doc.title,
    siltflow_imported: new Date().toISOString().slice(0, 10),
    siltflow_ai_version: data.aiVersion || 0,
    pages: data.doc.total_pages ?? null,
  };

  const totalCards = data.fsrsCards.length;
  if (totalCards > 0) {
    fm["total_cards"] = totalCards;

    // Count FSRS card states
    let newCount = 0;
    let dueCount = 0;
    for (const card of data.fsrsCards) {
      try {
        const parsed = JSON.parse(card.data);
        if (parsed.state === "New" || parsed.state === 0) {
          newCount++;
        } else if (parsed.due) {
          const due = new Date(parsed.due);
          if (due.getTime() <= Date.now()) {
            dueCount++;
          }
        }
      } catch {
        // skip unparseable cards
      }
    }
    fm["new_cards"] = newCount;
    fm["due_cards"] = dueCount;
  }

  fm["tags"] = ["siltflow"];

  return "---\n" + toYAML(fm) + "\n---\n";
}

// ---------------------------------------------------------------------------
// Callout builders
// ---------------------------------------------------------------------------

function buildSummaryCallout(text: string, aiVersion: number): string {
  const lines: string[] = [];
  lines.push(`> [!summary]- AI 摘要`);
  if (aiVersion > 0) {
    lines.push(`> <!-- siltflow-ai-version: ${aiVersion} -->`);
  }
  for (const line of text.split("\n")) {
    lines.push(`> ${line}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildAnnotationCallout(
  ann: AnnotationRow,
  ai: ParsedAIResult | undefined,
  aiVersion: number,
  options: FormatterOptions,
): string {
  const fold =
    options.calloutFold === "none"
      ? ""
      : options.calloutFold === "expanded"
        ? "-"
        : "+";
  const titleText = ann.text
    ? ann.text.replace(/\n/g, " ").slice(0, 60)
    : ann.type;
  const parts: string[] = [];

  parts.push(`> [!${ann.type}]${fold} ${titleText}`);

  // Embedded metadata for incremental import
  const metaParts: string[] = [`siltflow-annotation: ${ann.id}`];
  if (aiVersion > 0) {
    metaParts.push(`ai-version: ${aiVersion}`);
  }
  parts.push(`> <!-- ${metaParts.join(", ")} -->`);

  const bodyLines: string[] = [];

  // ── AI header: source/target language ──
  const langParts: string[] = [];
  if (ai?.input?.source_lang) langParts.push(`Source: \`${ai.input.source_lang}\``);
  const targetLang = ai?.target_lang || (ai ? detectTargetLang(ai) : null);
  if (targetLang) langParts.push(`Target: \`${targetLang}\``);

  if (ann.page_number) {
    bodyLines.push(`**Page**: ${ann.page_number}`);
  }
  if (ann.text) {
    bodyLines.push(ann.text.replace(/\n/g, "\n> "));
  }

  // ── AI results (matches upstream Siltflow card layout) ──
  if (options.includeAIResults && ai) {
    if (langParts.length > 0) {
      bodyLines.push("");
      bodyLines.push(langParts.join(" | "));
    }

    const { core, details } = buildAIDetailBlocks(ai, ann.text ?? "");

    // Core content (translation, meta tags, definitions/meanings)
    bodyLines.push(...core);
    // Details (examples, collocations, alternatives, synonyms)
    bodyLines.push(...details);
  }

  for (const line of bodyLines) {
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
function toYAML(obj: Record<string, unknown>): string {
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
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return lines.join("\n");
}

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

function escapeYamlValue(value: string): string {
  // Escape characters that would break Markdown or YAML
  return value.replace(/"/g, '\\"');
}
