/** Files the person attached to one panel request. Only these can reach a page's file input, and only
 * while that request runs: the model never names a local path. Kept in memory, never in storage. */
export type Attachment = { name: string; mime: string; dataUrl: string };

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
// chrome.runtime messages carry the data URLs; keep a request well under the 64 MiB message limit.
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const plainName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= 200 && !/[\\/\u0000-\u001f]/.test(name) && name !== "." && name !== "..";
function decodedBytes(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma), body = dataUrl.slice(comma + 1);
  if (!head.endsWith(";base64")) return body.length;
  return Math.floor(body.length * 3 / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
}

export function attachmentRegistry() {
  const byRequest = new Map<string, Attachment[]>();
  return {
    register(requestId: string, files: unknown): { accepted: string[]; skipped: string[] } {
      const accepted: Attachment[] = [], skipped: string[] = [];
      let total = 0;
      for (const file of Array.isArray(files) ? files : []) {
        const name = plainName(file?.name) ? file.name : undefined;
        const ok = name !== undefined && typeof file.dataUrl === "string" && file.dataUrl.startsWith("data:") && file.dataUrl.includes(",");
        const bytes = ok ? decodedBytes(file.dataUrl) : 0;
        if (!ok) { if (name) skipped.push(name); continue; }
        if (bytes > MAX_ATTACHMENT_BYTES || accepted.length >= MAX_FILES || total + bytes > MAX_TOTAL_BYTES) { skipped.push(name); continue; }
        total += bytes;
        accepted.push({ name, mime: typeof file.mime === "string" && file.mime ? file.mime : "application/octet-stream", dataUrl: file.dataUrl });
      }
      if (accepted.length) byRequest.set(requestId, accepted); else byRequest.delete(requestId);
      return { accepted: accepted.map(f => f.name), skipped };
    },
    take(requestId: string, name: string): Attachment | undefined {
      const file = byRequest.get(requestId)?.find(f => f.name === name);
      return file && { ...file };
    },
    forget(requestId: string) { byRequest.delete(requestId); },
  };
}
export const uploads = attachmentRegistry();
