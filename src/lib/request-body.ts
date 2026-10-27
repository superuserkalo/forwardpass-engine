/** Bound untrusted bodies while reading, rather than after allocating the entire body. */
export async function boundedText(request: Request, maximum: number): Promise<string> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Body too large"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
