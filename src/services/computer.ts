import { gatewayHeaders } from './gateway';

// Local computer control client. The gateway enforces the hard safety floor
// (blocklist + workspace jail); this module adds the UX policy layer:
// risk classification, marker parsing, and a local audit trail.

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

export interface ComputerStatus {
  enabled: boolean;
  platform: string;
  workspace: string | null;
}

export type ComputerKind = 'screen' | 'open' | 'read' | 'write' | 'run';

export interface ComputerJob {
  kind: ComputerKind;
  /** Tool name shown in UI/transcripts. */
  name: string;
  /** Command, path, or target. */
  arg: string;
  /** Write content (WRITE jobs). */
  content: string;
  /** Human-readable detail for approvals + audit. */
  detail: string;
}

export type RiskLevel = 'read' | 'write' | 'system';

/** Read-only shell verbs that auto-run (with the user's opt-in toggle). */
const READONLY_RE =
  /^(ls|pwd|whoami|date|echo|cat|head|tail|wc|find|grep|ps|df|du|which|lsb_release|sw_vers|node --version|npm (--version|ls)|git (status|log|diff|branch))\b/i;

/** Mirrors the gateway blocklist for instant client-side refusal. The
 *  gateway re-checks authoritatively — this copy is UX only, never trust. */
const BLOCKED_RE = [
  /\brm\s+-[a-z]*r/i,
  /\bsudo\b/i,
  /(^|[;&|])\s*su\b/i,
  /\b(ssh|scp|sftp|rsync)\b/i,
  /curl[\s\S]*\|\s*(sh|bash)/i,
  /wget[\s\S]*\|\s*(sh|bash)/i,
  /:\(\)\s*\{/,
  /\bdd\b[\s\S]*of=\/dev/i,
  /\bmkfs\b/i,
  /\bsecurity\b\s+(dump|find-generic-password|delete-generic-password)/i,
  /keychain/i,
];

/** True when the command must never run, even approved. */
export function isBlocked(command: string): boolean {
  return BLOCKED_RE.some((re) => re.test(command));
}

/** UX risk class. 'blocked' is handled separately by isBlocked(). */
export function classifyRisk(command: string): RiskLevel {
  if (READONLY_RE.test(command.trim())) return 'read';
  if (/osascript|keystroke|defaults\s+write|launchctl/i.test(command)) return 'system';
  return 'write';
}

export const COMPUTER_TAG_RE = /\[(SCREEN|OPEN|READ|WRITE|RUN)(?::\s*([^\]]+))?\]/g;

/** Parse [SCREEN] / [OPEN: t] / [READ: p] / [WRITE: p | text] / [RUN: cmd]. */
export function parseComputerJobs(text: string): ComputerJob[] {
  const out: ComputerJob[] = [];
  const re = new RegExp(COMPUTER_TAG_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 6) {
    const kind = m[1].toLowerCase() as ComputerKind;
    const raw = (m[2] ?? '').trim();
    if (kind === 'screen') {
      out.push({ kind, name: 'screen', arg: '', content: '', detail: 'Capture the screen' });
      continue;
    }
    if (kind === 'write') {
      const bar = raw.indexOf('|');
      const p = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
      const c = bar >= 0 ? raw.slice(bar + 1).trim() : '';
      if (!p) continue;
      out.push({ kind, name: 'write_file', arg: p, content: c, detail: `Write ${p} (${c.length} chars)` });
      continue;
    }
    if (!raw) continue;
    const names = { open: 'open_app', read: 'read_file', run: 'run_shell' } as const;
    const detail =
      kind === 'open' ? `Open ${raw}` : kind === 'read' ? `Read ${raw}` : `Run: ${raw}`;
    out.push({ kind, name: names[kind], arg: raw, content: '', detail });
  }
  return out;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/computer/${path}`, {
    method: 'POST',
    headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 501) throw new Error('computer tools are disabled on the gateway');
  if (res.status === 403) {
    const data = (await res.json().catch(() => null)) as { reason?: string } | null;
    throw new Error(data?.reason ?? 'refused by safety policy');
  }
  if (!res.ok) throw new Error(`computer tool failed (${res.status})`);
  return (await res.json()) as unknown;
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/computer/${path}`, {
    headers: gatewayHeaders(),
    credentials: 'include',
  });
  if (res.status === 501) throw new Error('computer tools are disabled on the gateway');
  if (res.status === 403) throw new Error('refused by safety policy');
  if (!res.ok) throw new Error(`computer tool failed (${res.status})`);
  return (await res.json()) as unknown;
}

export function computerStatus(): Promise<ComputerStatus | null> {
  return get('status')
    .then((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      return {
        enabled: o.enabled === true,
        platform: String(o.platform ?? 'unknown'),
        workspace: typeof o.workspace === 'string' ? o.workspace : null,
      };
    })
    .catch(() => null);
}

export async function computerExec(command: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const r = (await post('exec', { command })) as Record<string, unknown>;
  return {
    code: typeof r.code === 'number' ? r.code : 1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    timedOut: r.timedOut === true,
  };
}

export async function computerOpen(target: string): Promise<void> {
  await post('open', { target });
}

export async function computerScreenshot(): Promise<string> {
  const r = (await get('screenshot')) as { image?: unknown };
  if (typeof r?.image !== 'string' || !r.image.startsWith('data:image/')) {
    throw new Error('screenshot unavailable');
  }
  return r.image;
}

export async function computerReadFile(path: string): Promise<string> {
  const r = (await get(`file?path=${encodeURIComponent(path)}`)) as { content?: unknown };
  if (typeof r?.content !== 'string') throw new Error('unreadable file');
  return r.content;
}

export async function computerWriteFile(path: string, content: string): Promise<void> {
  await post('files', { path, content });
}

// ─── audit trail (local, capped) ─────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  at: number;
  tool: string;
  detail: string;
  result: 'ok' | 'denied' | 'blocked' | 'failed';
  note?: string;
}

const AKEY = 'maya.audit.v1';

export function loadAudit(): AuditEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(AKEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as AuditEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordAudit(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
  const full: AuditEntry = { ...entry, id: crypto.randomUUID(), at: Date.now() };
  try {
    const all = [full, ...loadAudit()].slice(0, 200);
    localStorage.setItem(AKEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
  return full;
}
