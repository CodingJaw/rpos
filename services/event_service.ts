///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import {
  SUBSCRIPTION_DEFAULT_TTL_MS,
  SubscriptionDeliveryMode,
  createSubscriptionWithExpiration,
  findSubscription,
  getSubscription,
  isSubscriptionExpired,
  renewSubscriptionExpiration,
  purgeExpiredSubscriptions,
  deleteSubscription,
  waitForMessages,
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

function resolveDeliveryMode(args: any): { mode: SubscriptionDeliveryMode; consumerAddress?: string } {
  const deliveryMode = extractDeliveryMode(args?.Delivery)?.toLowerCase();
  const consumerAddress = extractAddress(args?.ConsumerReference);

  const requestsPull = deliveryMode ? deliveryMode.includes(PULL_DELIVERY_HINT) : false;
  const requestsPush = deliveryMode ? deliveryMode.includes('push') || deliveryMode.includes('http') : false;

  let mode: SubscriptionDeliveryMode = 'pull';

  if (requestsPull) {
    mode = 'pull';
  } else if (requestsPush || consumerAddress) {
    mode = 'push';
  }

  if (mode === 'push' && !consumerAddress) {
    throw createOnvifFault('ter:InvalidArgVal', 'ConsumerReference is required for push subscriptions');
  }

  return { mode, consumerAddress };
}

function createSubscriptionForExpiration(expiration: number, mode: SubscriptionDeliveryMode, consumerAddress?: string) {
  const adjustedExpiration = Math.max(expiration, Date.now() + 1);
  return createSubscriptionWithExpiration(adjustedExpiration, mode, consumerAddress);
}

function buildEndpointReference(subscriptionId: string, serviceUrl: string) {
  return {
    attributes: {
      'xmlns:wsa5': 'http://www.w3.org/2005/08/addressing',
    },
    'wsa5:Address': serviceUrl,
    'wsa5:ReferenceParameters': {
      'wsa5:SubscriptionId': subscriptionId,
    },
  };
}

function extractSubscriptionId(reference: any): string | undefined {
  const refParams = reference?.['wsa5:ReferenceParameters'] ?? reference?.ReferenceParameters;

  return (
    extractText(refParams?.['wsa5:SubscriptionId']) ||
    extractText(refParams?.SubscriptionId) ||
    extractText(reference?.['wsa5:SubscriptionId']) ||
    extractText(reference?.SubscriptionId) ||
    extractText(reference?.Address) ||
    extractText(reference?.['wsa5:Address']) ||
    extractText(reference)
  );
}

function resolveSubscriptionId(args: any, headers?: any) {
  return (
    extractSubscriptionId(headers) ||
    extractSubscriptionId(args?.SubscriptionReference) ||
    extractSubscriptionId(args)
  );
}

function resolveTimeoutMs(rawTimeout: any) {
  if (rawTimeout === undefined || rawTimeout === null) {
    return 0;
  }

  const timeoutText = extractText(rawTimeout);
  if (!timeoutText) {
    return 0;
  }

  const timeoutMs = parseDurationMs(timeoutText);
  if (timeoutMs === undefined || timeoutMs < 0) {
    throw createOnvifFault('ter:InvalidArgVal', 'Timeout is not a valid duration');
  }

  return timeoutMs;
}

