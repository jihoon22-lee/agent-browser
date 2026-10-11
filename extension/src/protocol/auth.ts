import { ProtocolError } from "./errors";

export const AUTH_VERSION = 1;
export type AuthHello = {
  authVersion: number;
  role: "extension";
  clientId: string;
  clientNonce: string;
  clientVersion: string;
  repair: boolean;
};

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const isHex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export function authHello(clientId: string, repair: boolean): AuthHello {
  return { authVersion: AUTH_VERSION, role: "extension", clientId, clientNonce: hex(crypto.getRandomValues(new Uint8Array(32))), clientVersion: "0.1.0", repair };
}

export function authTranscript(side: "server" | "client", hello: AuthHello, serverNonce: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["agent-browser-auth-v1", side, hello.role, hello.clientId, hello.clientNonce, serverNonce, hello.repair]));
}

/** The caller must check its socket lifecycle again after this asynchronous proof. */
export async function answerChallenge(token: string, hello: AuthHello, result: unknown): Promise<string> {
  const challenge = result as Record<string, unknown> | undefined;
  if (!challenge || challenge.authVersion !== AUTH_VERSION || !isHex(challenge.serverNonce) || !isHex(challenge.serverProof)) {
    throw new ProtocolError("AUTH_FAILED", "Bridge mutual authentication v1 is required. Update both components and reconnect.");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const proofBytes = Uint8Array.from(challenge.serverProof.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  const verified = await crypto.subtle.verify("HMAC", key, proofBytes, authTranscript("server", hello, challenge.serverNonce));
  if (!verified) throw new ProtocolError("AUTH_FAILED", "Bridge server proof is invalid. Check the Bridge and pairing credentials.");
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, authTranscript("client", hello, challenge.serverNonce))));
}
