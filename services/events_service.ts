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

class EventsService extends SoapService {
  private subscriptions: Map<string, PullPointSubscription> = new Map();
  private defaultTerminationSeconds = 15 * 60; // 15 minutes
  private motionState: boolean | null = null;
  private alarmState: boolean | null = null;
  private alarmInputPath?: string;
  private alarmInputPollInterval: number = 200;
  private alarmInputDebounceMs: number = 200;
  private alarmInputActiveHigh: boolean = true;
  private pendingAlarmState: boolean | null = null;
  private alarmPollTimer?: NodeJS.Timeout;
  private alarmDebounceTimer?: NodeJS.Timeout;

  constructor(config: rposConfig, server: Server) {
    super(config, server);

    this.serviceOptions = {
      path: '/onvif/events_service',
      services: this.buildServiceDefinition(),
      xml: fs.readFileSync('./wsdl/event_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/event_service.wsdl',
      onReady: () => utils.log.info('events_service started')
    };

    this.configureAlarmInput(config);
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

  public publishAlarmState(isActive: boolean) {
    if (this.alarmState === isActive) return;
    this.alarmState = isActive;
    this.broadcastNotification(this.createSimpleNotification(
      'tns1:Device/Trigger/DigitalInput',
      'IsActive',
      isActive
    ));
  }

  public getMotionCallback(): (state: boolean) => void {
    return (state: boolean) => this.publishMotionState(state);
  }

  public getAlarmCallback(): (state: boolean) => void {
    return (state: boolean) => this.publishAlarmState(state);
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
      console.log(`EventsService - Unable to read alarm input at ${this.alarmInputPath}`);
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
      this.publishAlarmState(sample);
    }, this.alarmInputDebounceMs);
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
      if (this.alarmState !== null) {
        this.enqueueInitialState(id, this.createSimpleNotification('tns1:Device/Trigger/DigitalInput', 'IsActive', this.alarmState));
      }

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

  private createSimpleNotification(topic: string, stateName: string, isActive: boolean): NotificationMessage {
    const now = new Date().toISOString();
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
          Source: {},
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