function resolveMessageLimit(rawLimit: any): number | undefined {
  if (rawLimit === undefined || rawLimit === null) {
    return undefined;
  }

  const parsed = parseInt(extractText(rawLimit) || '', 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw createOnvifFault('ter:InvalidArgVal', 'MessageLimit must be a positive integer');
  }

  return parsed;
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
    const serviceUrl = `http://${utils.getIpAddress()}:${this.config.ServicePort}${this.serviceOptions.path}`;

    port.CreatePullPointSubscription = (args: any) => {
      const expiration = resolveExpiration(args?.InitialTerminationTime);
      const { id, expiresAt } = createSubscriptionForExpiration(expiration, 'pull');

      const subscriptionReference = buildEndpointReference(id, serviceUrl);

      return {
        SubscriptionReference: subscriptionReference,
        CurrentTime: new Date().toISOString(),
        TerminationTime: new Date(expiresAt).toISOString(),
      };
    };

    port.PullMessages = (args: any, callback: (result: any) => void, headers?: any) => {
      const respond = (result: any) => {
        if (typeof callback === 'function') {
          callback(result);
        }
        return result;
      };

      const send = async () => {
        purgeExpiredSubscriptions();

        const subscriptionId = resolveSubscriptionId(args, headers);
        if (!subscriptionId) {
          throw createOnvifFault('ter:InvalidArgVal', 'SubscriptionReference is required');
        }

        const existingSubscription = findSubscription(subscriptionId);
        if (!existingSubscription) {
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription not found');
        }

        if (isSubscriptionExpired(existingSubscription)) {
          purgeExpiredSubscriptions();
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription has expired');
        }

        if (existingSubscription.mode === 'push') {
          throw createOnvifFault('ter:ActionNotSupported', 'PullMessages is not supported for push subscriptions');
        }

        const timeoutMs = resolveTimeoutMs(args?.Timeout);
        const messageLimit = resolveMessageLimit(args?.MessageLimit);

        const waitMs = Math.min(timeoutMs, Math.max(0, existingSubscription.expiresAt - Date.now()));
        const notifications = await waitForMessages(subscriptionId, waitMs, messageLimit);

        const activeSubscription = getSubscription(subscriptionId);
        if (!activeSubscription) {
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription has expired');
        }

        return {
          CurrentTime: new Date().toISOString(),
          TerminationTime: new Date(activeSubscription.expiresAt).toISOString(),
          NotificationMessage: notifications || [],
        };
      };

      return send().then(respond).catch((err) => {
        if (typeof callback === 'function') {
          callback(err);
          return;
        }
        throw err;
      });
    };

    port.Renew = (args: any, callback: (result: any) => void, headers?: any) => {
      const respond = (result: any) => {
        if (typeof callback === 'function') {
          callback(result);
        }
        return result;
      };

      const send = async () => {
        purgeExpiredSubscriptions();

        const subscriptionId = resolveSubscriptionId(args, headers);
        if (!subscriptionId) {
          throw createOnvifFault('ter:InvalidArgVal', 'SubscriptionReference is required');
        }

        const existingSubscription = findSubscription(subscriptionId);
        if (!existingSubscription) {
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription not found');
        }

        if (isSubscriptionExpired(existingSubscription)) {
          purgeExpiredSubscriptions();
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription has expired');
        }

        const requestedExpiration = resolveExpiration(args?.TerminationTime);
        const updated = renewSubscriptionExpiration(
          subscriptionId,
          Math.max(requestedExpiration, Date.now() + 1),
        );

        if (!updated) {
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription not found');
        }

        return {
          CurrentTime: new Date().toISOString(),
          TerminationTime: new Date(updated.expiresAt).toISOString(),
        };
      };

      return send().then(respond).catch((err) => {
        if (typeof callback === 'function') {
          callback(err);
          return;
        }
        throw err;
      });
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

      const { mode, consumerAddress } = resolveDeliveryMode(args);

      const expiration = resolveExpiration(args?.InitialTerminationTime);
      const { id, expiresAt } = createSubscriptionForExpiration(expiration, mode, consumerAddress);

      const subscriptionReference = buildEndpointReference(id, serviceUrl);

      return {
        SubscriptionReference: subscriptionReference,
        CurrentTime: new Date().toISOString(),
        TerminationTime: new Date(expiresAt).toISOString(),
      };
    };

    port.Unsubscribe = (args: any, callback: (result: any) => void, headers?: any) => {
      const respond = (result: any) => {
        if (typeof callback === 'function') {
          callback(result);
        }
        return result;
      };

      const send = async () => {
        purgeExpiredSubscriptions();

        const subscriptionId = resolveSubscriptionId(args, headers);
        if (!subscriptionId) {
          throw createOnvifFault('ter:InvalidArgVal', 'SubscriptionReference is required');
        }

        const existingSubscription = findSubscription(subscriptionId);
        if (!existingSubscription) {
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription not found');
        }

        if (isSubscriptionExpired(existingSubscription)) {
          purgeExpiredSubscriptions();
          throw createOnvifFault('ter:InvalidArgVal', 'Subscription has expired');
        }

        deleteSubscription(subscriptionId);
        return {};
      };

      return send().then(respond).catch((err) => {
        if (typeof callback === 'function') {
          callback(err);
          return;
        }
        throw err;
      });
    };
  }
}

export = EventService;
