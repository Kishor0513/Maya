import type { MayaTool } from '../../types';
import { gatewayHeaders } from '../gateway';

// Client-visible tool registry. Execution of privileged tools happens
// server-side; this module defines the contract + safe local utilities.

export const MAYA_TOOLS: MayaTool[] = [
  {
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression locally.',
    execute: async (args: unknown) => {
      const expr = String((args as { expr?: unknown })?.expr ?? '');
      if (!/^[0-9+\-*/().\s%^]+$/.test(expr) || expr.length > 60)
        throw new Error('Unsafe expression');
      const sanitized = expr.replace(/\^/g, '**');
      const fn = new Function(`return (${sanitized})`);
      const value = fn() as unknown;
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('No numeric result');
      return { result: value };
    },
  },
  {
    name: 'web_search',
    description: 'Search the web via the backend gateway (server-side).',
    execute: async (args: unknown) => {
      const q = String((args as { query?: unknown })?.query ?? '');
      const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
      const res = await fetch(`${base.replace(/\/$/, '')}/api/tools/web_search`, {
        method: 'POST',
        headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) throw new Error('Search unavailable');
      return (await res.json()) as unknown;
    },
  },
  {
    name: 'notes',
    description: 'Save a quick note to local storage.',
    execute: async (args: unknown) => {
      const text = String((args as { text?: unknown })?.text ?? '').slice(0, 500);
      const prev = JSON.parse(localStorage.getItem('maya.notes.v1') ?? '[]') as string[];
      prev.unshift(`${new Date().toISOString()}: ${text}`);
      localStorage.setItem('maya.notes.v1', JSON.stringify(prev.slice(0, 100)));
      return { saved: true };
    },
  },
];

export function getTool(name: string): MayaTool | undefined {
  return MAYA_TOOLS.find((t) => t.name === name);
}
