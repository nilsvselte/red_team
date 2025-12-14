import type { Post } from "./types";
import crypto from "node:crypto";

export type Cluster = {
  title: string;
  description: string;
  tags: string[];
  size: number;
};

export type AIPerspective = {
  summary: string;
  clusters: Cluster[];
  modelUsed: string;
  mode: "llm" | "heuristic";
};

export type GroupPostSummary = {
  id: Post["id"];
  title: string;
  takeaway: string;
};

export type GroupSummary = {
  key: string;
  label: string;
  count: number;
  overview: string;
  posts: GroupPostSummary[];
};

export type GroupedAIPerspective = {
  homeworks: GroupSummary[];
  models: GroupSummary[];
  modelUsed: string;
  mode: "llm" | "heuristic";
  note?: string;
};

const FALLBACK_SUMMARY =
  "Waiting for posts. Once the CSV is available, the AI reader will summarize entries and cluster them by theme.";

/**
 * Produces AI-flavored summaries. If OPENAI_API_KEY is present, we call it;
 * otherwise we fall back to lightweight heuristics so the page still works.
 */
export async function buildAIPerspective(threads: Post[]): Promise<AIPerspective> {
  if (!threads.length) {
    return {
      summary: "No posts found — check the CSV path and search filters.",
      clusters: [],
      modelUsed: "none",
      mode: "heuristic",
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      return await callOpenAI(threads, openaiKey);
    } catch (error) {
      return buildHeuristicPerspective(threads, `OpenAI failed: ${(error as Error).message}`);
    }
  }

  return buildHeuristicPerspective(threads, "OPENAI_API_KEY not provided.");
}

export async function buildGroupedAIPerspective(threads: Post[]): Promise<GroupedAIPerspective> {
  const heuristic = buildHeuristicGroupedPerspective(threads, "Heuristic baseline.");
  const { homeworkGroups, modelGroups } = groupThreads(threads);

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const enhanced = await callOpenAIForGroupsLimited({ homeworkGroups, modelGroups }, openaiKey);
      return mergeGroupPerspectives(heuristic, enhanced);
    } catch (error) {
      return buildHeuristicGroupedPerspective(threads, `OpenAI failed: ${(error as Error).message}`);
    }
  }

  return buildHeuristicGroupedPerspective(threads, "OPENAI_API_KEY not provided.");
}

async function callOpenAI(threads: Post[], apiKey: string): Promise<AIPerspective> {
  const sample = threads.slice(0, 24).map((thread) => ({
    id: thread.id,
    title: thread.title,
    body: thread.body?.slice(0, 600) ?? "",
    tags: thread.tags ?? [],
    type: thread.type,
  }));

  const prompt = [
    "You are distilling a course discussion board. Given these threads, produce:",
    "1) A crisp 2-3 sentence summary of the overall activity.",
    "2) 3-5 thematic clusters with a title, a one-line description, and how many posts belong.",
    "Keep it concise, concrete, and avoid fluffy language.",
  ].join("\n");

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const cacheKey = hashKey({
    kind: "overview",
    model,
    sample,
  });

  const cached = getCache<AIPerspective>(cacheKey);
  if (cached) return cached;

  const { content, modelUsed } = await openaiChatCompletion({
    apiKey,
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: "You generate dashboards that summarize discussions." },
      { role: "user", content: `${prompt}\n\nThreads:\n${JSON.stringify(sample, null, 2)}` },
    ],
  });

  const clusters = extractClusters(content);
  const result: AIPerspective = {
    summary: content.split("\n").slice(0, 3).join(" ").trim(),
    clusters,
    modelUsed,
    mode: "llm",
  };
  setCache(cacheKey, result);
  return result;
}

