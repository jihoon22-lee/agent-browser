import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES, parseEnvelope, ProtocolError, makeReq } from "../src/protocol/envelope";

const root = join(__dirname, "..", "..", "protocol");

describe("protocol contract", () => {
  it("parses every valid fixture without changing it", () => {
    for (const name of readdirSync(join(root, "fixtures"))) {
      if (!name.endsWith(".json") || name === "tools-list.json" || name.startsWith("res-unknown-version")) continue;
      const text = readFileSync(join(root, "fixtures", name), "utf8");
      expect(JSON.parse(JSON.stringify(parseEnvelope(text))), name).toEqual(JSON.parse(text));
    }
  });

  it("rejects unknown protocol versions with a specific code", () => {
    const text = readFileSync(join(root, "fixtures", "res-unknown-version.json"), "utf8");
    try {
      parseEnvelope(text);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      expect((e as ProtocolError).code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
    }
  });

  it("error code list matches the ledger", () => {
    const ledger = JSON.parse(readFileSync(join(root, "schema", "error-codes.json"), "utf8"));
    expect([...ERROR_CODES]).toEqual(ledger);
  });

  it("makeReq creates unique ids", () => {
    expect(makeReq("x", {}).id).not.toBe(makeReq("x", {}).id);
  });
});
