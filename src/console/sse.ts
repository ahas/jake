// A minimal Server-Sent Events reader for the console's streaming endpoints. The hub emits SSE for
// the exec stream and the traffic tail; this turns a Response body into parsed events and drops the
// keep-alive comments the hub sends to hold an idle connection open. It is the console's mirror of
// the same wire the hub's control server writes.

export interface SseEvent {
  event: string;
  data: unknown;
  id?: number;
}

/**
 * Parse one SSE block — the text between blank-line separators — into an event, or null for a
 * keep-alive comment or an empty block. A block is a run of `field: value` lines; the `data` fields
 * are concatenated and parsed as JSON, matching what the hub writes.
 */
export function parseSseBlock(block: string): SseEvent | null {
  if (block === "" || block.startsWith(":")) {
    return null; // an empty block or a `: ping` keep-alive comment
  }
  let event = "message";
  let data = "";
  let id: number | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
    else if (line.startsWith("id:")) {
      const parsed = Number.parseInt(line.slice(3).trim(), 10);
      if (!Number.isNaN(parsed)) id = parsed;
    }
  }
  return { event, data: data === "" ? undefined : JSON.parse(data), id };
}

/**
 * Read an SSE stream to its end, delivering each parsed event to `onEvent`. It buffers across reads
 * so a frame split over two chunks is still parsed once, and returns when the stream closes.
 */
export async function readSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseBlock(block);
        if (parsed !== null) onEvent(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