async function callOpenAIForGroupsLimited(
  groups: { homeworkGroups: Map<string, Post[]>; modelGroups: Map<string, Post[]> },
  apiKey: string
): Promise<GroupedAIPerspective> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const maxGroups = Number(process.env.AI_GROUP_MAX ?? 8);
  if (!Number.isFinite(maxGroups) || maxGroups <= 0) {
    return { homeworks: [], models: [], modelUsed: model, mode: "llm" };
  }

  const concurrency = Math.max(1, Number(process.env.AI_OPENAI_CONCURRENCY ?? 2));

  async function summarizeGroup(
    label: string,
    key: string,
    items: Post[]
  ): Promise<GroupSummary> {
    const sample = items.slice(0, 28).map((thread) => ({
      id: thread.id,
      title: thread.title,
      body: (thread.body ?? "").slice(0, 700),
      tags: thread.tags ?? [],
      author: thread.author ?? "",
      type: thread.type ?? "",
    }));

    const prompt = [
      "Summarize a group of discussion threads.",
      "Return STRICT JSON with this schema:",
      `{ "overview": string, "posts": [{ "id": string, "title": string, "takeaway": string }] }`,
      "Rules:",
      "- overview: 2-4 sentences, concrete, no fluff.",
      "- posts: include one entry per thread in input; takeaway is a single sentence describing the main result or request.",
      "- Use the thread's id and title exactly as provided.",
    ].join("\n");

    const cacheKey = hashKey({
      kind: "group",
      model,
      key,
      sample,
    });
    const cached = getCache<GroupSummary>(cacheKey);
    if (cached) return cached;

    const { content } = await openaiChatCompletion({
      apiKey,
      model,
      temperature: 0.25,
      messages: [
        { role: "system", content: "You produce precise, structured summaries." },
        { role: "user", content: `${prompt}\n\nGroup: ${label}\n\nThreads:\n${JSON.stringify(sample, null, 2)}` },
      ],
    });

    const parsed = safeParseJsonObject(content) as
      | { overview?: unknown; posts?: unknown }
      | null;

    const overview = typeof parsed?.overview === "string" ? parsed.overview : "";
    const postsRaw = Array.isArray(parsed?.posts) ? parsed.posts : [];
    const posts: GroupPostSummary[] = postsRaw
      .map((p) => {
        const record = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
        return {
          id: String(record.id ?? ""),
          title: typeof record.title === "string" ? record.title : "",
          takeaway: typeof record.takeaway === "string" ? record.takeaway : "",
        };
      })
      .filter((p) => p.id && p.title && p.takeaway);

    // If the model dropped some items, patch in missing ones heuristically.
    const seen = new Set(posts.map((p) => String(p.id)));
    const patched = [...posts];
    for (const thread of sample) {
      const id = String(thread.id);
      if (seen.has(id)) continue;
      patched.push({
        id,
        title: thread.title,
        takeaway: (thread.body || "No body.").slice(0, 120),
      });
    }

    const result: GroupSummary = {
      key,
      label,
      count: items.length,
      overview: overview || `AI summary unavailable for ${label}.`,
      posts: patched.slice(0, sample.length),
    };
    setCache(cacheKey, result);
    return result;
  }

  const homeworkEntries = Array.from(groups.homeworkGroups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxGroups);

  const modelEntries = Array.from(groups.modelGroups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxGroups);

  const homeworks = await mapWithConcurrency(homeworkEntries, concurrency, ([key, items]) =>
    summarizeGroup(`Homework ${key.replace(/^hw:/, "")}`, key, items)
  );
  const models = await mapWithConcurrency(modelEntries, concurrency, ([key, items]) =>
    summarizeGroup(`Model ${key.replace(/^model:/, "")}`, key, items)
  );

  return {
    homeworks,
    models,
    modelUsed: model,
    mode: "llm",
  };
}

function extractClusters(content: string): Cluster[] {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const clusters: Cluster[] = [];

  for (const line of lines) {
    const parts = line.replace(/^\d+[\.\)]\s*/, "").split(" - ");
    if (parts.length < 2) continue;
    const [title, rest] = parts;
    const sizeMatch = rest.match(/(\d+)\s*(posts|threads|items)?/i);
    const size = sizeMatch ? Number(sizeMatch[1]) : 0;
    clusters.push({
      title: title.trim(),
      description: rest.replace(sizeMatch?.[0] ?? "", "").trim(),
      tags: [],
      size,
    });
  }

  // If parsing failed, fall back to a generic cluster to avoid empty UI.
  if (!clusters.length) {
    clusters.push({
      title: "General activity",
      description: "Threads span questions, announcements, and project chatter.",
      tags: [],
      size: Math.max(1, content.length % 7),
    });
  }

  return clusters.slice(0, 5);
}

