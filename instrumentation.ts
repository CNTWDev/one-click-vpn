/** Next.js calls this once per server process; background work starts here, not on a request. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.VEILBIRD_DATABASE_URL) return;
  const { startAccessJobs } = await import("./server/access-jobs");
  startAccessJobs();
}
