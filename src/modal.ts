/**
 * Document Selection Modal — two-phase: loading spinner → document list.
 *
 * Handles its own loading animation internally. Consumers pass callbacks
 * for DB resolution and final import — the modal just opens and drives
 * the whole flow.
 */
import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { openDatabase, queryAll, closeDatabase } from "./db";
import type { DocumentRow, AnnotationRow } from "./types";

export interface ImportModalCallbacks {
  /** Current incremental mode. */
  mode: string;
  /** Called when user changes the import mode in the footer dropdown. */
  onModeChange: (mode: "append" | "update" | "overwrite") => void;
  /** Called to resolve the DB path (may involve a file picker).
   *  Throw "cancelled" to abort silently. */
  getDbPath: () => Promise<string>;
  /** Called with the user's selected document IDs to run the import. */
  onImport: (selectedIds: string[]) => Promise<void>;
  /** Show an error notice (modal stays open). */
  onError: (message: string) => void;
}

export class DocumentSelectionModal extends Modal {
  private readonly cb: ImportModalCallbacks;

  // Selection state (populated in Phase 2)
  private checkboxes = new Map<string, HTMLInputElement>();
  private selectionResolve: ((ids: string[] | null) => void) | null = null;
  private running = false;

  constructor(app: App, cb: ImportModalCallbacks) {
    super(app);
    this.cb = cb;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  onOpen(): void {
    const { modalEl, titleEl } = this;

    modalEl.addClass("siltflow-importer-modal");

    titleEl.empty();
    titleEl.createEl("span", { text: "Siltflow" }).addClass("siltflow-brand");
    titleEl.createSpan({ text: "导入" });

    this.showLoading();
    this.run();
  }

  onClose(): void {
    this.contentEl.empty();
    this.titleEl.empty();
    if (this.selectionResolve) {
      this.selectionResolve(null);
      this.selectionResolve = null;
    }
  }

  // ── Internal flow ──────────────────────────────────────────────────

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      // Phase 1 — loading spinner is already shown by onOpen
      this.showLoading();

      // Yield to the event loop so the browser paints the spinner before
      // any heavy work (WASM init, DB reads) blocks the main thread.
      await new Promise((r) => setTimeout(r, 50));

      const dbPath = await this.cb.getDbPath();
      const documents = await this.loadDocuments(dbPath);
      if (!documents) return; // error already handled

      // Phase 2 — transition to document list
      this.showDocuments(documents);

      const selectedIds = await this.waitForSelection();
      if (!selectedIds || selectedIds.length === 0) {
        this.close();
        return;
      }
      this.close();

      await this.cb.onImport(selectedIds);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "cancelled") {
        this.close();
        return;
      }
      this.cb.onError(
        `❌ ${err instanceof Error ? err.message : String(err)}`,
      );
      this.close();
    } finally {
      this.running = false;
    }
  }

  private async loadDocuments(
    dbPath: string,
  ): Promise<DocumentRow[] | null> {
    try {
      const db = await openDatabase(dbPath);
      try {
        const docs = queryAll<DocumentRow>(db, "SELECT * FROM documents");
        if (docs.length === 0) {
          this.cb.onError("⚠️ No documents found in the Siltflow database.");
          this.close();
          return null;
        }

        // Filter to only show docs that have annotations
        const annotations = queryAll<AnnotationRow>(
          db,
          "SELECT * FROM annotations",
        );

        const docIdsWithData = new Set<string>();
        for (const ann of annotations) {
          docIdsWithData.add(ann.document_id);
        }

        const filteredDocs = docs.filter((d) => docIdsWithData.has(d.id));

        if (filteredDocs.length === 0) {
          this.cb.onError(
            "⚠️ No documents with annotations found in the database.",
          );
          this.close();
          return null;
        }

        return filteredDocs;
      } finally {
        closeDatabase(db);
      }
    } catch (err) {
      this.cb.onError(`❌ Failed to open database: ${err}`);
      this.close();
      return null;
    }
  }

  // ── Phase 1: Loading spinner ───────────────────────────────────────

  private showLoading(): void {
    const { contentEl } = this;
    contentEl.empty();

    const container = contentEl.createDiv("siltflow-loading-container");
    const spinner = container.createDiv("siltflow-spinner");
    container.createDiv("siltflow-loading-text").setText("正在加载文档列表…");

    // Force reflow to restart CSS animation on re-open.
    void spinner.offsetWidth;
  }

  // ── Phase 2: Document list ─────────────────────────────────────────

  private showDocuments(documents: DocumentRow[]): void {
    const { contentEl } = this;
    contentEl.empty();

    // Info bar
    const infoBar = contentEl.createDiv("siltflow-info-bar");
    infoBar.createSpan({
      text: `共 ${documents.length} 个文档 — 勾选要导入的文档`,
    });

    // Scrollable list
    const listWrapper = contentEl.createDiv("siltflow-list-wrapper");

    for (const doc of documents) {
      const row = listWrapper.createDiv("siltflow-doc-row");

      const checkbox = row.createEl("input", {
        type: "checkbox",
        attr: { checked: "checked" },
      });
      checkbox.addClass("siltflow-checkbox");
      this.checkboxes.set(doc.id, checkbox);

      const label = row.createEl("label", "siltflow-doc-label");
      const titleLine = label.createDiv("siltflow-doc-title");
      titleLine.setText(doc.title);

      const metaLine = label.createDiv("siltflow-doc-meta");
      if (doc.total_pages) {
        metaLine.createSpan({ text: `${doc.total_pages} 页` });
      }
      if (doc.original_name && doc.original_name !== doc.title) {
        metaLine.createSpan({ text: `来源: ${doc.original_name}` });
      }
    }

    // Footer
    const footer = contentEl.createDiv("siltflow-footer");

    // Select all / none
    const selectRow = footer.createDiv("siltflow-select-row");
    const selectAllBtn = selectRow.createEl("button", {
      text: "全选",
      cls: "siltflow-btn-ghost",
    });
    selectAllBtn.addEventListener("click", () => {
      this.checkboxes.forEach((cb) => (cb.checked = true));
    });

    const selectNoneBtn = selectRow.createEl("button", {
      text: "取消",
      cls: "siltflow-btn-ghost",
    });
    selectNoneBtn.addEventListener("click", () => {
      this.checkboxes.forEach((cb) => (cb.checked = false));
    });

    const selectedCount = selectRow.createSpan("siltflow-selected-count");
    selectedCount.setText(`已选 ${documents.length} 个`);
    const updateCount = () => {
      let n = 0;
      this.checkboxes.forEach((cb) => (n += cb.checked ? 1 : 0));
      selectedCount.setText(`已选 ${n} 个`);
    };
    this.checkboxes.forEach((cb) => {
      cb.addEventListener("change", updateCount);
    });

    // Mode selector
    const modeRow = footer.createDiv("siltflow-mode-row");
    modeRow.createSpan({ text: "导入模式", cls: "siltflow-label" });
    const modeSelect = modeRow.createEl("select", "dropdown");
    const modes: Array<{ value: string; label: string; desc: string }> = [
      { value: "append", label: "增量追加", desc: "只添加新文档和标注" },
      { value: "update", label: "增量更新", desc: "追加 + 更新已有 AI 结果" },
      { value: "overwrite", label: "全量覆盖", desc: "删除全部重新生成" },
    ];
    for (const m of modes) {
      modeSelect.createEl("option", {
        text: `${m.label} — ${m.desc}`,
        attr: { value: m.value },
      });
    }
    modeSelect.value = this.cb.mode;
    modeSelect.addEventListener("change", () => {
      this.cb.onModeChange(modeSelect.value as "append" | "update" | "overwrite");
    });

    // Action buttons
    const buttonRow = footer.createDiv("siltflow-button-row");

    const cancelBtn = buttonRow.createEl("button", {
      text: "取消",
      cls: "siltflow-btn-ghost",
    });
    cancelBtn.addEventListener("click", () => {
      this.selectionResolve?.(null);
    });

    const importBtn = buttonRow.createEl("button", {
      text: "开始导入",
      cls: "mod-cta siltflow-import-btn",
    });
    importBtn.addEventListener("click", () => {
      const selected: string[] = [];
      this.checkboxes.forEach((cb, id) => {
        if (cb.checked) selected.push(id);
      });
      this.selectionResolve?.(selected);
    });
  }

  private waitForSelection(): Promise<string[] | null> {
    return new Promise((resolve) => {
      this.selectionResolve = resolve;
    });
  }
}
