import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createReadTool, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_CHAFA_BYTES, renderPlaceholders } from "../src/graphics.mjs";
import { withPdfPages } from "../src/pdf.mjs";
import { createPresentation } from "../src/presentation.mjs";

const MESSAGE_TYPE = "pi-tmux-image";

export default function (pi: ExtensionAPI) {
  const presentation = createPresentation();
  pi.on("session_start", (_event, ctx) => {
    presentation.attach(ctx, Boolean(process.env.TMUX));
  });
  pi.on("session_shutdown", () => presentation.disconnect());

  // Normal Pi image content, with no context filter. Pi's images.blockImages
  // controls model access independently of this local terminal renderer.
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as { lines: string[]; columns: number; label: string };
    return {
      render(width: number) {
        if (width < details.columns) return [truncateToWidth("[Image: pane too narrow]", width)];
        // Foreground colors encode image IDs. Do not restyle placeholder rows.
        return [truncateToWidth(theme.fg("muted", details.label), width), ...details.lines];
      },
      invalidate() {},
    };
  });

  function requireTerminal(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !process.env.TMUX) {
      throw new Error("pi-tmux-image requires interactive Pi inside tmux");
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
    const columns = Math.min(60, Math.max(1, (process.stdout.columns || 80) - 4));
    const rows = Math.min(24, Math.max(1, (process.stdout.rows || 40) - 8));
    const imageResult = await createReadTool(ctx.cwd).execute("tmux-image", { path }, signal);
    if (!imageResult.content.some((block) => block.type === "image")) {
      throw new Error("Pi could not read this file as an image attachment");
    }
    signal?.throwIfAborted();
    const { uploads, lines, outputBytes } = renderPlaceholders(path, columns, rows);
    signal?.throwIfAborted();
    ctx.ui.notify(
      `Chafa: ${(outputBytes / 1024 / 1024).toFixed(2)} MiB / 64 MiB ` +
      `(${(100 * outputBytes / MAX_CHAFA_BYTES).toFixed(1)}% of capture limit)`,
      "info",
    );
    // Virtual placement (U=1) does not depend on the outer terminal's cursor.
    presentation.write(uploads);
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: imageResult.content,
      display: true,
      details: { lines, columns, outputBytes, label: label || path },
    }, {
      // Preserve provider tool-call/result ordering. During an agent turn Pi
      // appends these attachments after the tool results without steering.
      triggerTurn: false,
    });
    return { outputBytes };
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
    description: "Display an image to the user in Pi's tmux transcript using Unicode placeholders. Image attachments follow Pi's blockImages setting; local display does not require model vision. Requires interactive Pi inside tmux and chafa on PATH.",
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
    description: "Render and display the first two pages of a PDF in Pi's tmux transcript using Unicode placeholders. Page-image attachments follow Pi's blockImages setting; local display does not require model vision. Requires interactive Pi inside tmux, chafa and pdftoppm on PATH.",
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
