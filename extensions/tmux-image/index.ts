import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { getCapabilities, getCellDimensions, MouseRegion, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { convertToPng, createReadTool, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureLayout, createNativeRenderer, NATIVE_SCHEMA, readLegacyDetails, readNativeDetails, sanitizeDisplayText } from "../../src/native.mjs";
import { withPdfPages } from "../../src/pdf.mjs";
import { createPresentation } from "../../src/presentation.mjs";
import { createViewerController, indexSnapshots } from "../../src/viewer.mjs";
import { checkDisplayPolicy, resolvePiDisplayPolicy, TmuxCapabilityDetector } from "../../src/capabilities.mjs";

const MESSAGE_TYPE = "pi-tmux-image";

export default function (pi: ExtensionAPI) {
  const presentation = createPresentation();
  const native = createNativeRenderer({ convertToPng });
  const legacyOccurrences = new WeakMap<object, string>();
  const legacyEntryOccurrences = new Map<string, string>();
  const detector = new TmuxCapabilityDetector();
  let liveContext: ExtensionContext | undefined;
  let generation = 0;
  let capabilityFailure: string | undefined;
  const capabilityWarnings = new Set<string>();
  const viewer = createViewerController({ native, presentation,
    getContext: () => liveContext, getSnapshots: storedSnapshots, requireCapability,
    readyPolicy: (ctx: ExtensionContext) => checkDisplayPolicy(capabilityContext(ctx))?.message || capabilityFailure,
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
      const details = readNativeDetails(entry.details) || readLegacyDetails(entry.details, legacyEntryOccurrence(entry.id));
      if (!details) return;
      return { occurrence: details.occurrence, label: details.label, attachment };
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
    presentation.attach(ctx, Boolean(process.env.TMUX));
  });
  pi.on("session_shutdown", async () => {
    // Revoke/hide/retire the private viewer while its captured TUI and policy
    // context still exist; inline scrollback resources remain retained.
    await viewer.close("session-shutdown");
    generation++;
    detector.invalidate();
    capabilityFailure = undefined;
    capabilityWarnings.clear();
    liveContext = undefined;
    presentation.disconnect();
  });
  pi.on("session_tree", async () => { await viewer.close("branch-change"); });

  // Normal Pi image content, with no context filter. Pi's images.blockImages
  // controls model access independently of this local terminal renderer.
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    let details = readNativeDetails(message.details);
    const attachment = Array.isArray(message.content) ? message.content.find((block) => block.type === "image") : undefined;
    if (!details && message.details && typeof message.details === "object" && !("schema" in message.details)) {
      details = readLegacyDetails(message.details, legacyMessageOccurrence(message));
    }
    if (!details || !attachment) {
      const reason = message.details && typeof message.details === "object" && "schema" in message.details &&
        message.details.schema !== NATIVE_SCHEMA ? "unsupported display schema" : "missing or invalid image snapshot/display";
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
        return [truncateToWidth(theme.fg("muted", details.label), width), ...rows];
      },
      invalidate() { hit = undefined; },
    };
    return new MouseRegion(component, (event) => {
      if (event.type !== "click" || event.button !== "left" || !hit || event.x < 0 || event.x >= hit.columns ||
          event.y < 1 || event.y >= 1 + hit.rows) return;
      // Handle only host-arbitrated click, never press/drag/wheel or label/padding.
      void viewer.open(details.occurrence).catch((error: unknown) => { if (liveContext) notifyFailure(liveContext, error); });
      return { handled: true, render: false };
    });
  });

  function inputPath(args: string, ctx: ExtensionContext) {
    if (!args.trim()) throw new Error("A file path is required");
    return resolve(ctx.cwd, args.trim());
  }

  async function showImage(args: string, ctx: ExtensionContext, signal?: AbortSignal, label?: string) {
    await requireCapability(ctx, signal);
    signal?.throwIfAborted();
    const path = inputPath(args, ctx);
    const dimensions = presentation.dimensions;
    const columns = Math.min(60, Math.max(1, (dimensions?.columns || 80) - 4));
    const rows = Math.min(24, Math.max(1, (dimensions?.rows || 40) - 8));
    const imageResult = await createReadTool(ctx.cwd).execute("tmux-image", { path }, signal);
    const attachment = imageResult.content.find((block) => block.type === "image");
    if (!attachment) {
      throw new Error("Pi could not read this file as an image attachment");
    }
    // Validate conversion before adding the viewer message: tool failures remain
    // failed results, never successful attachments with only a rendering error.
    const { geometry, pngBytes, uploadChunks } = await native.describe(attachment, { columns, rows }, getCellDimensions(), signal);
    await requireCapability(ctx, signal);
    ctx.ui.notify(`Native PNG: ${(pngBytes / 1024).toFixed(1)} KiB, ${uploadChunks} upload chunk(s) when first resident`, "info");
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: imageResult.content,
      display: true,
      details: { schema: NATIVE_SCHEMA, occurrence: randomUUID(), geometry, label: sanitizeDisplayText(label || path) },
    }, {
      // Preserve provider tool-call/result ordering. During an agent turn Pi
      // appends these attachments after the tool results without steering.
      triggerTurn: false,
    });
    return { pngBytes, uploadChunks, columns: geometry.columns, rows: geometry.rows };
  }

  async function showPdf(args: string, ctx: ExtensionContext, signal?: AbortSignal) {
    await requireCapability(ctx, signal);
    const path = inputPath(args, ctx);
    const pages = await withPdfPages(path, async (imagePath, page) => ({
      page,
      ...await showImage(imagePath, ctx, signal, `${path} — page ${page}`),
    }), { signal });
    return { path, pages };
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
    description: "Open an existing stored image/PDF-page snapshot; newest-first keyboard picker",
    handler: async (_args, ctx) => {
      try { requireInteractive(ctx); await viewer.open(); }
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
    description: "Display the first two PDF pages through tmux",
    handler: async (args, ctx) => {
      try { await showPdf(args, ctx); }
      catch (error) { notifyFailure(ctx, error); }
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
    description: "Render and display the first two pages of a PDF in Pi's tmux transcript using Unicode placeholders. Page-image attachments follow Pi's blockImages setting; local display does not require model vision. Requires interactive Pi inside tmux with passthrough and Unicode-placeholder support, and pdftoppm on PATH.",
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const details = await showPdf(params.path, ctx, signal);
      return {
        content: [{ type: "text", text: `Displayed ${details.pages.length} page(s) of PDF: ${details.path}` }],
        details,
      };
    },
  }));
}
