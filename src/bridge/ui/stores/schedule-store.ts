import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  jobTemplate: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

interface ScheduleState {
  schedules: Schedule[];
  isLoading: boolean;
  error: string | null;
}

interface ScheduleActions {
  setSchedules: (schedules: Schedule[]) => void;
  addSchedule: (schedule: Schedule) => void;
  updateSchedule: (id: string, partial: Partial<Schedule>) => void;
  removeSchedule: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

type ScheduleStore = ScheduleState & ScheduleActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useScheduleStore = create<ScheduleStore>((set) => ({
  schedules: [],
  isLoading: false,
  error: null,

  setSchedules: (schedules) => {
    set({ schedules, error: null });
  },

  addSchedule: (schedule) => {
    set((state) => ({
      schedules: [schedule, ...state.schedules],
    }));
  },

  updateSchedule: (id, partial) => {
    set((state) => ({
      schedules: state.schedules.map((s) =>
        s.id === id ? { ...s, ...partial } : s,
      ),
    }));
  },

  removeSchedule: (id) => {
    set((state) => ({
      schedules: state.schedules.filter((s) => s.id !== id),
    }));
  },

  setLoading: (loading) => {
    set({ isLoading: loading });
  },

  setError: (error) => {
    set({ error });
  },
}));
