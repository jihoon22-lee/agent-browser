import { webcrypto } from "node:crypto";
import vectors from "../../protocol/auth-vectors.json";
import { answerChallenge, type AuthHello } from "../src/protocol/auth";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

it("matches independent cross-language HMAC vectors including repair and JSON escaping", async () => {
  for (const vector of vectors) {
    const hello: AuthHello = { authVersion: 1, role: "extension", clientId: vector.clientId, clientNonce: vector.clientNonce, clientVersion: "test", repair: vector.repair };
    const challenge = { authVersion: 1, serverNonce: vector.serverNonce, serverProof: vector.serverProof };
    await expect(answerChallenge(vector.token, hello, challenge)).resolves.toBe(vector.clientProof);
    await expect(answerChallenge("wrong-token", hello, challenge)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(answerChallenge(vector.token, { ...hello, clientNonce: "33".repeat(32) }, challenge)).rejects.toMatchObject({ code: "AUTH_FAILED" });
  }
});
