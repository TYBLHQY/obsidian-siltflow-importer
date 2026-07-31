/**
 * Markdown formatter — converts Siltflow DB data into Obsidian Markdown notes.
 *
 * Output format: YAML frontmatter + document title + AI summary callout +
 * annotation callouts with bilingual content (原文 / 翻译 / 解释).
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
    sections.push("## 标注");
    sections.push("");

    for (const ann of data.annotations) {
      const ai = data.aiResults.get(ann.id);
      if (options.annotationFormat === "table") {
        sections.push(buildAnnotationTable(ann, ai, data.aiVersion));
      } else {
        sections.push(buildAnnotationCallout(ann, ai, data.aiVersion, options));
      }
    }
  }

  return sections.join("\n") + "\n";
}

export interface FormatterOptions {
  annotationFormat: "callout" | "table";
  includeAIResults: boolean;
  includeFSRSStats: boolean;
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

  return "---\n" + toYAML(fm) + "---\n";
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
  const fold = ann.type === "highlight" ? "+" : "-";
  const pageInfo = ann.page_number ? ` 第 ${ann.page_number} 页` : "";
  const parts: string[] = [];

  parts.push(`> [!${ann.type}]${fold}${pageInfo}`);

  // Embedded metadata for incremental import
  const metaParts: string[] = [`siltflow-annotation: ${ann.id}`];
  if (aiVersion > 0) {
    metaParts.push(`ai-version: ${aiVersion}`);
  }
  parts.push(`> <!-- ${metaParts.join(", ")} -->`);

  if (ann.text) {
    parts.push("> **原文**: " + ann.text.replace(/\n/g, "\n> "));
  }

  if (options.includeAIResults && ai) {
    if (ai.translation) {
      parts.push(">");
      parts.push("> **翻译**: " + ai.translation);
    }
    if (ai.explanation) {
      parts.push(">");
      parts.push("> **解释**:");
      for (const line of ai.explanation.split("\n")) {
        parts.push(`> ${line}`);
      }
    }
  }

  parts.push("");
  return parts.join("\n");
}

function buildAnnotationTable(
  ann: AnnotationRow,
  ai: ParsedAIResult | undefined,
  _aiVersion: number,
): string {
  // Simple markdown table for compact view
  const page = ann.page_number ?? "-";
  const text = (ann.text ?? "").slice(0, 80);
  const translation = ai?.translation ?? "-";
  return `| ${page} | ${text} | ${translation} |`;
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
    // YAML quoting: quote if contains special chars or looks ambiguous
    if (/[:{}[\]&*#?|!%@`]/.test(value) || value === "" || /^\d/.test(value)) {
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
