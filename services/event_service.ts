///<reference path="../rpos.d.ts" />

import fs = require("fs");
import { URL } from "url";
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import crypto = require('crypto');
import { IOState } from '../lib/io_state';

const utils = Utils.utils;

const NAMESPACE = 'http://www.onvif.org/ver10/events/wsdl';
const PATH = '/onvif/event_service';
const DEFINITIONS_CLOSE_TAG = '</wsdl:definitions>';

interface SubscriptionRecord {
  reference: string;
  createdAt: Date;
  terminationTime: Date;
  filters?: any;
  notifications: NotificationRecord[];
  cursor: number;
}

interface NotificationRecord {
  timestamp: Date;
  message: any;
}

class EventService extends SoapService {
  static registry: Map<string, SubscriptionRecord> = new Map();
  event_service: any;
  ioState: IOState;
  private warnedNoSubscribers = false;
  private pendingNotifications: NotificationRecord[] = [];

  constructor(config: rposConfig, server: Server, ioState: IOState) {
    super(config, server);

    this.event_service = require('./stubs/event_service.js').EventService;
    this.ioState = ioState;

        this.serviceOptions = {
      path: EventService.path,
      services: this.event_service,
      xml: this.buildWsdlWithService(
        './wsdl/onvif/wsdl/event.wsdl',
        `\n  <wsdl:service name="EventService">\n` +
        `    <wsdl:port name="EventPort" binding="tev:EventBinding">\n` +
        `      <soap:address location="${this.serviceAddress()}" />\n` +
        `    </wsdl:port>\n` +
        `    <wsdl:port name="PullPointSubscription" binding="tev:PullPointSubscriptionBinding">\n` +
        `      <soap:address location="${this.serviceAddress()}" />\n` +
        `    </wsdl:port>\n` +
        `    <wsdl:port name="SubscriptionManager" binding="tev:SubscriptionManagerBinding">\n` +
        `      <soap:address location="${this.serviceAddress()}" />\n` +
        `    </wsdl:port>\n` +
        `    <wsdl:port name="NotificationProducer" binding="tev:NotificationProducerBinding">\n` +
        `      <soap:address location="${this.serviceAddress()}" />\n` +
        `    </wsdl:port>\n` +
        `  </wsdl:service>\n`
      ),
      uri: 'wsdl/onvif/wsdl/event.wsdl',
      callback: () => console.log('event_service started')
    };

    this.extendService();
    this.ensureAutoSubscription();
  }

  static get path() {
    return PATH;
  }

  static get namespace() {
    return NAMESPACE;
  }

  private serviceAddress() {
    return `http://${utils.getIpAddress()}:${this.config.ServicePort}${EventService.path}`;
  }

  private buildWsdlWithService(basePath: string, serviceXml: string) {
    const baseWsdl = fs.readFileSync(basePath, 'utf8');
    const insertAt = baseWsdl.lastIndexOf(DEFINITIONS_CLOSE_TAG);

    if (insertAt === -1) {
      throw new Error(`Invalid WSDL: missing ${DEFINITIONS_CLOSE_TAG} in ${basePath}`);
    }

    return baseWsdl.slice(0, insertAt) + serviceXml + DEFINITIONS_CLOSE_TAG;
  }

