/**
 * Wraps a handler result as an MCP tool response with consistent error shaping.
 */

export async function toMcpResponse<T>(
  handler: () => Promise<T>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const result = await handler();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