function buildHeuristicPerspective(threads: Post[], note: string): AIPerspective {
  const tagCounts = new Map<string, number>();
  threads.forEach((thread) => {
    (thread.tags ?? ["untagged"]).forEach((tag) => {
      const key = tag || "untagged";
      tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
    });
  });

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag, count]) => `${tag}: ${count}`)
    .join(", ");

  const clusters: Cluster[] = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag, count]) => ({
      title: tag,
      description: `AI bucketed ${count} threads under “${tag}”.`,
      tags: [tag],
      size: count,
    }));

  return {
    summary: threads.length
      ? `AI heuristic summary: ${threads.length} threads detected. Top tags — ${topTags || "no tags yet"}. ${note}`
      : FALLBACK_SUMMARY,
    clusters,
    modelUsed: "heuristic",
    mode: "heuristic",
  };
}

function buildHeuristicGroupedPerspective(threads: Post[], note: string): GroupedAIPerspective {
  const { homeworkGroups, modelGroups } = groupThreads(threads);

  const toSummary = (labelPrefix: string, key: string, items: Post[]): GroupSummary => ({
    key,
    label: `${labelPrefix} ${key.replace(/^(hw:|model:)/, "")}`,
    count: items.length,
    overview: `Heuristic overview: ${items.length} posts. ${note}`,
    posts: items.slice(0, 40).map((thread) => ({
      id: thread.id,
      title: thread.title,
      takeaway: (thread.body ?? "").slice(0, 120) || "No preview content available.",
    })),
  });

  const homeworks = Array.from(homeworkGroups.entries())
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([key, items]) => toSummary("Homework", key, items));

  const models = Array.from(modelGroups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, items]) => toSummary("Model", key, items));

  return {
    homeworks,
    models,
    modelUsed: "heuristic",
    mode: "heuristic",
    note,
  };
}

function mergeGroupPerspectives(
  baseline: GroupedAIPerspective,
  enhanced: GroupedAIPerspective
): GroupedAIPerspective {
  const byKey = new Map<string, GroupSummary>();
  for (const group of enhanced.homeworks) byKey.set(group.key, group);
  for (const group of enhanced.models) byKey.set(group.key, group);

  const homeworks = baseline.homeworks.map((group) => byKey.get(group.key) ?? group);
  const models = baseline.models.map((group) => byKey.get(group.key) ?? group);

  return {
    homeworks,
    models,
    modelUsed: enhanced.modelUsed,
    mode: enhanced.mode,
    note: baseline.note,
  };
}

function groupThreads(threads: Post[]): {
  homeworkGroups: Map<string, Post[]>;
  modelGroups: Map<string, Post[]>;
} {
  const homeworkGroups = new Map<string, Post[]>();
  const modelGroups = new Map<string, Post[]>();

  for (const thread of threads) {
    const tags = thread.tags ?? [];
    const text = `${thread.title}\n${thread.body ?? ""}\n${tags.join(" ")}`;

    const hwFromTags = tags.find((tag) => tag.toLowerCase().startsWith("hw:"));
    const hw = hwFromTags ? hwFromTags.split(":")[1]?.trim() : detectHomework(text);
    if (hw) pushMapUniqueById(homeworkGroups, `hw:${hw}`, thread);

    // Prefer base_model grouping if present (CSV), otherwise fallback to regex/dictionary.
    const baseModelFromTags = tags.find((tag) => tag.toLowerCase().startsWith("base_model:"));
    if (baseModelFromTags) {
      const base = baseModelFromTags.split(":")[1]?.trim();
      if (base) pushMapUniqueById(modelGroups, `model:${base}`, thread);
    } else {
      const models = detectModels(text);
      for (const model of models) pushMapUniqueById(modelGroups, `model:${model}`, thread);
    }

  }

  // Keep groups useful: drop very small model groups, but keep homework groups.
  for (const [key, items] of modelGroups.entries()) {
    if (items.length < 2) modelGroups.delete(key);
  }

  return { homeworkGroups, modelGroups };
}

