/**
 * Connectivity test for the Tableau MCP endpoint via Claude's MCP connector.
 *
 * Run:  npm run test:mcp
 *
 * This sends one request to the Claude API, tells it to connect to your Tableau
 * MCP server and list/exercise the tools, then prints exactly what happened so
 * you can confirm:
 *   - the endpoint URL is reachable from Anthropic's servers
 *   - whether it needs an auth token (you'll see auth errors if so)
 *   - which Tableau tools are exposed
 */
import Anthropic from "@anthropic-ai/sdk";

// Load .env.local (Node 20.12+ / 26 has process.loadEnvFile).
try {
  process.loadEnvFile(".env.local");
} catch {
  console.warn("Could not load .env.local — relying on existing environment variables.\n");
}

const MCP_BETA = "mcp-client-2025-11-20";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Set it in .env.local (see .env.local.example).`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const mcpUrl = requireEnv("TABLEAU_MCP_URL");
  const mcpName = process.env.TABLEAU_MCP_NAME || "tableau";
  const mcpToken = process.env.TABLEAU_MCP_TOKEN || undefined;
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

  console.log("Testing Tableau MCP connection");
  console.log("  URL  :", mcpUrl);
  console.log("  name :", mcpName);
  console.log("  auth :", mcpToken ? "bearer token set" : "(none)");
  console.log("  model:", model);
  console.log("");

  const client = new Anthropic({ apiKey });

  const mcpServer: Anthropic.Beta.BetaRequestMCPServerURLDefinition = {
    type: "url",
    url: mcpUrl,
    name: mcpName,
    ...(mcpToken ? { authorization_token: mcpToken } : {}),
  };

  try {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 2000,
      betas: [MCP_BETA],
      mcp_servers: [mcpServer],
      tools: [{ type: "mcp_toolset", mcp_server_name: mcpName }],
      messages: [
        {
          role: "user",
          content:
            "List the names of all Tableau tools available to you through the MCP server. " +
            "Then call one read-only tool (for example one that lists data sources or workbooks) " +
            "to confirm the connection works, and report the result briefly.",
        },
      ],
    });

    let toolCalls = 0;
    let toolErrors = 0;
    const textParts: string[] = [];

    for (const block of res.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "mcp_tool_use") {
        toolCalls++;
        console.log(`→ tool call: ${block.name} (server: ${block.server_name})`);
      } else if (block.type === "mcp_tool_result") {
        if (block.is_error) {
          toolErrors++;
          console.log("  ✗ tool returned an error:");
          console.log("   ", JSON.stringify(block.content).slice(0, 500));
        } else {
          console.log("  ✓ tool result received");
        }
      }
    }

    console.log("");
    console.log("stop_reason:", res.stop_reason);
    console.log(`tool calls: ${toolCalls}, tool errors: ${toolErrors}`);
    console.log("\n--- Claude's summary ---\n");
    console.log(textParts.join("\n").trim() || "(no text returned)");
    console.log("");

    if (toolCalls === 0) {
      console.log(
        "⚠ No tools were called. The MCP server may have exposed no tools, or Claude " +
          "chose not to call one. Check the URL/path and that the server is running.",
      );
    } else if (toolErrors > 0) {
      console.log(
        "⚠ A tool errored. If it's an auth error, set TABLEAU_MCP_TOKEN in .env.local. " +
          "Otherwise check the MCP server logs.",
      );
    } else {
      console.log("✅ Connection looks good — the web app should work with these settings.");
    }
  } catch (err) {
    console.error("\n✗ Request failed:");
    if (err instanceof Anthropic.APIError) {
      console.error(`  status: ${err.status}`);
      console.error(`  message: ${err.message}`);
    } else {
      console.error(err);
    }
    console.error(
      "\nCommon causes: bad ANTHROPIC_API_KEY, MCP URL not reachable from the public internet, " +
        "or the endpoint isn't a valid MCP streamable-HTTP/SSE endpoint.",
    );
    process.exit(1);
  }
}

main();
