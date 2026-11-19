// The fixture interprets only structured observations from the configured diagnostic.
export function pausedWorker(result) {
  try {
    const evidence = JSON.parse(result);
    const queue = evidence.diagnostics.find(d => d.name === 'export_queue' && d.status === 200);
    const worker = JSON.parse(queue.body);
    return evidence.health.status === 503 && worker.worker_running === false && worker.recovering === false;
  } catch { return false; }
}
