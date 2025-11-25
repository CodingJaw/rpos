///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import {
  SUBSCRIPTION_DEFAULT_TTL_MS,
  createSubscriptionWithExpiration,
  getSubscription,
  purgeExpiredSubscriptions,
} from './eventing';

var utils = Utils.utils;

const ONVIF_ERROR_NS = 'http://www.onvif.org/ver10/error';
const PULL_DELIVERY_HINT = 'pull';

function createOnvifFault(subcode: string, reason: string) {
  return {
    Fault: {
      attributes: {
        'xmlns:ter': ONVIF_ERROR_NS,
      },
      Code: {
        Value: 'soap:Sender',
        Subcode: {
          Value: subcode,
        },
      },
      Reason: {
        Text: {
          attributes: {
            'xml:lang': 'en',
          },
          $value: reason,
        },
      },
    },
  };
}

function parseDurationMs(duration: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(duration);
  if (!match) {
    return undefined;
  }

  const days = parseFloat(match[1] || '0');
  const hours = parseFloat(match[2] || '0');
  const minutes = parseFloat(match[3] || '0');
  const seconds = parseFloat(match[4] || '0');

  return (
    days * 24 * 60 * 60 * 1000 +
    hours * 60 * 60 * 1000 +
    minutes * 60 * 1000 +
    seconds * 1000
  );
}

function extractText(value: any): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  return value._ ?? value.$value ?? value['#'] ?? value.toString?.();
}

function resolveExpiration(requestedTermination: any): number {
  const now = Date.now();
  const defaultExpiration = now + SUBSCRIPTION_DEFAULT_TTL_MS;

  const rawValue = extractText(requestedTermination);
  if (!rawValue) {
    return defaultExpiration;
  }

  const parsedDate = Date.parse(rawValue);
  if (!isNaN(parsedDate)) {
    if (parsedDate <= now) {
      throw createOnvifFault('ter:InvalidArgVal', 'InitialTerminationTime must be in the future');
    }
    return parsedDate;
  }

  const durationMs = parseDurationMs(rawValue);
  if (durationMs !== undefined) {
    if (durationMs <= 0) {
      throw createOnvifFault('ter:InvalidArgVal', 'InitialTerminationTime duration must be greater than zero');
    }
    return now + durationMs;
  }

  throw createOnvifFault('ter:InvalidArgVal', 'InitialTerminationTime is not a valid dateTime or duration');
}

function extractAddress(consumerReference: any): string | undefined {
  return (
    extractText(consumerReference?.Address) ||
    extractText(consumerReference?.['wsa5:Address']) ||
    extractText(consumerReference)
  );
}

function extractDeliveryMode(delivery: any): string | undefined {
  if (!delivery) {
    return undefined;
  }

  const attributes = delivery.$ || delivery.attributes;
  return extractText(delivery.Mode) || extractText(attributes?.Mode) || extractText(delivery);
}

function assertPullDeliverySupported(args: any) {
  const deliveryMode = extractDeliveryMode(args?.Delivery);
  if (deliveryMode && !deliveryMode.toLowerCase().includes(PULL_DELIVERY_HINT)) {
    throw createOnvifFault('ter:ActionNotSupported', 'Only PullPoint delivery is supported');
  }

  const consumerAddress = extractAddress(args?.ConsumerReference);
  if (consumerAddress && !consumerAddress.toLowerCase().includes(PULL_DELIVERY_HINT)) {
    throw createOnvifFault('ter:ActionNotSupported', 'Only PullPoint delivery is supported');
  }
}

function createSubscriptionForExpiration(expiration: number) {
  const adjustedExpiration = Math.max(expiration, Date.now() + 1);
  return createSubscriptionWithExpiration(adjustedExpiration);
}

class EventService extends SoapService {
  event_service: any;

  constructor(config: rposConfig, server: Server) {
    super(config, server);
    this.event_service = require('./stubs/events_service.js').EventService;

    this.serviceOptions = {
      path: '/onvif/events_service',
      services: this.event_service,
      xml: fs.readFileSync('./wsdl/events_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/events_service.wsdl',
      onReady: function () {
        utils.log.info('events_service started');
      },
    };

    this.extendService();
  }

  extendService() {
    var port = this.event_service.EventService.EventPort;

    port.CreatePullPointSubscription = (args: any) => {
      const expiration = resolveExpiration(args?.InitialTerminationTime);
      const { id, expiresAt } = createSubscriptionForExpiration(expiration);

      return {
        SubscriptionReference: {
          Address: id,
        },
        CurrentTime: new Date().toISOString(),
        TerminationTime: new Date(expiresAt).toISOString(),
      };
    };

    port.PullMessages = (args: any) => {
      purgeExpiredSubscriptions();

      const id =
        args &&
          args.SubscriptionReference &&
          (args.SubscriptionReference.Address || args.SubscriptionReference.Address?.['_']) ||
        args?.SubscriptionReference?.['_'];

      const sub = getSubscription(id);
      if (!sub) {
        throw new Error('Subscription not found or expired');
      }

      const messageLimit = args?.MessageLimit ? parseInt(args.MessageLimit, 10) : undefined;
      let notifications = sub.queue.splice(0, sub.queue.length);

      if (messageLimit && messageLimit > 0) {
        notifications = notifications.slice(0, messageLimit);
      }

      return {
        CurrentTime: new Date().toISOString(),
        TerminationTime: new Date(sub.expiresAt).toISOString(),
        NotificationMessage: notifications,
      };
    };

    port.GetEventProperties = (args: any) => {
      return {
        TopicSet: {
          'tns1:Device': {
            Device: {
              Trigger: {
                DigitalInput: {},
              },
            },
          },
          'tns1:RuleEngine': {
            MotionDetection: {},
          },
        },
      };
    };

    port.Subscribe = (args: any) => {
      purgeExpiredSubscriptions();

      assertPullDeliverySupported(args);

      const expiration = resolveExpiration(args?.InitialTerminationTime);
      const { id, expiresAt } = createSubscriptionForExpiration(expiration);

      return {
        SubscriptionReference: {
          Address: id,
        },
        CurrentTime: new Date().toISOString(),
        TerminationTime: new Date(expiresAt).toISOString(),
      };
    };
  }
}

export = EventService;
