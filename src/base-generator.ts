/**
 * Base file generator — creates and updates `_Siltflow.base`.
 *
 * The .base file is a YAML-declared Obsidian Bases view. It provides
 * table and card views of imported Siltflow documents with filtering,
 * sorting, summaries, and formula-driven urgency labels.
 *
 * On update, user-customized `properties` display names are preserved
 * to avoid overwriting manual tweaks.
 */
import type { App } from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BaseTemplate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  filters: Record<string, unknown>;
  formulas: Record<string, string>;
  properties: Record<string, { displayName: string }>;
  views: Array<Record<string, unknown>>;
}

// Default template for first-time generation
const BASE_TEMPLATE: BaseTemplate = {
  filters: {
    and: [
      `'file.hasTag("siltflow")'`,
      `'file.inFolder("Siltflow")'`,
    ],
  },

  formulas: {
    days_since_import: `'(now() - file.ctime).days'`,
    study_progress:
      `'if(total_cards > 0, ((total_cards - new_cards - 0.0) / total_cards * 100).round(0).toString() + "%", "")'`,
    urgency:
      `'if(due_cards > 0, "🔴 " + due_cards, if(new_cards > 0, "🟡 new", "🟢 ok"))'`,
    ai_version_display: `'if(siltflow_ai_version, siltflow_ai_version, "N/A")'`,
  },

  properties: {
    siltflow_source: { displayName: "来源文件" },
    "formula.urgency": { displayName: "状态" },
    "formula.study_progress": { displayName: "学习进度" },
    "formula.days_since_import": { displayName: "导入天数" },
    "formula.ai_version_display": { displayName: "AI 版本" },
    total_cards: { displayName: "总卡片" },
    new_cards: { displayName: "新卡片" },
    due_cards: { displayName: "待复习" },
    pages: { displayName: "页数" },
  },

  views: [
    {
      type: "table",
      name: "全部文档",
      order: [
        "file.name",
        "formula.urgency",
        "formula.study_progress",
        "total_cards",
        "new_cards",
        "due_cards",
        "siltflow_source",
        "formula.ai_version_display",
        "formula.days_since_import",
      ],
      summaries: {
        total_cards: "Sum",
        new_cards: "Sum",
        due_cards: "Sum",
      },
    },
    {
      type: "table",
      name: "待复习",
      filters: {
        and: [`'due_cards > 0'`],
      },
      order: ["file.name", "due_cards", "new_cards", "formula.urgency"],
      summaries: {
        due_cards: "Sum",
      },
    },
    {
      type: "cards",
      name: "卡片视图",
      order: [
        "file.name",
        "formula.urgency",
        "formula.study_progress",
        "siltflow_source",
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the full YAML content for a new _Siltflow.base file.
 */
export function generateBaseFileContent(): string {
  return toBaseYAML(BASE_TEMPLATE);
}

/**
 * Update an existing .base file content with new known properties.
 *
 * Preservation rules:
 * - Keep all user-defined views (those not matching the default set)
 * - Keep user-defined formulas
 * - Add new frontmatter properties to the "全部文档" view order
 * - Preserve user-customized `properties` displayName values
 */
export function updateBaseFileContent(
  existingYaml: string,
  newPropertyNames: string[],
): string {
  const existing = parseBaseYAML(existingYaml);
  if (!existing) {
    // Can't parse — generate fresh
    return generateBaseFileContent();
  }

  // Merge new properties into the existing set
  if (!existing.properties) {
    existing.properties = {};
  }
  for (const name of newPropertyNames) {
    if (!existing.properties[name]) {
      existing.properties[name] = { displayName: name };
    }
  }

  // Add new properties to the "全部文档" view order if it exists
  const allDocsView = existing.views?.find(
    (v: Record<string, unknown>) => v.name === "全部文档" && v.type === "table",
  );
  if (allDocsView && Array.isArray((allDocsView as Record<string, unknown>).order)) {
    const orderArr = (allDocsView as Record<string, unknown>).order as string[];
    for (const name of newPropertyNames) {
      if (!orderArr.includes(name)) {
        orderArr.push(name);
      }
    }
  }

  return toBaseYAML(existing);
}

// ---------------------------------------------------------------------------
// YAML serialization for .base files
// ---------------------------------------------------------------------------

/**
 * Serialize a BaseTemplate or partial base config to .base YAML format.
 */
function toBaseYAML(obj: BaseTemplate): string {
  const lines: string[] = [];
  appendYAML(lines, obj, 0);
  return lines.join("\n") + "\n";
}

function appendYAML(
  lines: string[],
  obj: Record<string, unknown>,
  indent: number,
): void {
  const pad = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      // Array of primitives
      if (value.length > 0 && typeof value[0] !== "object") {
        lines.push(`${pad}${key}:`);
        for (const item of value) {
          lines.push(`${pad}  - ${formatBaseScalar(item)}`);
        }
      }
      // Array of objects (e.g., views)
      else {
        lines.push(`${pad}${key}:`);
        for (const item of value) {
          if (typeof item === "object" && item !== null) {
            lines.push(`${pad}  -`); // Start a new list item
            appendYAML(
              lines,
              item as Record<string, unknown>,
              indent + 2,
            );
          } else {
            // Primitive in an object array — shouldn't happen but guard
            lines.push(`${pad}  - ${formatBaseScalar(item)}`);
          }
        }
      }
    } else if (typeof value === "object" && value !== null) {
      lines.push(`${pad}${key}:`);
      appendYAML(lines, value as Record<string, unknown>, indent + 1);
    } else {
      lines.push(`${pad}${key}: ${formatBaseScalar(value)}`);
    }
  }
}

function formatBaseScalar(value: unknown): string {
  if (typeof value === "string") {
    // Already YAML-quoted — pass through as-is
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      return value;
    }
    // Quote strings that contain YAML special characters
    if (/[:{}[\]&*#?|!%@`]/.test(value) || value === "") {
      // Use single quotes for formulas that have double quotes inside
      if (value.includes('"')) {
        return `'${value.replace(/'/g, "''")}'`;
      }
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// ---------------------------------------------------------------------------
// Minimal YAML parser for .base files
// ---------------------------------------------------------------------------

function parseBaseYAML(
  yaml: string,
): BaseTemplate | null {
  try {
    // Simple line-based parsing — sufficient for .base structure
    const obj: BaseTemplate = { filters: {}, formulas: {}, properties: {}, views: [] };
    let currentKey: string | null = null;

    for (const line of yaml.split("\n")) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;

      const indent = line.search(/\S/);

      if (indent === 0) {
        // Top-level key
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        currentKey = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        if (val === "") {
          if (currentKey === "views") {
            obj.views = [];
          } else if (currentKey === "filters") {
            obj.filters = {};
          } else {
            (obj as Record<string, unknown>)[currentKey] = {};
          }
        } else {
          (obj as Record<string, unknown>)[currentKey] = parseBaseValue(val);
        }
      }
    }

    return obj;
  } catch {
    return null;
  }
}

function parseBaseValue(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  // Strip quotes
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}