function pushMapUniqueById(map: Map<string, Post[]>, key: string, value: Post) {
  const id = String(value.id);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [value]);
    return;
  }
  if (existing.some((item) => String(item.id) === id)) return;
  existing.push(value);
}

function detectHomework(input: string): string | null {
  const text = input.toLowerCase();
  const patterns = [
    /\bhw\s*([0-9]{1,2})\b/i,
    /\bhw[:\s_\-]*([0-9]{1,2})\b/i,
    /\bhomework\s*([0-9]{1,2})\b/i,
    /\bassignment\s*([0-9]{1,2})\b/i,
    /\bproj(?:ect)?\s*([0-9]{1,2})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function detectModels(input: string): string[] {
  const text = input.toLowerCase();
  const hits = new Set<string>();

  const dictionary: Array<{ key: string; patterns: RegExp[] }> = [
    { key: "gpt-4o", patterns: [/\bgpt[-\s]?4o\b/i] },
    { key: "gpt-4o-mini", patterns: [/\bgpt[-\s]?4o[-\s]?mini\b/i] },
    { key: "o1", patterns: [/\bo1\b/i, /\bo1[-\s]preview\b/i, /\bo1[-\s]mini\b/i] },
    { key: "claude", patterns: [/\bclaude\b/i, /\banthropic\b/i] },
    { key: "gemini", patterns: [/\bgemini\b/i] },
    { key: "llama", patterns: [/\bllama\b/i, /\bmeta[-\s]?llama\b/i] },
    { key: "mistral", patterns: [/\bmistral\b/i] },
    { key: "deepseek", patterns: [/\bdeepseek\b/i] },
    { key: "qwen", patterns: [/\bqwen\b/i] },
    { key: "grok", patterns: [/\bgrok\b/i] },
  ];

  for (const entry of dictionary) {
    if (entry.patterns.some((pattern) => pattern.test(text))) hits.add(entry.key);
  }

  // Generic "model: xyz" capture (best-effort)
  const modelLine = text.match(/\bmodel\s*[:=]\s*([a-z0-9\.\-\_]+)\b/i);
  if (modelLine?.[1]) hits.add(modelLine[1]);

  return Array.from(hits);
}

function safeParseJsonObject(input: string): unknown | null {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = input.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function openaiChatCompletion(params: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
}): Promise<{ content: string; modelUsed: string }> {
  const { apiKey, model, messages, temperature } = params;
  const url = "https://api.openai.com/v1/chat/completions";

  const maxAttempts = Math.max(1, Number(process.env.AI_OPENAI_MAX_RETRIES ?? 5));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
      }),
    });

    if (response.ok) {
      const json = await response.json();
      const content = json.choices?.[0]?.message?.content as string | undefined;
      if (!content) throw new Error("OpenAI response missing content");
      return { content, modelUsed: (json.model ?? model) as string };
    }

    // Rate limit / transient: retry with backoff.
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
      const backoffMs = Math.min(30_000, 600 * 2 ** (attempt - 1) + jitter(250));
      await sleep(Math.max(retryAfterMs, backoffMs));
      continue;
    }

    const body = await safeReadText(response);
    throw new Error(`OpenAI responded with ${response.status}${body ? `: ${body.slice(0, 140)}` : ""}`);
  }

  throw new Error("OpenAI retries exhausted (429/5xx).");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxMs: number) {
  return Math.floor(Math.random() * maxMs);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function hashKey(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function getCache<T>(key: string): T | null {
  const cache = getGlobalCache();
  return (cache.get(key) as T | undefined) ?? null;
}

function setCache(key: string, value: unknown) {
  const cache = getGlobalCache();
  cache.set(key, value);
}

function getGlobalCache(): Map<string, unknown> {
  const g = globalThis as unknown as { __ai_cache?: Map<string, unknown> };
  if (!g.__ai_cache) g.__ai_cache = new Map<string, unknown>();
  return g.__ai_cache;
}
