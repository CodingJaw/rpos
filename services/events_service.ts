///<reference path="../rpos.d.ts" />

import fs = require('fs');
import { EventEmitter } from 'events';
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import crypto = require('crypto');

const utils = Utils.utils;

type EventQueueEntry = {
  id: string;
  topic: string;
  utcTime: string;
  operation: string;
  source?: { Name: string; Value: string };
  data?: { Name: string; Value: string };
  addedAt: number;
};

type SubscriptionRecord = {
  id: string;
  terminationTime: Date;
  queue: EventQueueEntry[];
};

class EventsService extends SoapService {
  event_service: any;
  subscriptions: Map<string, SubscriptionRecord>;
  bus: EventEmitter;
  retentionMs: number;
  pollTimeoutMs: number;

  constructor(config: rposConfig, server: Server) {
    super(config, server);

    this.event_service = require('./stubs/events_service.js').EventService;
    this.subscriptions = new Map();
    this.bus = new EventEmitter();

    this.retentionMs = (config.EventRetentionTimeSeconds ?? 30) * 1000;
    this.pollTimeoutMs = (config.EventPollingTimeoutSeconds ?? 5) * 1000;

    this.serviceOptions = {
      path: '/onvif/events_service',
      services: this.event_service,
      xml: fs.readFileSync('./wsdl/events_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/events_service.wsdl',
      onReady: () => utils.log.info('events_service started'),
    };

    this.extendService();
  }

  extendService() {
    const port = this.event_service.EventService.EventPort;

    port.GetServiceCapabilities = () => {
      return {
        Capabilities: {
          attributes: {
            WSSubscriptionPolicySupport: true,
            WSPullPointSupport: true,
            WSPausableSubscriptionManagerInterfaceSupport: false,
          },
        },
      };
    };

    port.CreatePullPointSubscription = (args) => {
      const subscriptionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const terminationTime = this.computeTermination(args?.InitialTerminationTime);
      const record: SubscriptionRecord = {
        id: subscriptionId,
        terminationTime,
        queue: [],
      };
      this.subscriptions.set(subscriptionId, record);
      this.queueNotification(subscriptionId, {
        topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
        operation: 'Initialized',
        utcTime: new Date().toISOString(),
        data: { Name: 'State', Value: 'true' },
        addedAt: Date.now(),
        id: subscriptionId,
      });

      const address = `http://${utils.getIpAddress()}:${this.config.ServicePort}${this.serviceOptions.path}`;

      return {
        SubscriptionReference: {
          Address: address,
          ReferenceParameters: {
            SubscriptionId: subscriptionId,
          },
        },
        CurrentTime: new Date().toISOString(),
        TerminationTime: terminationTime.toISOString(),
      };
    };

    port.PullMessages = (args, cb) => {
      const subscription = this.findSubscription(args?.SubscriptionId);
      if (!subscription) {
        const fault = new Error('Subscription not found');
        return cb ? cb(fault) : fault;
      }

      const timeoutMs = this.parseDuration(args?.Timeout, this.pollTimeoutMs);
      const limit = typeof args?.MessageLimit === 'number' ? args.MessageLimit : 10;

      this.drainWithWait(subscription, limit, timeoutMs)
        .then((messages) => {
          const response = {
            CurrentTime: new Date().toISOString(),
            TerminationTime: subscription.terminationTime.toISOString(),
            NotificationMessage: messages,
          };
          if (cb) return cb(response);
          return response;
        })
        .catch((err) => {
          utils.log.warn('PullMessages failed: %s', err?.message || err);
          if (cb) return cb(err);
          throw err;
        });
    };

    port.Renew = (args) => {
      const subscription = this.findSubscription(args?.SubscriptionId);
      if (!subscription) {
        return new Error('Subscription not found');
      }
      subscription.terminationTime = this.computeTermination(args?.TerminationTime);
      return {
        TerminationTime: subscription.terminationTime.toISOString(),
        CurrentTime: new Date().toISOString(),
      };
    };

    port.Unsubscribe = (args) => {
      const subscription = this.findSubscription(args?.SubscriptionId);
      if (subscription) {
        this.subscriptions.delete(subscription.id);
      }
      return {};
    };

    this.bus.on('notification', (event) => {
      for (const subscription of this.subscriptions.values()) {
        this.queueNotification(subscription.id, event);
      }
    });
  }

  computeTermination(duration?: string): Date {
    const now = Date.now();
    const extensionMs = this.parseDuration(duration, 12 * 60 * 60 * 1000);
    return new Date(now + extensionMs);
  }

  findSubscription(subscriptionId?: string): SubscriptionRecord | undefined {
    if (subscriptionId && this.subscriptions.has(subscriptionId)) {
      return this.subscriptions.get(subscriptionId);
    }
    return this.subscriptions.values().next().value;
  }

  parseDuration(duration: any, defaultMs: number): number {
    if (typeof duration === 'number') return duration;
    if (typeof duration === 'string') {
      const regex = /P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
      const match = duration.match(regex);
      if (match) {
        const hours = parseInt(match[1] || '0', 10);
        const minutes = parseInt(match[2] || '0', 10);
        const seconds = parseFloat(match[3] || '0');
        return ((hours * 60 + minutes) * 60 + seconds) * 1000;
      }
    }
    return defaultMs;
  }

  queueNotification(subscriptionId: string, event: EventQueueEntry) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    const now = Date.now();
    subscription.queue.push({ ...event, addedAt: event.addedAt ?? now });
    subscription.queue = subscription.queue.filter((item) => now - item.addedAt <= this.retentionMs);
    this.bus.emit(`notify:${subscriptionId}`);
  }

  async drainWithWait(subscription: SubscriptionRecord, limit: number, timeoutMs: number) {
    const tryDrain = () => {
      const now = Date.now();
      subscription.queue = subscription.queue.filter((item) => now - item.addedAt <= this.retentionMs);
      const sliced = subscription.queue.splice(0, Math.max(1, limit));
      return sliced.map((evt) => this.toNotification(evt));
    };

    const initial = tryDrain();
    if (initial.length > 0 || timeoutMs <= 0) return initial;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.bus.removeListener(`notify:${subscription.id}`, handler);
        resolve(tryDrain());
      }, timeoutMs);
      const handler = () => {
        const drained = tryDrain();
        if (drained.length > 0) {
          clearTimeout(timer);
          this.bus.removeListener(`notify:${subscription.id}`, handler);
          resolve(drained);
        }
      };
      this.bus.on(`notify:${subscription.id}`, handler);
    });
  }

  toNotification(event: EventQueueEntry) {
    return {
      Topic: {
        attributes: {
          Dialect: 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet',
        },
        $value: event.topic,
      },
      Message: {
        'tt:Message': {
          attributes: {
            UtcTime: event.utcTime,
            PropertyOperation: event.operation,
          },
          Source: event.source
            ? { SimpleItem: { attributes: { Name: event.source.Name, Value: event.source.Value } } }
            : undefined,
          Data: event.data
            ? { SimpleItem: { attributes: { Name: event.data.Name, Value: event.data.Value } } }
            : undefined,
        },
      },
    };
  }
}

export = EventsService;
