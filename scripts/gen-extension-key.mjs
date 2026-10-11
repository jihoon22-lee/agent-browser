import { generateKeyPairSync, createHash } from "node:crypto";
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
console.log(JSON.stringify({ key: der.toString("base64"), id }, null, 2));
