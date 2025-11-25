import fs = require('fs');

type AlarmInputChannelState = {
  id: string;
  path?: string;
  pollInterval: number;
  debounceMs: number;
  activeHigh: boolean;
  state: boolean | null;
  pending: boolean | null;
  simulatedOnly?: boolean;
  pollTimer?: NodeJS.Timeout;
  debounceTimer?: NodeJS.Timeout;
};

class EventDriver {
  private alarmInputs: AlarmInputChannelState[] = [];
  private alarmStateChanged?: (channelId: string, isActive: boolean) => void;

  constructor(config: rposConfig) {
    this.configureAlarmInputs(config);
  }

  public start() {
    this.alarmInputs.forEach((channel) => this.startAlarmMonitoring(channel));
  }

  public onAlarmStateChanged(callback: (channelId: string, isActive: boolean) => void) {
    this.alarmStateChanged = callback;
  }

  public getAlarmInputs(): AlarmInputChannelState[] {
    return this.alarmInputs;
  }

  private configureAlarmInputs(config: rposConfig) {
    const configured = (<any>config).AlarmInputs;
    const inputs = Array.isArray(configured) ? configured : [];

    if (inputs.length === 0) {
      const alarmInputPath = (<any>config).AlarmInputPath;
      const alarmInputPin = (<any>config).AlarmInputPin;

      if (alarmInputPath || alarmInputPin !== undefined && alarmInputPin !== null) {
        inputs.push({
          Path: alarmInputPath,
          Pin: alarmInputPin,
          PollInterval: (<any>config).AlarmInputPollInterval,
          DebounceMs: (<any>config).AlarmInputDebounceMs,
          ActiveHigh: (<any>config).AlarmInputActiveHigh
        });
      }
    }

    this.alarmInputs = inputs
      .slice(0, 4)
      .map((input, index) => this.normalizeAlarmInputConfig(input, index))
      .filter((entry): entry is AlarmInputChannelState => !!entry);

    if (this.alarmInputs.length === 0) {
      this.alarmInputs = Array.from({ length: 4 }, (_, index) => this.createSimulatedChannel(index + 1));
    }
  }

  private normalizeAlarmInputConfig(rawInput: any, index: number): AlarmInputChannelState | null {
    const path = rawInput?.Path
      ? rawInput.Path
      : rawInput?.Pin !== undefined && rawInput?.Pin !== null
        ? `/sys/class/gpio/gpio${rawInput.Pin}/value`
        : undefined;

    if (!path) return null;

    const pollInterval = typeof rawInput?.PollInterval === 'number' ? rawInput.PollInterval : 200;
    const debounceMs = typeof rawInput?.DebounceMs === 'number' ? rawInput.DebounceMs : 200;
    const activeHigh = typeof rawInput?.ActiveHigh === 'boolean' ? rawInput.ActiveHigh : true;
    const id = rawInput?.Id || `input${index + 1}`;

    return {
      id,
      path,
      pollInterval,
      debounceMs,
      activeHigh,
      state: null,
      pending: null
    };
  }

  private createSimulatedChannel(index: number): AlarmInputChannelState {
    return {
      id: `input${index}`,
      pollInterval: 200,
      debounceMs: 200,
      activeHigh: true,
      simulatedOnly: true,
      state: null,
      pending: null
    };
  }

  private startAlarmMonitoring(channel: AlarmInputChannelState) {
    if (!channel.path) return;
    const pollInput = () => {
      const state = this.readAlarmInput(channel);
      if (state === null) return;
      this.handleAlarmSample(channel, state);
    };

    pollInput();
    channel.pollTimer = setInterval(pollInput, channel.pollInterval);
  }

  private readAlarmInput(channel: AlarmInputChannelState): boolean | null {
    if (!channel.path) return null;
    try {
      const rawValue = fs.readFileSync(channel.path, 'utf8').trim();
      const numericValue = parseInt(rawValue, 10);
      const isActive = isNaN(numericValue) ? rawValue === 'true' : numericValue !== 0;
      return channel.activeHigh ? isActive : !isActive;
    } catch (err) {
      console.log(`EventDriver - Unable to read alarm input at ${channel.path}`);
      return null;
    }
  }

  private handleAlarmSample(channel: AlarmInputChannelState, sample: boolean) {
    if (channel.pending === sample && channel.debounceTimer) return;

    if (channel.debounceTimer) {
      clearTimeout(channel.debounceTimer);
    }

    channel.pending = sample;
    channel.debounceTimer = setTimeout(() => {
      channel.debounceTimer = undefined;
      if (channel.state === sample) return;
      channel.state = sample;
      if (this.alarmStateChanged) {
        this.alarmStateChanged(channel.id, sample);
      }
    }, channel.debounceMs);
  }

  public simulateAlarmInput(channelId: string, isActive: boolean): boolean {
    const channel = this.findAlarmChannel(channelId);
    if (!channel) return false;
    this.handleAlarmSample(channel, isActive);
    return true;
  }

  private findAlarmChannel(channelId: string): AlarmInputChannelState | undefined {
    const normalizedId = channelId.trim();
    const candidateIds = [normalizedId];

    if (/^\d+$/.test(normalizedId)) {
      candidateIds.push(`input${normalizedId}`);
    } else if (normalizedId.toLowerCase().startsWith('input')) {
      const suffix = normalizedId.substring(5);
      if (suffix) {
        candidateIds.push(suffix);
      }
    }

    return this.alarmInputs.find((input) => candidateIds.includes(input.id));
  }
}

namespace EventDriver {
  export type AlarmInputChannel = AlarmInputChannelState;
}

export = EventDriver;
