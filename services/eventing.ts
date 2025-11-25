import { Utils } from '../lib/utils';

const utils = Utils.utils;

export const SUBSCRIPTION_DEFAULT_TTL_MS = 10000;

export type SubscriptionState = {
  expiresAt: number;
  queue: any[];
};

export const activeSubscriptions = new Map<string, SubscriptionState>();

export function createSubscriptionWithExpiration(expiresAt: number) {
  const id = 'sub-' + Date.now();
  activeSubscriptions.set(id, { expiresAt, queue: [] });
  return { id, expiresAt };
}

export function createSubscription(ttlMs: number = SUBSCRIPTION_DEFAULT_TTL_MS) {
  return createSubscriptionWithExpiration(Date.now() + ttlMs);
}

export function getSubscription(id: string | undefined) {
  if (!id) {
    return undefined;
  }
  const sub = activeSubscriptions.get(id);
  if (!sub) {
    return undefined;
  }
  if (Date.now() > sub.expiresAt) {
    activeSubscriptions.delete(id);
    return undefined;
  }
  return sub;
}

export function purgeExpiredSubscriptions() {
  const now = Date.now();
  activeSubscriptions.forEach((sub, id) => {
    if (now > sub.expiresAt) {
      activeSubscriptions.delete(id);
    }
  });
}

export function pushInputAlarmEvent(channel: string | number, state: string | boolean) {
  purgeExpiredSubscriptions();

  const value = state === true || state === 'true' || state === 'active' ? 'true' : 'false';

  const topic = {
    _: 'tns1:Device/Trigger/DigitalInput',
    '$': {
      Dialect: 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet'
    }
  };

  const message = {
    'tt:Message': {
      Source: {
        'tt:SimpleItem': [
          {
            '$': {
              Name: 'InputToken',
              Value: String(channel)
            }
          }
        ]
      },
      Data: {
        'tt:SimpleItem': [
          {
            '$': {
              Name: 'LogicalState',
              Value: value
            }
          }
        ]
      }
    }
  };

  const notification = {
    Topic: topic,
    Message: message
  };

  activeSubscriptions.forEach((sub, id) => {
    if (Date.now() > sub.expiresAt) {
      activeSubscriptions.delete(id);
      return;
    }
    utils.log.debug('Queueing input event for subscription %s', id);
    sub.queue.push(notification);
  });
}
