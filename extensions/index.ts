import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { getCapabilities, getCellDimensions, truncateToWidth } from "@earendil-works/pi-tui";
import { convertToPng, createReadTool, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNativeRenderer, NATIVE_SCHEMA, readNativeDetails, sanitizeDisplayText } from "../src/native.mjs";
import { withPdfPages } from "../src/pdf.mjs";
import { createPresentation } from "../src/presentation.mjs";

const MESSAGE_TYPE = "pi-tmux-image";

export default function (pi: ExtensionAPI) {
  const presentation = createPresentation();
  const native = createNativeRenderer({ convertToPng });
  pi.on("session_start", (_event, ctx) => {
    presentation.attach(ctx, Boolean(process.env.TMUX));
  });
  pi.on("session_shutdown", () => presentation.disconnect());

  // Normal Pi image content, with no context filter. Pi's images.blockImages
  // controls model access independently of this local terminal renderer.
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const details = readNativeDetails(message.details);
    const attachment = Array.isArray(message.content) ? message.content.find((block) => block.type === "image") : undefined;
    if (!details || !attachment) {
      const reason = message.details && typeof message.details === "object" && "schema" in message.details &&
        message.details.schema !== NATIVE_SCHEMA ? "unsupported display schema" : "legacy or invalid display; redisplay to regenerate";
      return { render: (width: number) => [truncateToWidth(`[Image: ${reason}]`, width)], invalidate() {} };
    }
    const image = presentation.component({
      key: details.occurrence,
      prepare: (_width: number, context: { epoch: symbol; signal: AbortSignal }) =>
        native.prepare({ attachment, occurrence: details.occurrence, geometry: details.geometry }, context),
      fallback: (width: number, error?: Error) => [truncateToWidth(error ? `[Image: ${sanitizeDisplayText(error.message || error)}]` : "[Image: preparing native PNG]", width)],
    });
    return {
      render(width: number) {
        if (getCapabilities().images === "kitty") return [truncateToWidth("[Image: forced Pi Kitty graphics unsupported; use auto detection in tmux]", width)];
        if (width < details.geometry.columns) return [truncateToWidth("[Image: pane too narrow]", width)];
        // Foreground/underline colors encode IDs. Do not restyle placeholder rows.
        return [truncateToWidth(theme.fg("muted", details.label), width), ...image.render(width)];
      },
      invalidate() {},
    };
  });

  function requireTerminal(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !process.env.TMUX) {
      throw new Error("pi-tmux-image requires interactive Pi inside tmux");
    }
    if (getCapabilities().images === "kitty") {
      throw new Error("pi-tmux-image does not support forced Pi Kitty graphics: host redraws may delete extension uploads; use Pi's automatic tmux detection");
    }
  }

  function inputPath(args: string, ctx: ExtensionContext) {
    if (!args.trim()) throw new Error("A file path is required");
    return resolve(ctx.cwd, args.trim());
  }

  async function showImage(args: string, ctx: ExtensionContext, signal?: AbortSignal, label?: string) {
    requireTerminal(ctx);
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
    signal?.throwIfAborted();
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
    requireTerminal(ctx);
    const path = inputPath(args, ctx);
    const pages = await withPdfPages(path, async (imagePath, page) => ({
      page,
      ...await showImage(imagePath, ctx, signal, `${path} — page ${page}`),
    }), { signal });
    return { path, pages };
  }

  pi.registerCommand("tmux-image", {
    description: "Display an image through tmux; Pi's blockImages controls model access",
    handler: async (args, ctx) => {
      try { await showImage(args, ctx); }
      catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
  pi.registerCommand("tmux-pdf", {
    description: "Display the first two PDF pages through tmux",
    handler: async (args, ctx) => {
      try { await showPdf(args, ctx); }
      catch (error) { ctx.ui.notify(String(error), "error"); }
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