  extendService() {
    const service = this.event_service.EventService;
    const eventPort = service.EventPort;
    const pullPoint = service.PullPointSubscription;
    const subscriptionManager = service.SubscriptionManager;
    const notificationProducer = service.NotificationProducer;

    eventPort.GetServiceCapabilities = () => ({
      Capabilities: {
        attributes: {
          WSSubscriptionPolicySupport: false,
          WSPullPointSupport: true,
          WSPausableSubscriptionManagerInterfaceSupport: false,
          MaxNotificationProducers: 1,
          MaxPullPoints: 1,
          PersistentNotificationStorage: false,
          EventBrokerProtocols: '',
          MaxEventBrokers: 0
        }
      }
    });

    eventPort.CreatePullPointSubscription = (args /*, cb, headers*/ ) => {
      const { response } = this.registerSubscription(args?.Filter, args?.InitialTerminationTime);
      return response;
    };

    eventPort.GetEventProperties = () => ({
      TopicNamespaceLocation: [],
      FixedTopicSet: true,
      TopicSet: {
        attributes: {
          'xmlns:tns1': 'http://www.onvif.org/ver10/topics'
        },
        'tns1:Device': {
          'tns1:IO': {
            'tns1:DigitalInput': {},
            'tns1:RelayOutput': {}
          }
        }
      },
      TopicExpressionDialect: [
        'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete'
      ],
      MessageContentFilterDialect: [],
      ProducerPropertiesFilterDialect: [],
      MessageContentSchemaLocation: []
    });

    eventPort.AddEventBroker = () => ({ });
    eventPort.DeleteEventBroker = () => ({ });
    eventPort.GetEventBrokers = () => ({ EventBroker: [] });

    const pullMessages = (args: any, _cb: any, headers: any, req: any) => {
      const subscription = this.getSubscription(args, headers, req);

      const limit = Math.max(0, args?.MessageLimit || 0);
      const available = subscription.notifications.length - subscription.cursor;
      const count = limit > 0 ? Math.min(limit, available) : available;

      const messages = subscription.notifications
        .slice(subscription.cursor, subscription.cursor + count)
        .map((entry) => entry.message);

      subscription.cursor += count;

      if (subscription.cursor > 50) {
        subscription.notifications = subscription.notifications.slice(subscription.cursor);
        subscription.cursor = 0;
      }

      return {
        CurrentTime: new Date().toISOString(),
        TerminationTime: subscription.terminationTime.toISOString(),
        NotificationMessage: messages
      };
    };

    pullPoint.PullMessages = pullMessages;
    eventPort.PullMessages = pullMessages;

    const seek = (args: any, _cb: any, headers: any, req: any) => {
      const subscription = this.getSubscription(args, headers, req);
      const targetTime = args?.UtcTime ? new Date(args.UtcTime) : null;
      if (targetTime && !isNaN(targetTime.getTime())) {
        subscription.cursor = subscription.notifications.findIndex((entry) => entry.timestamp >= targetTime);
        if (subscription.cursor === -1) {
          subscription.cursor = subscription.notifications.length;
        }
      }
      return {};
    };

    pullPoint.Seek = seek;
    eventPort.Seek = seek;

    const setSyncPoint = (args: any, _cb: any, headers: any, req: any) => {
      const subscription = this.getSubscription(args, headers, req);
      subscription.cursor = subscription.notifications.length;
      return {};
    };

    pullPoint.SetSynchronizationPoint = setSyncPoint;
    eventPort.SetSynchronizationPoint = setSyncPoint;

    const unsubscribe = (args: any, _cb: any, headers: any, req: any) => {
      const subscription = this.getSubscription(args, headers, req);
      EventService.registry.delete(subscription.reference);
      return {};
    };

    pullPoint.Unsubscribe = unsubscribe;
    eventPort.Unsubscribe = unsubscribe;

    subscriptionManager.Renew = (args: any, _cb: any, headers: any, req: any) => {
      const subscription = this.getSubscription(args, headers, req);
      const nextTermination = this.resolveTermination(args?.TerminationTime, new Date());
      subscription.terminationTime = nextTermination;
      return { TerminationTime: nextTermination.toISOString() };
    };

    subscriptionManager.Unsubscribe = unsubscribe;

    notificationProducer.Subscribe = (args: any /*, cb, headers*/ ) => {
      const { response } = this.registerSubscription(args?.Filter, args?.InitialTerminationTime);
      return response;
    };
  }

  pushIOEvent(type: 'input' | 'output', index: number, value: boolean) {
    const topicBase = type === 'input' ? 'DigitalInput' : 'RelayOutput';
    const topic = `tns1:Device/IO/${topicBase}/${index}`;

    const message = {
      'wsnt:NotificationMessage': {
        'wsnt:Topic': {
          attributes: {
            Dialect: 'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete'
          },
          $value: topic
        },
        'wsnt:Message': {
          'tt:Message': {
            'tt:Data': {
              'tt:SimpleItem': {
                attributes: {
                  Name: 'State',
                  Value: value.toString()
                }
              }
            }
          }
        }
      }
    };

    if (EventService.registry.size === 0) {
      if (!this.warnedNoSubscribers) {
        utils.log.warn('IO event raised without any subscriptions; buffering until a consumer subscribes.');
        this.warnedNoSubscribers = true;
      }
      this.bufferNotification(message);
      return;
    }

    let delivered = false;
    for (const subscription of EventService.registry.values()) {
      if (this.subscriptionMatchesTopic(subscription, topic)) {
        subscription.notifications.push({ timestamp: new Date(), message });
        delivered = true;
      }
    }

    if (!delivered) {
      this.bufferNotification(message, topic);
    }
  }

  queueNotification(reference: string, message: any, timestamp?: Date) {
    const subscription = EventService.registry.get(reference);
    if (!subscription) {
      throw this.resourceUnknownFault(reference);
    }
    subscription.notifications.push({ timestamp: timestamp || new Date(), message });
  }

  private generateSubscriptionReference() {
    const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    return `http://${utils.getIpAddress()}:${this.config.ServicePort}${EventService.path}?subscription=${id}`;
  }

