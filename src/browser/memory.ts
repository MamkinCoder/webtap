// Chromium process-tree accounting via `ps` (works on Linux and macOS; Stagehand does not expose
// the child pid, so the tree is rooted at processes carrying our --user-data-dir).
import { execFile } from "node:child_process";

interface Proc {
  pid: number;
  ppid: number;
  rssKB: number;
  command: string;
}

async function listProcesses(): Promise<Proc[]> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), command: m[4] ?? "" });
  }
  return procs;
}

/** Pids of every process whose command names `userDataDir`, plus all their descendants. */
function chromiumTree(procs: Proc[], userDataDir: string): Proc[] {
  const needle = `--user-data-dir=${userDataDir}`;
  const byParent = new Map<number, Proc[]>();
  for (const p of procs) {
    const kids = byParent.get(p.ppid) ?? [];
    kids.push(p);
    byParent.set(p.ppid, kids);
  }
  const seen = new Map<number, Proc>();
  const walk = (p: Proc): void => {
    if (seen.has(p.pid)) return;
    seen.set(p.pid, p);
    for (const k of byParent.get(p.pid) ?? []) walk(k);
  };
  // Whole argument: "…/chrome-profile" must not match the chat lane's "…/chrome-profile-chat".
  for (const p of procs) if (`${p.command} `.includes(`${needle} `)) walk(p);
  return [...seen.values()];
}

export async function chromiumTreeRssMB(userDataDir: string): Promise<number> {
  try {
    const tree = chromiumTree(await listProcesses(), userDataDir);
    return Math.round(tree.reduce((sum, p) => sum + p.rssKB, 0) / 1024);
  } catch {
    return 0;
  }
}

/** SIGKILLs whatever is still running for this profile after the normal close path. */
export async function killChromiumLeftovers(userDataDir: string): Promise<number> {
  try {
    const tree = chromiumTree(await listProcesses(), userDataDir);
    let killed = 0;
    for (const p of tree) {
      try {
        process.kill(p.pid, "SIGKILL");
        killed++;
      } catch {
        // already gone
      }
    }
    return killed;
  } catch {
    return 0;
  }
}
