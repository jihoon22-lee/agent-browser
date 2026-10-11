import type { AssistantMessage, MessageRecord, Model, ProviderCatalog, StepFinishPart } from "./types";

export type TokenUsage = { input: number; output: number; reasoning: number; cache: { read: number; write: number }; total: number };
type Call = { tokens: TokenUsage; cost: number | null; message: AssistantMessage };
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function usage(tokens: AssistantMessage["tokens"] | undefined): TokenUsage | null {
  if (!tokens || ![tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write].every(finite)) return null;
  // v1.18.29 Session.getUsage subtracts cache from input and reasoning from output.
  // They are disjoint categories, not details that should be counted twice.
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
  return { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: { ...tokens.cache }, total };
}
function sum(calls: Call[]): TokenUsage | null {
  if (!calls.length) return null;
  return calls.reduce<TokenUsage>((a, { tokens: b }) => ({ input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write }, total: a.total + b.total }), { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 });
}
function cost(calls: Call[]): number | null {
  return calls.length && calls.every(call => call.cost !== null) ? calls.reduce((total, call) => total + call.cost!, 0) : null;
}

/** Counts loaded messages of one session. Step records take precedence over their message mirror. */
export function computeUsage(records: MessageRecord[], model?: Model, sessionID = records[0]?.info.sessionID) {
  const messages = [...new Map(records.filter(record => record.info.sessionID === sessionID).map(record => [record.info.id, record])).values()]
    .sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id));
  const calls: Call[] = [];
  for (const record of messages) {
    if (record.info.role !== "assistant") continue;
    const message = record.info;
    const steps = [...new Map(record.parts.filter((part): part is StepFinishPart => part.type === "step-finish" && part.messageID === message.id && part.sessionID === sessionID).map(part => [part.id, part])).values()];
    if (steps.length) {
      for (const step of steps) { const tokens = usage(step.tokens); if (tokens) calls.push({ tokens, cost: finite(step.cost) ? step.cost : null, message }); }
    } else {
      const tokens = usage(message.tokens);
      if (tokens) calls.push({ tokens, cost: finite(message.cost) ? message.cost : null, message });
    }
  }
  const lastUser = messages.filter(record => record.info.role === "user" && !record.parts.some(part => part.type === "compaction")).at(-1);
  const requestCalls = calls.filter(call => call.message.parentID === lastUser?.info.id);
  const latest = calls.at(-1);
  const compact = messages.filter(record => record.parts.some(part => part.type === "compaction")).at(-1);
  const compacted = compact && messages.some(record => record.info.role === "assistant" && record.info.summary && record.info.parentID === compact.info.id && record.info.time.completed !== undefined);
  const compaction: "none" | "pending" | "completed" = compact ? compacted ? "completed" : "pending" : "none";
  const lastContextCall = calls.filter(call => !call.message.summary).at(-1);
  const currentContext = lastContextCall && (!compact || lastContextCall.message.time.created > compact.info.time.created) ? lastContextCall : undefined;
  return {
    latest: latest?.tokens ?? null, request: sum(requestCalls), session: sum(calls),
    latestCost: latest?.cost ?? null, requestCost: cost(requestCalls), sessionCost: cost(calls),
    context: {
      tokens: currentContext?.tokens.total ?? null,
      limit: finite(model?.limit.context) && model!.limit.context > 0 ? model!.limit.context : null,
      estimated: true as const,
      modelChanged: !!currentContext && !!model && (currentContext.message.providerID !== model.providerID || currentContext.message.modelID !== model.id),
    },
    compaction,
  };
}

/** The configured server is authoritative. Never supplement it from an external model catalogue. */
export function availableModels(catalog: ProviderCatalog): Model[] {
  const connected = new Set(catalog.connected);
  const models = catalog.all.filter(provider => connected.has(provider.id)).flatMap(provider => Object.values(provider.models).filter(model => model.status !== "deprecated"));
  return [...new Map(models.map(model => [`${model.providerID}/${model.id}`, model])).values()];
}
