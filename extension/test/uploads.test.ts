import { attachmentRegistry, MAX_ATTACHMENT_BYTES } from "../src/background/uploads";

const file = (name: string, bytes = 3, mime = "image/png") => ({ name, mime, dataUrl: `data:${mime};base64,` + "A".repeat(Math.ceil(bytes / 3) * 4) });

it("keeps a request's attachments to that request until it is forgotten", () => {
  const r = attachmentRegistry();
  expect(r.register("A", [file("a.png")])).toEqual({ accepted: ["a.png"], skipped: [] });
  expect(r.take("B", "a.png")).toBeUndefined();
  expect(r.take("A", "a.png")).toMatchObject({ name: "a.png", mime: "image/png" });
  r.forget("A");
  expect(r.take("A", "a.png")).toBeUndefined();
});
it("skips files over the size limit and beyond five per request", () => {
  const r = attachmentRegistry();
  const big = file("big.bin", MAX_ATTACHMENT_BYTES + 3, "application/octet-stream");
  const result = r.register("A", [big, ...["1", "2", "3", "4", "5", "6"].map(n => file(`${n}.png`))]);
  expect(result).toEqual({ accepted: ["1.png", "2.png", "3.png", "4.png", "5.png"], skipped: ["big.bin", "6.png"] });
  expect(r.take("A", "big.bin")).toBeUndefined();
  expect(r.take("A", "6.png")).toBeUndefined();
});
it("accepts only data URLs with a plain file name", () => {
  const r = attachmentRegistry();
  expect(r.register("A", [{ name: "x.png", mime: "image/png", dataUrl: "https://example.test/x.png" }, { name: "", mime: "image/png", dataUrl: "data:image/png;base64,AAAA" }, { name: "../x.png", mime: "image/png", dataUrl: "data:image/png;base64,AAAA" }]).accepted).toEqual([]);
});
