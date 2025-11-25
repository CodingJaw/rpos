///<reference path="../rpos.d.ts" />

import fs = require('fs');

class AlarmInputMonitor {
  private alarmStateChanged?: (state: boolean) => void;
  private alarmInputPath?: string;
  private alarmInputPollInterval: number = 200;
  private alarmInputDebounceMs: number = 200;
  private alarmInputActiveHigh: boolean = true;
  private alarmState: boolean | null = null;
  private pendingAlarmState: boolean | null = null;
  private alarmPollTimer?: NodeJS.Timeout;
  private alarmDebounceTimer?: NodeJS.Timeout;

  constructor(config: rposConfig, alarmStateChanged?: (state: boolean) => void) {
    this.alarmStateChanged = alarmStateChanged;
    this.configureAlarmInput(config);
  }

  private configureAlarmInput(config: rposConfig) {
    const alarmInputPath = (<any>config).AlarmInputPath;
    const alarmInputPin = (<any>config).AlarmInputPin;
    const alarmInputPollInterval = (<any>config).AlarmInputPollInterval;
    const alarmInputDebounceMs = (<any>config).AlarmInputDebounceMs;
    const alarmInputActiveHigh = (<any>config).AlarmInputActiveHigh;

    if (alarmInputPath) {
      this.alarmInputPath = alarmInputPath;
    } else if (alarmInputPin !== undefined && alarmInputPin !== null) {
      this.alarmInputPath = `/sys/class/gpio/gpio${alarmInputPin}/value`;
    }

    if (!this.alarmInputPath) {
      return;
    }

    if (typeof alarmInputPollInterval === 'number') {
      this.alarmInputPollInterval = alarmInputPollInterval;
    }
    if (typeof alarmInputDebounceMs === 'number') {
      this.alarmInputDebounceMs = alarmInputDebounceMs;
    }
    if (typeof alarmInputActiveHigh === 'boolean') {
      this.alarmInputActiveHigh = alarmInputActiveHigh;
    }

    this.startAlarmMonitoring();
  }

  private startAlarmMonitoring() {
    const pollInput = () => {
      const state = this.readAlarmInput();
      if (state === null) return;
      this.handleAlarmSample(state);
    };

    pollInput();
    this.alarmPollTimer = setInterval(pollInput, this.alarmInputPollInterval);
  }

  private readAlarmInput(): boolean | null {
    if (!this.alarmInputPath) return null;

    try {
      const rawValue = fs.readFileSync(this.alarmInputPath, 'utf8').trim();
      const numericValue = parseInt(rawValue, 10);
      const isActive = isNaN(numericValue) ? rawValue === 'true' : numericValue !== 0;
      return this.alarmInputActiveHigh ? isActive : !isActive;
    } catch (err) {
      console.log(`AlarmInputMonitor - Unable to read alarm input at ${this.alarmInputPath}`);
      return null;
    }
  }

  private handleAlarmSample(sample: boolean) {
    if (this.pendingAlarmState === sample && this.alarmDebounceTimer) return;

    if (this.alarmDebounceTimer) {
      clearTimeout(this.alarmDebounceTimer);
    }

    this.pendingAlarmState = sample;
    this.alarmDebounceTimer = setTimeout(() => {
      this.alarmDebounceTimer = undefined;
      if (this.alarmState === sample) return;
      this.alarmState = sample;
      if (this.alarmStateChanged) this.alarmStateChanged(sample);
    }, this.alarmInputDebounceMs);
  }

  public dispose() {
    if (this.alarmPollTimer) clearInterval(this.alarmPollTimer);
    if (this.alarmDebounceTimer) clearTimeout(this.alarmDebounceTimer);
  }
}

export = AlarmInputMonitor;
