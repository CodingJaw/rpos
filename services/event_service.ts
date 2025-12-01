///<reference path="../rpos.d.ts" />

import fs = require("fs");
import { URL } from "url";
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import crypto = require('crypto');

const utils = Utils.utils;

const NAMESPACE = 'http://www.onvif.org/ver10/events/wsdl';
const PATH = '/onvif/events_service';

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

  constructor(config: rposConfig, server: Server) {
    super(config, server);

    this.event_service = require('./stubs/event_service.js').EventService;

    this.serviceOptions = {
      path: EventService.path,
      services: this.event_service,
      xml: fs.readFileSync('./wsdl/onvif/wsdl/event.wsdl', 'utf8'),
      uri: 'wsdl/onvif/wsdl/event.wsdl',
      callback: () => console.log('event_service started')
    };

    this.extendService();
  }

  static get path() {
    return PATH;
  }

  static get namespace() {
    return NAMESPACE;
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
      TopicSet: {},
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
