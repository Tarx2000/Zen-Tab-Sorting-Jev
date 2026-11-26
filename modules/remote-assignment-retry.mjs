// Zen Tab Sorting — Resilient bounded-concurrency tab assignment collector.
//
// Features:
// - Respects `deadlineAt` and `signal` (`AbortSignal`) between waves and chunks.
// - Immediately short-circuits on fatal errors (`auth`, `quota`, `not_found`,
//   `abort`, `consent`) without fanning out into 12 -> 4 -> 1 retries.
// - Runs chunks with bounded concurrency (2-3 for cloud, 1 for local providers).
// - Validates strict `/^\d+$/` tab index keys and non-empty string values.
// - Caps retry fan-out: aborts wave/retries if >50% of chunks fail with
//   transport errors (stops cascading retry storms!).
// - Threads discovered `knownGroups` across retry prompts for consistent naming.

import {
  ERROR_CATEGORIES,
  classifyProviderError,
  isFatalProviderError,
} from "./provider-errors.mjs";

const RETRY_BATCH_SIZES = [12, 4, 1];
const MIN_REMAINING_BUDGET_MS = 800;

const isStrictIndexKey = (key) => /^\d+$/.test(String(key));

const isTransportError = (error) => {
  const cat = classifyProviderError(error?.status, error?.body, error);
  return (
    cat === ERROR_CATEGORIES.RATE_LIMIT ||
    cat === ERROR_CATEGORIES.TRANSIENT ||
    cat === ERROR_CATEGORIES.NETWORK ||
    cat === ERROR_CATEGORIES.TIMEOUT
  );
};

