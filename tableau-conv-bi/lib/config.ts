// Server-only configuration, read from environment variables.
// Never import this from a client component — it would leak secrets into the bundle.

export interface AppConfig {
  apiKey: string;
  model: string;
  mcpUrl: string;
  mcpName: string;
  mcpToken: string | undefined;
}

/** Read and validate required environment variables. Throws if something essential is missing. */
export function getConfig(): AppConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mcpUrl = process.env.TABLEAU_MCP_URL;

  const missing: string[] = [];
  if (!apiKey) missing.push("ANTHROPIC_API_KEY");
  if (!mcpUrl) missing.push("TABLEAU_MCP_URL");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Copy .env.local.example to .env.local and fill them in.`,
    );
  }

  return {
    apiKey: apiKey!,
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
    mcpUrl: mcpUrl!,
    mcpName: process.env.TABLEAU_MCP_NAME || "tableau",
    mcpToken: process.env.TABLEAU_MCP_TOKEN || undefined,
  };
}

export const SYSTEM_PROMPT = `You are a conversational business-intelligence assistant connected to a Tableau instance through an MCP server.

You can use the Tableau tools to: list and search workbooks, data sources, and views; read metadata; and query published data sources (e.g. via VizQL/headless BI) to answer questions with real numbers.

Guidance:
- When the user asks a data question, use the Tableau tools to fetch real data rather than guessing. Cite the workbook, view, or data source you used.
- If a request is ambiguous (which data source, which time range, which measure), ask a brief clarifying question before running a large query.
- Present results clearly: lead with the answer, then show supporting figures. Use compact markdown tables for tabular results.
- If a tool call fails, explain what went wrong in plain language and suggest a next step.
- Do not invent field names, data sources, or numbers. If something isn't available through the tools, say so.`;
