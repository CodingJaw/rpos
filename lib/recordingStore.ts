import fs = require('fs');
import path = require('path');
import { Utils } from './utils';

const utils = Utils.utils;

export type RecordingMode = 'Continuous' | 'Motion' | 'Alarm';

export interface RecordingScheduleEntry {
  Day: string;
  Start: string;
  End: string;
  Enabled: boolean;
}

interface RecordingStoreState {
  mode: RecordingMode;
  schedule: RecordingScheduleEntry[];
}

const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export class RecordingConfigStore {
  private state: RecordingStoreState;
  private filePath: string;

  constructor(storePath?: string) {
    this.filePath = storePath || path.join(process.cwd(), 'recording_store.json');
    this.state = {
      mode: 'Continuous',
      schedule: this.defaultSchedule(),
    };

    this.load();
  }

  getSupportedModes(): RecordingMode[] {
    return ['Continuous', 'Motion', 'Alarm'];
  }

  getMode(): RecordingMode {
    return this.state.mode;
  }

  setMode(modeInput: string | RecordingMode): RecordingMode {
    const normalized = this.normalizeMode(modeInput);
    this.state.mode = normalized;
    this.save();
    return normalized;
  }

  getSchedule(): RecordingScheduleEntry[] {
    return this.state.schedule.map((entry) => ({ ...entry }));
  }

  setSchedule(rawSchedule: any): RecordingScheduleEntry[] {
    const normalized = this.normalizeSchedule(rawSchedule);
    this.state.schedule = normalized;
    this.save();
    return this.getSchedule();
  }

  private normalizeMode(modeInput: string | RecordingMode): RecordingMode {
    if (typeof modeInput !== 'string') {
      return this.state.mode;
    }

    const mode = modeInput.toLowerCase();
    if (mode === 'continuous') return 'Continuous';
    if (mode === 'motion') return 'Motion';
    if (mode === 'alarm') return 'Alarm';

    utils.log.warn('Unknown recording mode "%s" - keeping %s', modeInput, this.state.mode);
    return this.state.mode;
  }

  private normalizeSchedule(rawSchedule: any): RecordingScheduleEntry[] {
    const entries = this.asArray(rawSchedule?.Entry || rawSchedule?.Entries || rawSchedule?.items || rawSchedule);
    const normalized: RecordingScheduleEntry[] = [];

    for (const rawEntry of entries) {
      if (!rawEntry) continue;

      const day = this.normalizeDay(rawEntry.Day || rawEntry.day || rawEntry.DayOfWeek || rawEntry.weekday);
      if (!day) continue;

      const start = this.normalizeTime(rawEntry.Start || rawEntry.StartTime || rawEntry.From, '00:00:00');
      const end = this.normalizeTime(rawEntry.End || rawEntry.EndTime || rawEntry.To, '23:59:59');
      const enabled = rawEntry.Enabled === undefined ? true : ['true', '1', 1, true].includes(rawEntry.Enabled);

      normalized.push({ Day: day, Start: start, End: end, Enabled: enabled });
    }

    if (!normalized.length) {
      utils.log.warn('Recording schedule empty or invalid, using default.');
      return this.defaultSchedule();
    }

    return normalized;
  }

  private normalizeDay(day: any): string | null {
    if (typeof day === 'number' && day >= 0 && day < 7) {
      return VALID_DAYS[day];
    }

    if (typeof day === 'string') {
      const match = VALID_DAYS.find((d) => d.toLowerCase() === day.toLowerCase());
      if (match) return match;
    }

    utils.log.warn('Invalid day in recording schedule entry: %s', day);
    return null;
  }

  private normalizeTime(value: any, fallback: string): string {
    if (typeof value === 'string') {
      const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (match) {
        const hours = this.clamp(parseInt(match[1], 10), 0, 23);
        const minutes = this.clamp(parseInt(match[2], 10), 0, 59);
        const seconds = this.clamp(parseInt(match[3] || '0', 10), 0, 59);
        return `${this.pad(hours)}:${this.pad(minutes)}:${this.pad(seconds)}`;
      }
    }

    utils.log.warn('Invalid time in recording schedule entry: %s', value);
    return fallback;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private pad(value: number): string {
    return value.toString().padStart(2, '0');
  }

  private asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  }

  private defaultSchedule(): RecordingScheduleEntry[] {
    return VALID_DAYS.map((day) => ({
      Day: day,
      Start: '00:00:00',
      End: '23:59:59',
      Enabled: true,
    }));
  }

  private load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.save();
        return;
      }

      const content = fs.readFileSync(this.filePath, 'utf8');
      if (!content) return;

      const parsed = JSON.parse(content);
      if (parsed.mode) this.state.mode = this.normalizeMode(parsed.mode);
      if (parsed.schedule) this.state.schedule = this.normalizeSchedule(parsed.schedule);
    } catch (err) {
      utils.log.warn('Failed to load recording store, using defaults: %s', err.message);
    }
  }

  private save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      utils.log.error('Failed to persist recording store: %s', err.message);
    }
  }
}

