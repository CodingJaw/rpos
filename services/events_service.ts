///<reference path="../rpos.d.ts" />

import fs = require('fs');
import { Utils } from '../lib/utils';
import SoapService = require('../lib/SoapService');
import { Server } from 'http';
import crypto = require('crypto');

const utils = Utils.utils;

type NotificationMessage = {
  Topic: any;
  ProducerReference?: any;
  Message: any;
};

type PullPointSubscription = {
  id: string;
  terminationTime: Date;
  queue: NotificationMessage[];
};

type AlarmInputChannel = {
  id: string;
  path: string;
  pollInterval: number;
  debounceMs: number;
  activeHigh: boolean;
  state: boolean | null;
  pending: boolean | null;
  pollTimer?: NodeJS.Timeout;
  debounceTimer?: NodeJS.Timeout;
};

class EventsService extends SoapService {
  private subscriptions: Map<string, PullPointSubscription> = new Map();
  private defaultTerminationSeconds = 15 * 60; // 15 minutes
  private motionState: boolean | null = null;
  private alarmInputs: AlarmInputChannel[] = [];

  constructor(config: rposConfig, server: Server) {
    super(config, server);

    this.serviceOptions = {
      path: '/onvif/events_service',
      services: this.buildServiceDefinition(),
      xml: fs.readFileSync('./wsdl/event_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/event_service.wsdl',
      onReady: () => utils.log.info('events_service started')
    };

    this.configureAlarmInputs(config);
  }

  public publishMotionState(isActive: boolean) {
    if (this.motionState === isActive) return;
    this.motionState = isActive;
    this.broadcastNotification(this.createSimpleNotification(
      'tns1:RuleEngine/CellMotionDetector/Motion',
      'IsMotion',
      isActive
    ));
  }

  public publishAlarmState(channelId: string, isActive: boolean) {
    const channel = this.alarmInputs.find((input) => input.id === channelId);
    if (!channel || channel.state === isActive) return;
    channel.state = isActive;
    this.broadcastNotification(this.createSimpleNotification(
      'tns1:Device/Trigger/DigitalInput',
      'IsActive',
      isActive,
      channelId
    ));
  }

  public getMotionCallback(): (state: boolean) => void {
    return (state: boolean) => this.publishMotionState(state);
  }

  public getAlarmCallback(): (state: boolean) => void {
    return (state: boolean) => {
      if (this.alarmInputs.length === 0) return;
      this.publishAlarmState(this.alarmInputs[0].id, state);
    };
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
      .filter((entry): entry is AlarmInputChannel => !!entry);

    this.alarmInputs.forEach((channel) => this.startAlarmMonitoring(channel));
  }

  private normalizeAlarmInputConfig(rawInput: any, index: number): AlarmInputChannel | null {
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

  private startAlarmMonitoring(channel: AlarmInputChannel) {
    const pollInput = () => {
      const state = this.readAlarmInput(channel);
      if (state === null) return;
      this.handleAlarmSample(channel, state);
    };

    pollInput();
    channel.pollTimer = setInterval(pollInput, channel.pollInterval);
  }

  private readAlarmInput(channel: AlarmInputChannel): boolean | null {
    try {
      const rawValue = fs.readFileSync(channel.path, 'utf8').trim();
      const numericValue = parseInt(rawValue, 10);
      const isActive = isNaN(numericValue) ? rawValue === 'true' : numericValue !== 0;
      return channel.activeHigh ? isActive : !isActive;
    } catch (err) {
      console.log(`EventsService - Unable to read alarm input at ${channel.path}`);
      return null;
    }
  }

  private handleAlarmSample(channel: AlarmInputChannel, sample: boolean) {
    if (channel.pending === sample && channel.debounceTimer) return;

    if (channel.debounceTimer) {
      clearTimeout(channel.debounceTimer);
    }

    channel.pending = sample;
    channel.debounceTimer = setTimeout(() => {
      channel.debounceTimer = undefined;
      if (channel.state === sample) return;
      this.publishAlarmState(channel.id, sample);
    }, channel.debounceMs);
  }

  private buildServiceDefinition() {
    const service: any = { EventsService: { EventsPort: {} } };
    const port = service.EventsService.EventsPort;

    port.GetServiceCapabilities = () => {
      return {
        Capabilities: {
          attributes: { xmlns: 'http://www.onvif.org/ver10/events/wsdl' },
          WSSubscriptionPolicySupport: false,
          WSPullPointSupport: true,
          WSPausableSubscriptionManagerInterfaceSupport: false
        }
      };
    };

    port.GetEventProperties = () => {
      return {
        TopicNamespaceLocation: 'http://www.onvif.org/onvif/ver10/topics',
        TopicSet: {
          attributes: {
            'xmlns:tns1': 'http://www.onvif.org/ver10/topics'
          },
          'tns1:RuleEngine': {
            'tns1:CellMotionDetector': {
              'tns1:Motion': {
                attributes: { PropertyOperation: 'Changed' },
                $value: ''
              }
            }
          },
          'tns1:Device': {
            'tns1:Trigger': {
              'tns1:DigitalInput': {
                attributes: { PropertyOperation: 'Changed' },
                $value: ''
              }
            }
          }
        },
        FixedTopicSet: true,
        TopicExpressionDialect: 'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete',
        MessageContentFilterDialect: 'http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter'
      };
    };

    port.CreatePullPointSubscription = (args: any) => {
      const { terminationTime, id } = this.createSubscription(args?.InitialTerminationTime);
      const response: any = {
        SubscriptionReference: {
          Address: `http://${utils.getIpAddress()}:${this.config.ServicePort}/onvif/events_service/subscription/${id}`,
          ReferenceParameters: { SubscriptionId: id }
        },
        CurrentTime: new Date().toISOString(),
        TerminationTime: terminationTime.toISOString()
      };

      if (this.motionState !== null) {
        this.enqueueInitialState(id, this.createSimpleNotification('tns1:RuleEngine/CellMotionDetector/Motion', 'IsMotion', this.motionState));
      }
      this.alarmInputs
        .filter((input) => input.state !== null)
        .forEach((input) =>
          this.enqueueInitialState(
            id,
            this.createSimpleNotification('tns1:Device/Trigger/DigitalInput', 'IsActive', !!input.state, input.id)
          )
        );

      return response;
    };

    port.PullMessages = (args: any) => {
      const messageLimit = args?.MessageLimit ? parseInt(args.MessageLimit, 10) : 10;
      const subscription = this.getSubscription(args?.SubscriptionId);
      if (!subscription) {
        return {
          CurrentTime: new Date().toISOString(),
          TerminationTime: new Date(0).toISOString(),
          NotificationMessage: []
        };
      }

      this.cleanupExpiredSubscriptions();

      const messages = subscription.queue.splice(0, Math.max(1, messageLimit));
      return {
        CurrentTime: new Date().toISOString(),
        TerminationTime: subscription.terminationTime.toISOString(),
        NotificationMessage: messages
      };
    };

    port.Renew = (args: any) => {
      const subscription = this.getSubscription(args?.SubscriptionId);
      if (!subscription) return { TerminationTime: new Date(0).toISOString() };

      subscription.terminationTime = this.calculateTermination(args?.TerminationTime);
      return { TerminationTime: subscription.terminationTime.toISOString() };
    };

    port.Unsubscribe = (args: any) => {
      const id = args?.SubscriptionId;
      if (id) this.subscriptions.delete(id);
      return {};
    };

    port.SetSynchronizationPoint = () => {
      return {};
    };

    return service;
  }

  private createSubscription(initialTermination?: string) {
    const id = crypto.randomBytes(8).toString('hex');
    const terminationTime = this.calculateTermination(initialTermination);
    this.subscriptions.set(id, { id, terminationTime, queue: [] });
    return { id, terminationTime };
  }

  private calculateTermination(requested?: string): Date {
    if (requested) {
      const duration = this.parseDuration(requested);
      if (duration > 0) {
        return new Date(Date.now() + duration * 1000);
      }
      const asDate = new Date(requested);
      if (!isNaN(asDate.getTime())) return asDate;
    }
    return new Date(Date.now() + this.defaultTerminationSeconds * 1000);
  }

  private parseDuration(value: string): number {
    try {
      if (!value) return 0;
      if (value.startsWith('PT') && value.endsWith('S')) {
        return parseInt(value.replace('PT', '').replace('S', ''), 10);
      }
      if (value.startsWith('PT') && value.endsWith('M')) {
        const minutes = parseInt(value.replace('PT', '').replace('M', ''), 10);
        return minutes * 60;
      }
      if (value.startsWith('PT') && value.endsWith('H')) {
        const hours = parseInt(value.replace('PT', '').replace('H', ''), 10);
        return hours * 60 * 60;
      }
    } catch (err) {
      utils.log.debug('Failed to parse duration %s', value);
    }
    return 0;
  }

  private getSubscription(requestedId?: string): PullPointSubscription | undefined {
    this.cleanupExpiredSubscriptions();
    if (requestedId && this.subscriptions.has(requestedId)) {
      return this.subscriptions.get(requestedId);
    }
    if (this.subscriptions.size === 1) {
      return Array.from(this.subscriptions.values())[0];
    }
    return undefined;
  }

  private cleanupExpiredSubscriptions() {
    const now = Date.now();
    for (const [id, subscription] of this.subscriptions.entries()) {
      if (subscription.terminationTime.getTime() < now) {
        this.subscriptions.delete(id);
      }
    }
  }

  private enqueueInitialState(id: string, message: NotificationMessage) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    subscription.queue.push(message);
  }

  private broadcastNotification(message: NotificationMessage) {
    this.cleanupExpiredSubscriptions();
    for (const subscription of this.subscriptions.values()) {
      subscription.queue.push(message);
    }
  }

  private createSimpleNotification(topic: string, stateName: string, isActive: boolean, sourceId?: string): NotificationMessage {
    const now = new Date().toISOString();
    const source = sourceId
      ? {
          SimpleItem: {
            attributes: {
              Name: 'InputToken',
              Value: sourceId
            }
          }
        }
      : {};
    return {
      Topic: {
        attributes: {
          Dialect: 'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete'
        },
        $value: topic
      },
      Message: {
        Message: {
          attributes: {
            UtcTime: now,
            PropertyOperation: 'Changed'
          },
          Source: source,
          Data: {
            SimpleItem: {
              attributes: {
                Name: stateName,
                Value: isActive ? 'true' : 'false'
              }
            }
          }
        }
      }
    };
  }
}

export = EventsService;
