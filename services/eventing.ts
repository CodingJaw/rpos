import { Utils } from '../lib/utils';

const utils = Utils.utils;

export const SUBSCRIPTION_DEFAULT_TTL_MS = 10000;

export type PendingPull = {
  messageLimit?: number;
  resolve: (messages: any[]) => void;
};

export type SubscriptionState = {
  expiresAt: number;
  queue: any[];
  waiters: PendingPull[];
};

export const activeSubscriptions = new Map<string, SubscriptionState>();

export function createSubscriptionWithExpiration(expiresAt: number) {
  const id = 'sub-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  activeSubscriptions.set(id, { expiresAt, queue: [], waiters: [] });
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

export function findSubscription(id: string | undefined) {
  if (!id) {
    return undefined;
  }
  return activeSubscriptions.get(id);
}

export function isSubscriptionExpired(sub: SubscriptionState | undefined) {
  if (!sub) return true;
  return Date.now() > sub.expiresAt;
}

function takeMessages(sub: SubscriptionState, messageLimit?: number) {
  const limit = messageLimit && messageLimit > 0 ? messageLimit : sub.queue.length;
  return sub.queue.splice(0, limit);
}

function notifyWaiters(sub: SubscriptionState) {
  while (sub.queue.length > 0 && sub.waiters.length > 0) {
    const waiter = sub.waiters.shift();
    if (!waiter) break;
    waiter.resolve(takeMessages(sub, waiter.messageLimit));
  }
}

export function waitForMessages(
  id: string,
  timeoutMs: number,
  messageLimit?: number,
): Promise<any[] | undefined> | undefined {
  const sub = getSubscription(id);
  if (!sub) {
    return undefined;
  }

  const initial = takeMessages(sub, messageLimit);
  if (initial.length > 0 || timeoutMs <= 0) {
    return Promise.resolve(initial);
  }

  return new Promise((resolve) => {
    const waiter: PendingPull = {
      messageLimit,
      resolve: (messages: any[]) => {
        clearTimeout(timer);
        resolve(messages);
      },
    };

    const timer = setTimeout(() => {
      const idx = sub.waiters.indexOf(waiter);
      if (idx >= 0) {
        sub.waiters.splice(idx, 1);
      }
      resolve([]);
    }, Math.max(0, timeoutMs));

    sub.waiters.push(waiter);
  });
}

export function purgeExpiredSubscriptions() {
  const now = Date.now();
  activeSubscriptions.forEach((sub, id) => {
    if (now > sub.expiresAt) {
      sub.waiters.splice(0).forEach((waiter) => waiter.resolve([]));
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
    notifyWaiters(sub);
  });
}
