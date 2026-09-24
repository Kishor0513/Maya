import { create } from 'zustand';
import type { ComputerStatus, RiskLevel } from '../services/computer';
import { computerStatus } from '../services/computer';

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  detail: string;
  risk: RiskLevel;
  warning?: string;
}

let resolver: ((allow: boolean) => void) | null = null;

interface ComputerStore {
  pending: ApprovalRequest | null;
  status: ComputerStatus | null;
  refreshStatus: () => Promise<void>;
  /** Pause the tool loop until the user allows or denies. */
  requestApproval: (req: Omit<ApprovalRequest, 'id'>) => Promise<boolean>;
  resolveApproval: (allow: boolean) => void;
}

export const useComputerStore = create<ComputerStore>((set) => ({
  pending: null,
  status: null,
  refreshStatus: async () => {
    const status = await computerStatus().catch(() => null);
    set({ status });
  },
  requestApproval: (req) =>
    new Promise<boolean>((resolve) => {
      resolver = resolve;
      set({ pending: { ...req, id: crypto.randomUUID() } });
    }),
  resolveApproval: (allow) => {
    resolver?.(allow);
    resolver = null;
    set({ pending: null });
  },
}));