export const collectProviderTabMap = async ({
  tabs,
  snippets = [],
  initialBatchSize,
  label,
  buildPrompt,
  fetchJson,
  deadlineAt = null,
  signal = null,
  concurrency = null,
  isLocal = false,
  knownGroups = [],
}) => {
  const parsedByIndex = new Map();
  const failures = [];
  let pending = tabs.map((_, index) => index);
  let fatalError = null;
  let aborted = false;
  let budgetExhausted = false;

  const discoveredGroups = new Map();
  for (const g of Array.isArray(knownGroups) ? knownGroups : []) {
    const clean = String(g || "").trim();
    if (clean) discoveredGroups.set(clean.toLowerCase(), clean);
  }

  const effectiveConcurrency = Number.isFinite(concurrency) && concurrency >= 1
    ? Math.min(3, Math.floor(concurrency))
    : (isLocal ? 1 : 2);

  const hasBudget = () => {
    if (signal?.aborted) {
      aborted = true;
      return false;
    }
    if (Number.isFinite(deadlineAt) && deadlineAt - Date.now() < MIN_REMAINING_BUDGET_MS) {
      budgetExhausted = true;
      return false;
    }
    return true;
  };

  for (const batchSize of retryBatchSizes(initialBatchSize)) {
    if (pending.length === 0) break;
    if (!hasBudget() || fatalError) break;

    const chunks = chunkIndices(pending, batchSize);
    const waveResults = new Array(chunks.length);
    let nextCursor = 0;
    let transportFailureCount = 0;
    let completedChunks = 0;
    let stopWave = false;

    const workerCount = Math.min(effectiveConcurrency, chunks.length);
    const runWorker = async () => {
      while (!stopWave && !fatalError) {
        if (!hasBudget()) {
          stopWave = true;
          break;
        }
        const chunkIdx = nextCursor;
        if (chunkIdx >= chunks.length) break;
        nextCursor += 1;

        const indices = chunks[chunkIdx];
        const currentKnown = [...discoveredGroups.values()];
        try {
          const prompt = buildPrompt(
            indices.map((index) => tabs[index]),
            indices.map((index) => snippets[index]),
            currentKnown,
          );
          const parsed = await fetchJson(prompt, { signal, deadlineAt });
          waveResults[chunkIdx] = { ok: true, indices, parsed };
        } catch (error) {
          waveResults[chunkIdx] = { ok: false, indices, error };
          if (isFatalProviderError(error)) {
            fatalError = error;
            stopWave = true;
            break;
          }
          if (isTransportError(error)) {
            transportFailureCount += 1;
          }
        }
        completedChunks += 1;

        // Fan-out cap: if >50% of chunks in a multi-chunk wave fail with
        // transport errors, abort remaining retries instead of hammering.
        if (chunks.length >= 2 && completedChunks >= 2 && (transportFailureCount / completedChunks) > 0.5) {
          stopWave = true;
          break;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    const nextPending = [];
    for (let c = 0; c < chunks.length; c += 1) {
      const res = waveResults[c];
      if (!res) {
        // Chunk never ran because wave aborted early (fatal, deadline, signal, or >50% transport failures)
        nextPending.push(...chunks[c]);
        continue;
      }
      if (res.ok) {
        collectBatchAssignments({
          parsedByIndex,
          pending: nextPending,
          indices: res.indices,
          parsed: res.parsed,
          discoveredGroups,
        });
      } else {
        if (batchSize === 1 || fatalError || stopWave) {
          failures.push(`${label} tab ${res.indices[0]}: ${res.error?.message || res.error}`);
        }
        if (batchSize > 1) {
          nextPending.push(...res.indices);
        }
      }
    }

    pending = nextPending;

    // Stop retrying into smaller batches if fatal, aborted, deadline hit, or >50% transport failure rate
    if (fatalError || aborted || budgetExhausted) break;
    if (chunks.length >= 2 && (transportFailureCount / chunks.length) > 0.5) {
      failures.push(`${label} aborted retry wave after ${transportFailureCount}/${chunks.length} transport failures`);
      break;
    }
  }

  if (fatalError) {
    failures.push(`${label} stopped on fatal error: ${fatalError.message || fatalError}`);
  } else if (aborted) {
    failures.push(`${label} aborted`);
  } else if (budgetExhausted && pending.length > 0) {
    failures.push(`${label} time budget exceeded with ${pending.length} tab(s) remaining`);
  }

  if (pending.length > 0) failures.push(`${label} missing assignments for ${pending.length} tab(s)`);
  return {
    parsedByIndex,
    failures,
    missing: pending,
    knownGroups: [...discoveredGroups.values()],
    ...(fatalError ? { fatalError } : {}),
    ...(aborted ? { aborted: true } : {}),
    ...(budgetExhausted ? { budgetExhausted: true } : {}),
  };
};

const collectBatchAssignments = ({ parsedByIndex, pending, indices, parsed, discoveredGroups }) => {
  const assignedLocals = new Set();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Array.isArray(parsed.assignments)
      ? parsed.assignments
          .filter((item) => item && Number.isInteger(item.id) && typeof item.group === "string")
          .map((item) => [String(item.id), item.group])
      : Object.entries(parsed);

    for (const [key, value] of entries) {
      if (!isStrictIndexKey(key)) continue;
      const localIndex = Number.parseInt(key, 10);
      if (localIndex < 0 || localIndex >= indices.length) continue;
      if (typeof value !== "string" || !value.trim()) continue;

      const cleaned = value.trim();
      parsedByIndex.set(indices[localIndex], cleaned);
      assignedLocals.add(localIndex);

      const lower = cleaned.toLowerCase();
      if (lower !== "skipped" && lower !== "none" && discoveredGroups && !discoveredGroups.has(lower)) {
        discoveredGroups.set(lower, cleaned);
      }
    }
  }
  for (let localIndex = 0; localIndex < indices.length; localIndex += 1) {
    if (!assignedLocals.has(localIndex)) pending.push(indices[localIndex]);
  }
};

const retryBatchSizes = (initialBatchSize) => {
  const normalizedInitial = Number.isFinite(initialBatchSize) && initialBatchSize > 0
    ? Math.floor(initialBatchSize)
    : RETRY_BATCH_SIZES[0];
  return [...new Set([normalizedInitial, ...RETRY_BATCH_SIZES].filter((size) => size <= normalizedInitial))];
};

const chunkIndices = (indices, batchSize) => {
  const chunks = [];
  for (let start = 0; start < indices.length; start += batchSize) {
    chunks.push(indices.slice(start, start + batchSize));
  }
  return chunks;
};
