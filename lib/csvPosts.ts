import fs from "node:fs/promises";
import path from "node:path";
import type { CsvPost } from "./types";

const DEFAULT_CSV_PATH = path.join(process.cwd(), "special_participation_a.csv");

export async function fetchCsvPosts(): Promise<{
  threads: CsvPost[];
  source: "csv";
  warning?: string;
}> {
  const csvPath = process.env.CSV_PATH ? path.resolve(process.env.CSV_PATH) : DEFAULT_CSV_PATH;

  try {
    const csv = await fs.readFile(csvPath, "utf8");
    const rows = parseCsv(csv);
    const header = rows[0];
    if (!header) {
      return { threads: [], source: "csv", warning: "CSV file is empty." };
    }

    const records = rows.slice(1).map((row) => buildRecord(header, row));
    const threads = dedupeById(
      records
        .filter((record) => record)
        .map((record) => toThread(record as Record<string, string>))
    );

    return { threads, source: "csv" };
  } catch (error) {
    return {
      threads: [],
      source: "csv",
      warning: `Failed to read CSV (${(error as Error).message}).`,
    };
  }
}

export async function fetchCsvPostById(id: string): Promise<{
  thread: CsvPost | null;
  source: "csv";
  warning?: string;
}> {
  const { threads, warning } = await fetchCsvPosts();
  const match = threads.find((thread) => String(thread.id) === id);
  return { thread: match ?? null, source: "csv", warning: match ? warning : warning ?? "Not found." };
}

function toThread(record: Record<string, string>): CsvPost {
  const titleClean = record.title_clean?.trim();
  const titleRaw = record.title_raw?.trim();
  const hwNumber = (record.hw_number ?? "").trim();
  const model = (record.model ?? "").trim();
  const baseModel = (record.base_model ?? "").trim();
  const version = (record.version ?? "").trim();
  const name = (record.name ?? "").trim();
  const text = record.text ?? "";
  const url = record.url?.trim();
  const threadId = (record.thread_id ?? "").trim();

  const tags = [
    hwNumber ? `hw:${hwNumber}` : "",
    model ? `model:${model}` : "",
    baseModel ? `base_model:${baseModel}` : "",
    version ? `version:${version}` : "",
  ].filter(Boolean);

  return {
    id: threadId || crypto.randomUUID(),
    title: titleClean || titleRaw || "Untitled",
    body: text,
    type: "special_participation",
    tags,
    author: name || "Unknown author",
    url: url || undefined,
    model,
    baseModel,
    version,
    hwNumber,
    name,
    titleRaw,
    threadId,
  };
}

function dedupeById(threads: CsvPost[]): CsvPost[] {
  const seen = new Set<string>();
  const out: CsvPost[] = [];
  for (const thread of threads) {
    const key = String(thread.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(thread);
  }
  return out;
}

function buildRecord(header: string[], row: string[]): Record<string, string> | null {
  if (!row.length) return null;
  const record: Record<string, string> = {};
  for (let i = 0; i < header.length; i += 1) {
    const key = header[i];
    if (!key) continue;
    record[key] = row[i] ?? "";
  }
  return record;
}

/**
 * Minimal CSV parser that handles RFC4180-style quotes and newlines inside quoted fields.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}
