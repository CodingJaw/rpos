import fs = require('fs');
import path = require('path');
import { Utils } from './utils';

const utils = Utils.utils;

export type RecordingMode = 'Continuous' | 'Motion' | 'Alarm';

export interface DayScheduleItem {
  Start: string;
  End: string;
  Mode?: RecordingMode;
}

export interface WeeklySchedule {
  [day: string]: DayScheduleItem[];
}

export interface RecordingConfiguration {
  Mode: RecordingMode;
  Schedule: WeeklySchedule;
}

const DEFAULT_MODE: RecordingMode = 'Continuous';

const DEFAULT_SCHEDULE: WeeklySchedule = {
  Monday: [],
  Tuesday: [],
  Wednesday: [],
  Thursday: [],
  Friday: [],
  Saturday: [],
  Sunday: []
};

export class RecordingStore {
  private storePath: string;
  private configuration: RecordingConfiguration;

  constructor(storePath = './recording_store.json') {
    this.storePath = storePath;
    this.configuration = {
      Mode: DEFAULT_MODE,
      Schedule: DEFAULT_SCHEDULE
    };
    this.load();
  }

  getConfiguration(): RecordingConfiguration {
    return this.configuration;
  }

  setMode(mode: string): RecordingMode {
    const normalized = this.normaliseMode(mode);
    this.configuration.Mode = normalized;
    this.save();
    return normalized;
  }

  setSchedule(schedule: WeeklySchedule): WeeklySchedule {
    if (schedule && typeof schedule === 'object') {
      this.configuration.Schedule = { ...DEFAULT_SCHEDULE, ...schedule };
      this.save();
    }
    return this.configuration.Schedule;
  }

  private normaliseMode(mode: string): RecordingMode {
    const allowed: RecordingMode[] = ['Continuous', 'Motion', 'Alarm'];
    const match = allowed.find((item) => item.toLowerCase() === String(mode || '').toLowerCase());
    return match || DEFAULT_MODE;
  }

  private load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.Mode) this.configuration.Mode = this.normaliseMode(parsed.Mode);
        if (parsed.Schedule) this.configuration.Schedule = { ...DEFAULT_SCHEDULE, ...parsed.Schedule };
      } else {
        this.save();
      }
    } catch (error) {
      utils.log.warn('Failed to load recording store, resetting to defaults: %s', error);
      this.configuration = {
        Mode: DEFAULT_MODE,
        Schedule: DEFAULT_SCHEDULE
      };
      this.save();
    }
  }

  private save() {
    try {
      const dir = path.dirname(this.storePath);
      if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storePath, JSON.stringify(this.configuration, null, 2));
    } catch (error) {
      utils.log.error('Failed to persist recording store: %s', error);
    }
  }
}