  private resolveTermination(termination: any, fallback: Date) {
    if (!termination) {
      return new Date(fallback.getTime() + 60 * 60 * 1000);
    }
    const parsed = new Date(termination);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
    return new Date(fallback.getTime() + 60 * 60 * 1000);
  }

  private getSubscription(args: any, headers: any, req: any): SubscriptionRecord {
    const reference = this.getSubscriptionReference(args, headers, req);
    if (!reference) {
      throw this.resourceUnknownFault('');
    }
    const subscription = EventService.registry.get(reference);
    if (!subscription) {
      throw this.resourceUnknownFault(reference);
    }
    return subscription;
  }

  private registerSubscription(filters: any, terminationTime: any, reference?: string) {
    const now = new Date();
    const termination = this.resolveTermination(terminationTime, now);
    const ref = reference || this.generateSubscriptionReference();

    const subscription: SubscriptionRecord = {
      reference: ref,
      createdAt: now,
      terminationTime: termination,
      filters,
      notifications: [],
      cursor: 0
    };

    EventService.registry.set(ref, subscription);

    this.flushPendingNotifications(subscription);

    return {
      subscription,
      response: {
        SubscriptionReference: {
          Address: ref
        },
        CurrentTime: now.toISOString(),
        TerminationTime: termination.toISOString()
      }
    };
  }

  private subscriptionMatchesTopic(subscription: SubscriptionRecord, topic: string): boolean {
    const filters = subscription.filters;
    if (!filters) return true;

    const expressions: any[] = [];
    if (filters.TopicExpression) {
      if (Array.isArray(filters.TopicExpression)) {
        expressions.push(...filters.TopicExpression);
      } else {
        expressions.push(filters.TopicExpression);
      }
    }
    if (filters['wstop:TopicExpression']) {
      const value = filters['wstop:TopicExpression'];
      if (Array.isArray(value)) {
        expressions.push(...value);
      } else {
        expressions.push(value);
      }
    }

    if (expressions.length === 0) return true;

    return expressions.some((expr) => {
      const dialect = expr?.attributes?.Dialect || expr?.Dialect;
      if (dialect && dialect !== 'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete') {
        return false;
      }
      const value = typeof expr === 'string' ? expr : expr?.$value || expr?._ || expr?.['#'] || expr;
      if (typeof value !== 'string') return false;
      return value.trim() === topic.trim();
    });
  }

  private ensureAutoSubscription() {
    if (this.config.AutoSubscribeIOEvents === false) {
      utils.log.warn('Auto-subscription for IO events is disabled; ONVIF clients must create their own subscriptions.');
      return;
    }

    const reference = `${this.serviceAddress()}?subscription=auto`;
    this.registerSubscription(undefined, new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), reference);
    utils.log.info('Created default IO event subscription at %s', reference);
  }

  private bufferNotification(message: any, topic?: string) {
    const record = { timestamp: new Date(), message } as NotificationRecord;
    this.pendingNotifications.push(record);
    if (this.pendingNotifications.length > 100) {
      this.pendingNotifications.shift();
    }

    if (topic) {
      utils.log.debug('Buffered IO notification for topic %s until a subscription is available.', topic);
    }
  }

  private flushPendingNotifications(subscription: SubscriptionRecord) {
    if (this.pendingNotifications.length === 0) return;

    const remaining: NotificationRecord[] = [];
    for (const entry of this.pendingNotifications) {
      const topic = entry.message?.['wsnt:NotificationMessage']?.['wsnt:Topic']?.$value;
      if (!topic || this.subscriptionMatchesTopic(subscription, topic)) {
        subscription.notifications.push(entry);
      } else {
        remaining.push(entry);
      }
    }

    this.pendingNotifications = remaining;
  }

  private getSubscriptionReference(args: any, headers: any, req: any): string | undefined {
    const candidates: (string | undefined)[] = [];
    candidates.push(args?.SubscriptionReference?.Address || args?.SubscriptionReference);
    candidates.push(headers?.To || headers?.wsa__To);
    if (req?.url && req?.headers?.host) {
      candidates.push(`http://${req.headers.host}${req.url}`);
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      const normalized = this.normalizeReference(candidate);
      if (EventService.registry.has(normalized)) {
        return normalized;
      }
    }
    return undefined;
  }

  private normalizeReference(reference: string): string {
    try {
      const url = new URL(reference, `http://${utils.getIpAddress()}:${this.config.ServicePort}`);
      return url.toString();
    } catch (err) {
      return reference;
    }
  }

  private resourceUnknownFault(reference: string) {
    return {
      Fault: {
        Code: {
          Value: 'soap:Sender'
        },
        Reason: {
          Text: {
            attributes: {
              'xml:lang': 'en'
            },
            $value: `Unknown subscription reference ${reference}`
          }
        }
      }
    };
  }
}

export = EventService;
