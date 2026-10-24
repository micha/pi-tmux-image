import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { getCapabilities, getCellDimensions, MouseRegion, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { convertToPng, createReadTool, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureLayout, createNativeRenderer, NATIVE_SCHEMA, readLegacyDetails, readNativeDetails, sanitizeDisplayText } from "../../src/native.mjs";
import { createPdfDocumentService, PDF_SCHEMA, readPdfDetails, readPdfPreviewDetails } from "../../src/pdf-document.mjs";
import { createPresentation } from "../../src/presentation.mjs";
import { createViewerController, indexSnapshots } from "../../src/viewer.mjs";
import { checkDisplayPolicy, resolvePiDisplayPolicy, TmuxCapabilityDetector } from "../../src/capabilities.mjs";

const MESSAGE_TYPE = "pi-tmux-image";

export default function (pi: ExtensionAPI, { createDocumentService = createPdfDocumentService } = {}) {
  const presentation = createPresentation();
  const native = createNativeRenderer({ convertToPng });
  const legacyOccurrences = new WeakMap<object, string>();
  const legacyEntryOccurrences = new Map<string, string>();
  const detector = new TmuxCapabilityDetector();
  let liveContext: ExtensionContext | undefined;
  let generation = 0;
  let capabilityFailure: string | undefined;
  const capabilityWarnings = new Set<string>();
  type PdfRuntime = { context: ExtensionContext; service: ReturnType<typeof createPdfDocumentService>; closed: boolean;
    importing?: { controller: AbortController; done: Promise<void> };
    submissions: Map<string, { sha256: string; retention: string }> };
  let pdfRuntime: PdfRuntime | undefined;
  const documentOwners = new WeakMap<object, PdfRuntime>();
  const viewer = createViewerController({ native, presentation,
    getContext: () => liveContext, getSnapshots: storedSnapshots, requireCapability,
    readyPolicy: (ctx: ExtensionContext) => checkDisplayPolicy(capabilityContext(ctx))?.message || capabilityFailure,
    openDocument: async (descriptor: any, options: { signal: AbortSignal }) => {
      const runtime = pdfRuntime;
      if (!runtime || runtime.closed) throw new Error("PDF session runtime is unavailable");
      const handle = await runtime.service.openDocument(descriptor, options);
      documentOwners.set(handle, runtime);
      return handle;
    },
    pageAttachment: (handle: object, page: number, options: { signal: AbortSignal }) => {
      const owner = documentOwners.get(handle);
      if (!owner || owner !== pdfRuntime || owner.closed) throw new Error("PDF session runtime was replaced");
      return owner.service.pageAttachment(handle, page, options);
    },
    releaseDocument: async (handle: object) => {
      const owner = documentOwners.get(handle);
      if (owner) {
        documentOwners.delete(handle);
        await owner.service.releaseDocument(handle);
      }
    },
    getCells: getCellDimensions, matchesKey, parseKey, truncateToWidth, visibleWidth, sanitizeText: sanitizeDisplayText,
    style: (kind: string, text: string) => liveContext?.ui.theme.fg(kind as any, text) || text,
    notify: (message: string, level: "info" | "warning" | "error") => liveContext?.ui.notify(message, level),
  });

  function legacyEntryOccurrence(id: string) {
    let occurrence = legacyEntryOccurrences.get(id);
    if (!occurrence) legacyEntryOccurrences.set(id, occurrence = randomUUID());
    return occurrence;
  }

  function storedSnapshots() {
    return indexSnapshots(liveContext?.sessionManager.getBranch() || [], (entry: any) => {
      if (entry.type !== "custom_message" || entry.customType !== MESSAGE_TYPE || !Array.isArray(entry.content)) return;
      const attachment = entry.content.find((block: any) => block.type === "image");
      if (!attachment || typeof attachment.data !== "string" || typeof attachment.mimeType !== "string") return;
      const pdf = readPdfDetails(entry.details);
      const details = readNativeDetails(entry.details) || readPdfPreviewDetails(entry.details) || readLegacyDetails(entry.details, legacyEntryOccurrence(entry.id));
      if (!details) return;
      return { occurrence: details.occurrence, label: details.label, attachment, ...(pdf ? { document: pdf.document } : {}) };
    });
  }

  function legacyMessageOccurrence(message: any) {
    const known = legacyOccurrences.get(message);
    if (known) return known;
    const attachment = Array.isArray(message.content) ? message.content.find((block: any) => block.type === "image") : undefined;
    const entries = liveContext?.sessionManager.getBranch() || [];
    const candidates = entries.filter((entry: any) => {
      if (entry.type !== "custom_message" || entry.customType !== MESSAGE_TYPE) return false;
      if (entry.content === message.content) return true;
      if (!attachment || Date.parse(entry.timestamp) !== message.timestamp || !Array.isArray(entry.content)) return false;
      const stored = entry.content.find((block: any) => block.type === "image");
      return stored?.mimeType === attachment.mimeType && stored?.data === attachment.data;
    });
    const occurrence = candidates.length === 1 ? legacyEntryOccurrence(candidates[0].id) : randomUUID();
    legacyOccurrences.set(message, occurrence);
    return occurrence;
  }

  function capabilityContext(ctx: ExtensionContext) {
    return { mode: ctx.mode, env: process.env, hostCapabilities: getCapabilities(),
      ...resolvePiDisplayPolicy(pi.getSettings(), process.env) };
  }

  function requireInteractive(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !process.env.TMUX || !/^%\d+$/.test(process.env.TMUX_PANE || "")) {
      throw new Error("pi-tmux-image requires interactive Pi inside tmux with a valid TMUX_PANE");
    }
  }

  async function requireCapability(ctx: ExtensionContext, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const expected = generation;
    const result = await detector.probe(capabilityContext(ctx), { checkVisibility: true });
    signal?.throwIfAborted();
    if (generation !== expected) throw new Error("Image capability query was superseded; retry after refresh");
    // Public policy may have changed while a bounded subprocess was running.
    const rejected = checkDisplayPolicy(capabilityContext(ctx)) || (!result.supported ? result : undefined);
    capabilityFailure = rejected ? sanitizeDisplayText(`${rejected.message} Run /tmux-image-refresh after correcting the terminal path or display policy.`) : undefined;
    if (capabilityFailure) throw new Error(capabilityFailure);
    for (const warning of result.warnings || []) {
      if (capabilityWarnings.has(warning)) continue;
      capabilityWarnings.add(warning);
      ctx.ui.notify(sanitizeDisplayText(warning), "warning");
    }
  }

  function notifyFailure(ctx: ExtensionContext, error: unknown) {
    ctx.ui.notify(sanitizeDisplayText(error instanceof Error ? error.message : String(error)), "error");
  }

  pi.on("session_start", (_event, ctx) => {
    generation++;
    detector.invalidate();
    capabilityFailure = undefined;
    capabilityWarnings.clear();
    liveContext = ctx;
    const runtime: PdfRuntime = { context: ctx, closed: false, submissions: new Map(), service: createDocumentService({
      acquireImage: (path: string, { signal }: { signal: AbortSignal }) => acquireImage(path, ctx, signal).then(({ attachment }) => attachment),
    }) };
    pdfRuntime = runtime;
    presentation.attach(ctx, Boolean(process.env.TMUX));
  });
  pi.on("session_shutdown", async () => {
    const runtime = pdfRuntime;
    if (runtime) { runtime.closed = true; runtime.importing?.controller.abort(); }
    // Revoke/hide/retire while the old public context still exists, then drain
    // source/page users before deleting runtime-only document snapshots.
    const importDone = runtime?.importing?.done;
    try { await Promise.all([viewer.close("session-shutdown"), importDone]); }
    finally {
      try {
        await importDone;
        await runtime?.service.dispose();
      } finally {
        if (pdfRuntime === runtime) pdfRuntime = undefined;
        generation++;
        detector.invalidate();
        capabilityFailure = undefined;
        capabilityWarnings.clear();
        liveContext = undefined;
        presentation.disconnect();
      }
    }
  });
  pi.on("session_tree", async () => { pdfRuntime?.importing?.controller.abort(); await viewer.close("branch-change"); });
  pi.on("agent_settled", async () => { if (pdfRuntime) await reconcileSubmissions(pdfRuntime); });

  async function reconcileSubmissions(runtime: PdfRuntime) {
    if (runtime.closed || pdfRuntime !== runtime) return;
    // ALL entries, not only active branch: abandoned branches still own originals.
    // Capture the final-boundary candidates before any cleanup await. Live Map
    // iteration would admit later submissions against an older history snapshot.
    const submissions = [...runtime.submissions];
    const entries = runtime.context.sessionManager.getEntries();
    for (const [occurrence, submission] of submissions) {
      if (runtime.closed || pdfRuntime !== runtime) return;
      if (runtime.submissions.get(occurrence) !== submission) continue;
      const present = entries.some((entry: any) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE &&
        entry.details?.schema === PDF_SCHEMA && entry.details?.occurrence === occurrence &&
        entry.details?.document?.sha256 === submission.sha256);
      if (!present && submission.retention === "temporary") await runtime.service.discardTemporary(occurrence, submission.sha256);
      if (!runtime.closed && pdfRuntime === runtime && runtime.submissions.get(occurrence) === submission) {
        runtime.submissions.delete(occurrence);
      }
    }
  }

  // Normal Pi image content, with no context filter. Pi's images.blockImages
  // controls model access independently of this local terminal renderer.
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const pdf = readPdfDetails(message.details);
    let details = readNativeDetails(message.details) || readPdfPreviewDetails(message.details);
    const attachment = Array.isArray(message.content) ? message.content.find((block) => block.type === "image") : undefined;
    if (!details && message.details && typeof message.details === "object" && !("schema" in message.details)) {
      details = readLegacyDetails(message.details, legacyMessageOccurrence(message));
    }
    if (!details || !attachment) {
      const reason = message.details && typeof message.details === "object" && "schema" in message.details &&
        message.details.schema !== NATIVE_SCHEMA && message.details.schema !== PDF_SCHEMA ? "unsupported display schema" : "missing or invalid image snapshot/display";
      return { render: (width: number) => [truncateToWidth(`[Image: ${reason}]`, width)], invalidate() {} };
    }
    const image = presentation.component({
      key: details.occurrence,
      layout: (width: number) => captureLayout(width, presentation.dimensions?.rows || 40, getCellDimensions()),
      prepare: async (_width: number, context: { epoch: symbol; signal: AbortSignal }, layout: { limits: { columns: number; rows: number }; cells: { widthPx: number; heightPx: number } }) => {
        const ctx = liveContext;
        if (!ctx) throw new Error("Image display is not connected to an interactive session");
        await requireCapability(ctx, context.signal);
        const prepared = await native.prepare({ attachment, occurrence: details.occurrence, limits: layout.limits, cells: layout.cells }, context);
        try {
          // Recheck before handing the transport reservation to the presentation
          // seam. A policy change/refresh must release it, not strand shared PNGs.
          await requireCapability(ctx, context.signal);
          return prepared;
        } catch (error) { prepared.onUploadFailed?.(error); throw error; }
      },
      fallback: (width: number, error?: Error) => [truncateToWidth(error ? `[Image: ${sanitizeDisplayText(error.message || error)}]` : "[Image: preparing native PNG]", width)],
    });
    let hit: { columns: number; rows: number } | undefined;
    const component = {
      render(width: number) {
        hit = undefined;
        if (!liveContext) return [truncateToWidth("[Image: local display is not connected]", width)];
        // Apply current public policy even to already-ready cached rows. There
        // are no subprocesses/decoders in this synchronous frame path.
        const rejected = checkDisplayPolicy(capabilityContext(liveContext));
        const reason = rejected?.message || capabilityFailure;
        if (reason) return [truncateToWidth(`[Image: ${sanitizeDisplayText(reason)}]`, width)];
        // Foreground/underline colors encode IDs. Do not restyle placeholder rows.
        const rows = image.render(width);
        if (rows.length && rows.every((row: string) => row.includes("\u{10eeee}"))) {
          hit = { columns: Math.min(width, Math.max(...rows.map(visibleWidth))), rows: rows.length };
        }
        const pageLabel = pdf ? ` — Page 1 of ${pdf.document.pageCount}` : "";
        const label = pageLabel ? truncateToWidth(details.label, Math.max(0, width - visibleWidth(pageLabel))) + pageLabel : details.label;
        return [truncateToWidth(theme.fg("muted", label), width), ...rows];
      },
      invalidate() { hit = undefined; },
    };
    return new MouseRegion(component, (event) => {
      if (event.type !== "click" || event.button !== "left" || !hit || event.x < 0 || event.x >= hit.columns ||
          event.y < 1 || event.y >= 1 + hit.rows) return;
      // Handle only host-arbitrated click, never press/drag/wheel or label/padding.
      void openViewer(details.occurrence).catch((error: unknown) => { if (liveContext) notifyFailure(liveContext, error); });
      return { handled: true, render: false };
    });
  });

  function inputPath(args: string, ctx: ExtensionContext) {
    if (!args.trim()) throw new Error("A file path is required");
    return resolve(ctx.cwd, args.trim());
  }

  async function acquireImage(path: string, ctx: ExtensionContext, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const imageResult = await createReadTool(ctx.cwd).execute("tmux-image", { path }, signal);
    const attachment = imageResult.content.find((block) => block.type === "image");
    if (!attachment) throw new Error("Pi could not read this file as an image attachment");
    return { content: imageResult.content, attachment };
  }

  async function describeImage(attachment: any, signal?: AbortSignal) {
    const dimensions = presentation.dimensions;
    const columns = Math.min(60, Math.max(1, (dimensions?.columns || 80) - 4));
    const rows = Math.min(24, Math.max(1, (dimensions?.rows || 40) - 8));
    return native.describe(attachment, { columns, rows }, getCellDimensions(), signal);
  }

  async function showImage(args: string, ctx: ExtensionContext, signal?: AbortSignal, label?: string) {
    await requireCapability(ctx, signal);
    signal?.throwIfAborted();
    const path = inputPath(args, ctx);
    const { content, attachment } = await acquireImage(path, ctx, signal);
    // Validate conversion before adding the viewer message: tool failures remain
    // failed results, never successful attachments with only a rendering error.
    const { geometry, pngBytes, uploadChunks } = await describeImage(attachment, signal);
    await requireCapability(ctx, signal);
    ctx.ui.notify(`Native PNG: ${(pngBytes / 1024).toFixed(1)} KiB, ${uploadChunks} upload chunk(s) when first resident`, "info");
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content,
      display: true,
      details: { schema: NATIVE_SCHEMA, occurrence: randomUUID(), geometry, label: sanitizeDisplayText(label || path) },
    }, { triggerTurn: false });
    return { pngBytes, uploadChunks, columns: geometry.columns, rows: geometry.rows };
  }

  function importAdmission(runtime: PdfRuntime, signal: AbortSignal) {
    signal.throwIfAborted();
    if (pdfRuntime !== runtime || runtime.closed) throw new Error("PDF session runtime was replaced");
    if (viewer.isOpen || presentation.connection?.tui.hasOverlay()) {
      throw new Error("Close the image viewer or current dialog/search before importing a PDF");
    }
  }

  async function openViewer(occurrence?: string) {
    if (pdfRuntime?.importing) throw new Error("A PDF import is in progress; finish or cancel it before opening the viewer");
    return viewer.open(occurrence);
  }

  async function showPdf(args: string, ctx: ExtensionContext, toolSignal?: AbortSignal) {
    const runtime = pdfRuntime;
    if (!runtime || runtime.closed) throw new Error("PDF session runtime is unavailable");
    if (runtime.importing) throw new Error("A PDF import is already in progress");
    const controller = new AbortController();
    const signal = toolSignal ? AbortSignal.any([controller.signal, toolSignal]) : controller.signal;
    let finish!: () => void;
    const reservation = { controller, done: new Promise<void>((resolve) => { finish = resolve; }) };
    runtime.importing = reservation; // Reserve before the first capability/source/UI await.
    let transaction: any;
    let staged = false;
    let occurrence: string | undefined;
    try {
      importAdmission(runtime, signal);
      await requireCapability(ctx, signal); // Reject before stat/open/read or Poppler.
      importAdmission(runtime, signal);
      const path = inputPath(args, ctx);
      occurrence = randomUUID();
      transaction = await runtime.service.prepareImport(path, { occurrence, label: sanitizeDisplayText(path), signal,
        chooseRetention: async ({ byteLength, base64Length }: { byteLength: number; base64Length: number }) => {
          importAdmission(runtime, signal);
          const choice = await ctx.ui.select(
            `PDF: ${(byteLength / 1048576).toFixed(2)} MiB; base64 about ${(base64Length / 1048576).toFixed(2)} MiB plus preview/metadata.\n` +
            "Keep embeds the full original in session copies/exports; synchronous save/load can be costly.\n" +
            "Temporary keeps only the preview in history; full browsing lasts this runtime. Cancel imports nothing.",
            ["Keep", "Temporary", "Cancel"], { signal });
          importAdmission(runtime, signal);
          if (choice === "Keep") return "keep";
          if (choice === "Temporary") return "temporary";
          return "cancel"; // Undefined, unavailable and invalid results NEVER imply Keep.
        },
      });
      const { geometry } = await describeImage(transaction.previewAttachment, signal);
      const details = transaction.details({ geometry });
      await requireCapability(ctx, signal);
      importAdmission(runtime, signal);
      const submission = { sha256: transaction.document.sha256, retention: transaction.document.retention };
      transaction.commit();
      staged = true;
      // Pi's void send is submission, not a display/disk ACK. During tools it
      // queues until after results; accepted sends cannot be retracted on abort.
      // No await between final guards, ownership staging, send and submission.
      try {
        pi.sendMessage({ customType: MESSAGE_TYPE, content: [
          { type: "text", text: `${details.label} — Page 1 of ${transaction.document.pageCount}` },
          transaction.previewAttachment,
        ], display: true, details }, { triggerTurn: false });
      } finally {
        // A synchronous throw can follow irreversible append/queue acceptance.
        runtime.submissions.set(occurrence, submission);
      }
      return { path, pageCount: transaction.document.pageCount, previewPage: 1,
        byteLength: transaction.document.byteLength, retention: transaction.document.retention, submitted: true };
    } finally {
      try {
        // Idle sends append synchronously even though their wrapper returns void.
        // A synchronous throw may follow an append or queue acceptance. Preserve
        // queued ownership until settlement; a tree occurrence proves ownership,
        // never durable storage. Generic rollback preserves committed Temporary.
        try { if (staged && ctx.isIdle()) await reconcileSubmissions(runtime); }
        finally { await transaction?.rollback(); }
      } finally {
        if (runtime.importing === reservation) runtime.importing = undefined;
        finish();
      }
    }
  }

  pi.registerCommand("tmux-image-stats", {
    description: "Show local graphics measurement only; no uploads, probing, messages or eviction",
    handler: async (_args, ctx) => {
      const stats = native.stats(presentation.epoch);
      if (stats.accounting.unavailable) {
        ctx.ui.notify(`Graphics accounting unavailable: ${stats.accounting.lastError || "unknown error"}; display is unaffected`, "warning");
        return;
      }
      ctx.ui.notify(
        "Graphics: this runtime only; eviction disabled; terminal ACK: no\n" +
        `Resident: ${stats.resident.imageIds} image IDs / ${stats.resident.payloads} payloads; PNG ${stats.resident.pngBytes} bytes; RGBA estimate ${stats.resident.estimatedRgbaBytes} bytes\n` +
        `Placements: ${stats.placements.occurrences} occurrences / ${stats.placements.geometryVersions} prototypes; normalized ${stats.normalization.payloads} payloads / ${stats.normalization.pngBytes} PNG bytes\n` +
        `Surfaces: ${stats.surfaces.inline} retained inline / ${stats.surfaces.viewer} tracked viewer (${stats.surfaces.liveViewer} live); viewer retirement pending: ${stats.viewer.retirementPending ? "yes" : "no"}\n` +
        `Viewer operations: epoch ${stats.surfaceTransfer.replacementCommands} replacements / ${stats.surfaceTransfer.retirementCommands} retirements; runtime ${stats.runtimeSurfaceTransfer.replacementCommands} replacements / ${stats.runtimeSurfaceTransfer.retirementCommands} retirements\n` +
        `Epoch transfer: ${stats.transfer.wireBytes} wire bytes / ${stats.transfer.uploadChunks} PNG chunks / ${stats.transfer.placementCommands} placement commands\n` +
        `Runtime transfer: ${stats.runtimeTransfer.wireBytes} wire bytes / ${stats.runtimeTransfer.uploadChunks} PNG chunks / ${stats.runtimeTransfer.placementCommands} placement commands\n` +
        `Uncounted: prior-runtime/external resources and terminal/GPU overhead; accounting errors: ${stats.accounting.errors}` +
        (stats.accounting.errors ? ` (incomplete; display unaffected; ${stats.accounting.lastError})` : ""),
        stats.accounting.errors ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("tmux-image-refresh", {
    description: "Re-upload stored image snapshots after terminal reconnect/reset without adding messages",
    handler: async (_args, ctx) => {
      try {
        requireInteractive(ctx);
        pdfRuntime?.importing?.controller.abort();
        await viewer.close("refresh");
        generation++;
        detector.invalidate();
        capabilityFailure = undefined;
        capabilityWarnings.clear();
        // Clear failed/ready records even if the fresh probe is still denied.
        // Every resulting replay prepare independently checks capability first.
        presentation.refresh();
        await requireCapability(ctx);
        await viewer.retryRetirement();
        ctx.ui.notify("Capabilities refreshed; image residency reset and stored snapshots will repaint without rereading files", "info");
      } catch (error) { notifyFailure(ctx, error); }
    },
  });

  pi.registerCommand("tmux-image-view", {
    description: "Open an existing stored image/PDF document; newest-first keyboard picker",
    handler: async (_args, ctx) => {
      try { requireInteractive(ctx); await openViewer(); }
      catch (error) { notifyFailure(ctx, error); }
    },
  });

  pi.registerCommand("tmux-image", {
    description: "Display an image through tmux; Pi's blockImages controls model access",
    handler: async (args, ctx) => {
      try { await showImage(args, ctx); }
      catch (error) { notifyFailure(ctx, error); }
    },
  });
  pi.registerCommand("tmux-pdf", {
    description: "Submit one page-one PDF preview; retain the original or choose Temporary for large files",
    handler: async (args, ctx) => {
      try {
        const result = await showPdf(args, ctx);
        ctx.ui.notify(`PDF preview submitted: Page 1 of ${result.pageCount}; ${result.retention}; ${result.byteLength} original bytes`, "info");
      } catch (error) { notifyFailure(ctx, error); }
    },
  });

  const parameters = Type.Object({ path: Type.String({ description: "File path, absolute or relative to the working directory" }) });
  pi.registerTool(defineTool({
    name: "tmux_show_image",
    label: "Display image",
    description: "Display an image to the user in Pi's tmux transcript using Unicode placeholders. Image attachments follow Pi's blockImages setting; local display does not require model vision. Requires interactive Pi inside tmux with passthrough and Unicode-placeholder support.",
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await showImage(params.path, ctx, signal);
      const path = inputPath(params.path, ctx);
      return { content: [{ type: "text", text: `Displayed image: ${path}` }], details: { path, ...result } };
    },
  }));
  pi.registerTool(defineTool({
    name: "tmux_show_pdf",
    label: "Display PDF",
    description: "Submit one page-one PDF preview for local viewing and later pagination. Original PDF bytes are stored only in session details for Keep; above 32 MiB the user chooses Keep, Temporary, or Cancel. Temporary browsing lasts this session runtime. Submission is not a display/disk acknowledgement; Pi owns persistence and deferred errors. Preview attachments follow Pi's blockImages setting. Requires interactive Pi inside tmux with passthrough/Unicode-placeholder support, pdfinfo and pdftoppm on PATH.",
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const details = await showPdf(params.path, ctx, signal);
      return {
        content: [{ type: "text", text: `Submitted PDF preview (Page 1 of ${details.pageCount}, ${details.retention}, ${details.byteLength} original bytes): ${sanitizeDisplayText(details.path)}` }],
        details,
      };
    },
  }));
}
