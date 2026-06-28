import Anthropic from "@anthropic-ai/sdk";
import { getConfig, SYSTEM_PROMPT } from "@/lib/config";

// Run on the Node.js runtime (the Anthropic SDK + streaming need it; Edge won't do).
export const runtime = "nodejs";
// Never cache — every chat turn is dynamic.
export const dynamic = "force-dynamic";

const MCP_BETA = "mcp-client-2025-11-20";
const MAX_TOKENS = 8192;
// Safety cap on pause_turn continuations so a runaway server-tool loop can't spin forever.
const MAX_CONTINUATIONS = 8;

type ClientMessage = {
  role: "user" | "assistant";
  // Either a plain string (typical user turn) or structured content blocks
  // (assistant turns we sent back previously, which may include MCP tool blocks).
  content: string | Anthropic.Beta.BetaContentBlockParam[];
};

/** Encode an object as one SSE event. */
function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function POST(req: Request) {
  let body: { messages?: ClientMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const incoming = body.messages;
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return new Response(JSON.stringify({ error: "`messages` must be a non-empty array" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let config;
  try {
    config = getConfig();
  } catch (err) {
    // Serve a simulated stream so the UI can be exercised with zero setup.
    // Enabled in dev automatically, or via MOCK_CHAT=1 (needed when running the
    // production build, e.g. inside a OneDrive folder where `next dev` won't start).
    // In a real production deploy without MOCK_CHAT, this stays off so fake numbers
    // can never silently appear — you get the clear config error instead.
    if (process.env.MOCK_CHAT === "1" || process.env.NODE_ENV !== "production") {
      return mockStreamResponse(incoming);
    }
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Server misconfigured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const client = new Anthropic({ apiKey: config.apiKey });

  // The MCP connector: Claude connects to the Tableau MCP server itself, server-side.
  const mcpServer: Anthropic.Beta.BetaRequestMCPServerURLDefinition = {
    type: "url",
    url: config.mcpUrl,
    name: config.mcpName,
    ...(config.mcpToken ? { authorization_token: config.mcpToken } : {}),
  };

  // Build the working message list. We mutate this across pause_turn continuations.
  const messages: Anthropic.Beta.BetaMessageParam[] = incoming.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(sse(obj));

      try {
        for (let i = 0; i < MAX_CONTINUATIONS; i++) {
          const turn = client.beta.messages.stream({
            model: config.model,
            max_tokens: MAX_TOKENS,
            betas: [MCP_BETA],
            system: SYSTEM_PROMPT,
            mcp_servers: [mcpServer],
            tools: [{ type: "mcp_toolset", mcp_server_name: config.mcpName }],
            messages,
          });

          for await (const event of turn) {
            if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block.type === "mcp_tool_use") {
                send({ type: "tool_use", name: block.name, server: block.server_name });
              }
            } else if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (delta.type === "text_delta") {
                send({ type: "text", text: delta.text });
              }
            }
          }

          const finalMessage = await turn.finalMessage();

          // Surface any MCP tool errors as status (the result blocks live in finalMessage.content).
          for (const block of finalMessage.content) {
            if (block.type === "mcp_tool_result" && block.is_error) {
              send({ type: "tool_error", name: undefined });
            }
          }

          // Append this assistant turn to history so the next request carries tool context.
          messages.push({ role: "assistant", content: finalMessage.content });

          if (finalMessage.stop_reason === "pause_turn") {
            // Server-tool loop hit its per-turn iteration cap; re-send to continue.
            continue;
          }

          // Done (end_turn / max_tokens / refusal / etc). Hand the full assistant
          // content blocks back so the client can store them for the next turn.
          if (finalMessage.stop_reason === "refusal") {
            send({
              type: "text",
              text: "\n\n_(The model declined to answer this request.)_",
            });
          }
          send({ type: "done", content: finalMessage.content });
          controller.close();
          return;
        }

        // Exhausted continuations.
        send({
          type: "error",
          message: `Stopped after ${MAX_CONTINUATIONS} continuation rounds.`,
        });
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected server error";
        send({ type: "error", message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * DEV-ONLY simulated chat stream. Produces realistic-looking events (text deltas,
 * a Tableau tool chip, and a Markdown table) so the UI can be tested before any
 * credentials or MCP server are configured. Never used in production.
 */
function mockStreamResponse(incoming: ClientMessage[]): Response {
  const last = incoming[incoming.length - 1];
  const userText =
    typeof last?.content === "string" ? last.content : "your question";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(sse(obj));

      const intro =
        `**Mock mode** — no \`ANTHROPIC_API_KEY\`/\`TABLEAU_MCP_URL\` set, so this is a ` +
        `simulated answer to _"${userText}"_. Add a \`.env.local\` (see the README) for real data.\n\n`;
      for (const word of intro.split(/(\s+)/)) {
        send({ type: "text", text: word });
        await sleep(12);
      }

      await sleep(300);
      send({ type: "tool_use", name: "list-datasources", server: "tableau" });
      await sleep(600);

      const body =
        `Here's a sample result rendered as a table:\n\n` +
        `| Region | Revenue (Q) | YoY |\n` +
        `| --- | ---: | ---: |\n` +
        `| West | $1,284,500 | +12% |\n` +
        `| East | $1,003,200 | +7% |\n` +
        `| Central | $842,700 | +4% |\n` +
        `| South | $611,900 | -2% |\n\n` +
        `Once connected, these numbers come straight from your Tableau data sources.`;
      for (const word of body.split(/(\s+)/)) {
        send({ type: "text", text: word });
        await sleep(10);
      }

      send({ type: "done", content: [{ type: "text", text: intro + body }] });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
