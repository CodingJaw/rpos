///<reference path="../rpos.d.ts" />

import fs = require("fs");
import { URL } from "url";
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import crypto = require('crypto');

const utils = Utils.utils;

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

  extendService() {
    const port = this.event_service.EventService.EventPort;

    port.CreatePullPointSubscription = (args /*, cb, headers*/ ) => {
      const now = new Date();
      const termination = this.resolveTermination(args?.InitialTerminationTime, now);
      const reference = this.generateSubscriptionReference();

      const subscription: SubscriptionRecord = {
        reference,
        createdAt: now,
        terminationTime: termination,
        filters: args?.Filter,
        notifications: [],
        cursor: 0
      };

      EventService.registry.set(reference, subscription);

      return {
        SubscriptionReference: {
          Address: reference
        },
        CurrentTime: now.toISOString(),
        TerminationTime: termination.toISOString()
      };
    };

    port.PullMessages = (args, _cb, _headers, req) => {
      const subscription = this.getSubscription(args, _headers, req);

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

    port.Seek = (args, _cb, _headers, req) => {
      const subscription = this.getSubscription(args, _headers, req);
      const targetTime = args?.UtcTime ? new Date(args.UtcTime) : null;
      if (targetTime && !isNaN(targetTime.getTime())) {
        subscription.cursor = subscription.notifications.findIndex((entry) => entry.timestamp >= targetTime);
        if (subscription.cursor === -1) {
          subscription.cursor = subscription.notifications.length;
        }
      }
      return {};
    };

    port.SetSynchronizationPoint = (args, _cb, _headers, req) => {
      const subscription = this.getSubscription(args, _headers, req);
      subscription.cursor = subscription.notifications.length;
      return {};
    };

    port.Unsubscribe = (args, _cb, _headers, req) => {
      const subscription = this.getSubscription(args, _headers, req);
      EventService.registry.delete(subscription.reference);
      return {};
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
