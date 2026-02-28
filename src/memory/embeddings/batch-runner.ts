export async function runEmbeddingBatches<T>(params: {
	items: T[];
	maxBatchSize: number;
	concurrency: number;
	runBatch: (items: T[]) => Promise<number[][]>;
}): Promise<number[][]> {
	const { items } = params;
	if (items.length === 0) return [];
	const batches = splitIntoBatches(items, Math.max(1, params.maxBatchSize));
	const results: number[][] = Array.from({ length: items.length });
	const tasks = batches.map((batch, batchIndex) => async () => {
		const embeddings = await params.runBatch(batch);
		const start = batchIndex * params.maxBatchSize;
		for (let i = 0; i < batch.length; i += 1) {
			results[start + i] = embeddings[i] ?? [];
		}
	});
	await runWithConcurrency(tasks, Math.max(1, params.concurrency));
	return results;
}

function splitIntoBatches<T>(items: T[], maxBatchSize: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += maxBatchSize) {
		batches.push(items.slice(i, i + maxBatchSize));
	}
	return batches;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<void> {
	if (tasks.length === 0) return;
	const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
	let next = 0;
	const workers = Array.from({ length: resolvedLimit }, async () => {
		while (true) {
			const index = next;
			next += 1;
			if (index >= tasks.length) return;
			await tasks[index]();
		}
	});
	await Promise.all(workers);
}