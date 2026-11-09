import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WpApiError } from '../wp/client.js';

/** Wraps data as a JSON text result, the shape every tool returns. */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Turns an exception into an MCP tool error result, so the model
 * sees what went wrong instead of the call failing at protocol level.
 */
export function toolError(error: unknown): CallToolResult {
  let message: string;
  if (error instanceof WpApiError) {
    message = `WordPress API error (${error.status}${error.code ? `, ${error.code}` : ''}): ${error.message}`;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }

  return { isError: true, content: [{ type: 'text', text: message }] };
}
