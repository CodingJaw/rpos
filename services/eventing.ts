import { Utils } from '../lib/utils';
import http = require('http');
import https = require('https');
import { URL } from 'url';
import { Builder } from 'xml2js';

const utils = Utils.utils;

const xmlBuilder = new Builder({ headless: true });

export const SUBSCRIPTION_DEFAULT_TTL_MS = 10000;
export const MAX_PUSH_QUEUE = 50;

export type SubscriptionDeliveryMode = 'pull' | 'push';

export type PendingPull = {
  messageLimit?: number;
  resolve: (messages: any[]) => void;
};

export type NotificationMessage = {
  Topic: any;
  Message: any;
};

export type SubscriptionState = {
  expiresAt: number;
  queue: NotificationMessage[];
  waiters: PendingPull[];
  mode: SubscriptionDeliveryMode;
  consumerUrl?: string;
  dispatching?: boolean;
};

export const activeSubscriptions = new Map<string, SubscriptionState>();

export function createSubscriptionWithExpiration(
  expiresAt: number,
  mode: SubscriptionDeliveryMode = 'pull',
  consumerUrl?: string,
) {
  const id = 'sub-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  activeSubscriptions.set(id, { expiresAt, queue: [], waiters: [], mode, consumerUrl, dispatching: false });
  return { id, expiresAt };
}

export function createSubscription(ttlMs: number = SUBSCRIPTION_DEFAULT_TTL_MS, mode: SubscriptionDeliveryMode = 'pull') {
  return createSubscriptionWithExpiration(Date.now() + ttlMs, mode);
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

export function renewSubscriptionExpiration(id: string, newExpiration: number) {
  const sub = activeSubscriptions.get(id);
  if (!sub) {
    return undefined;
  }

  sub.expiresAt = newExpiration;
  return sub;
}

export function deleteSubscription(id: string) {
  const sub = activeSubscriptions.get(id);
  if (!sub) {
    return false;
  }

  sub.waiters.splice(0).forEach((waiter) => waiter.resolve([]));
  activeSubscriptions.delete(id);
  return true;
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
  const utcNow = new Date().toISOString();

  const topic = {
    _: 'tns1:Device/Trigger/DigitalInput',
    $: {
      Dialect: 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet',
    },
  };

  const message = {
    'tt:Message': {
      $: {
        UtcTime: utcNow,
        PropertyOperation: 'Changed',
      },
      Source: {
        'tt:SimpleItem': [
          {
            $: {
              Name: 'InputToken',
              Value: String(channel),
            },
          },
        ],
      },
      Data: {
        'tt:SimpleItem': [
          {
            $: {
              Name: 'LogicalState',
              Value: value,
            },
          },
        ],
      },
    },
  };

  const notification: NotificationMessage = {
    Topic: topic,
    Message: message,
  };

  activeSubscriptions.forEach((sub, id) => {
    if (Date.now() > sub.expiresAt) {
      activeSubscriptions.delete(id);
      return;
    }

    utils.log.debug('Queueing input event for subscription %s', id);
    sub.queue.push(notification);

    if (sub.mode === 'pull') {
      notifyWaiters(sub);
    } else {
      dispatchPushQueue(id, sub);
    }

    if (sub.mode === 'push' && sub.queue.length > MAX_PUSH_QUEUE) {
      sub.queue.splice(0, sub.queue.length - MAX_PUSH_QUEUE);
      utils.log.warn('Push queue trimmed for subscription %s due to size limits', id);
    }
  });
}

function buildNotificationEnvelope(notification: NotificationMessage) {
  return {
    's:Envelope': {
      $: {
        'xmlns:s': 'http://www.w3.org/2003/05/soap-envelope',
        'xmlns:wsnt': 'http://docs.oasis-open.org/wsn/b-2',
        'xmlns:tt': 'http://www.onvif.org/ver10/schema',
        'xmlns:wsa5': 'http://www.w3.org/2005/08/addressing',
        'xmlns:tns1': 'http://www.onvif.org/ver10/topics',
      },
      's:Body': {
        'wsnt:Notify': {
          'wsnt:NotificationMessage': {
            'wsnt:Topic': notification.Topic,
            'wsnt:Message': notification.Message,
          },
        },
      },
    },
  };
}

function sendHttpPost(urlString: string, body: string) {
  return new Promise<void>((resolve, reject) => {
    try {
      const parsed = new URL(urlString);
      const transport = parsed.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + (parsed.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 5000,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        },
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP request timed out'));
      });

      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function dispatchPushQueue(id: string, sub: SubscriptionState) {
  if (sub.mode !== 'push' || !sub.consumerUrl) {
    return;
  }

  if (sub.dispatching) {
    return;
  }

  sub.dispatching = true;

  try {
    while (sub.queue.length > 0) {
      const next = sub.queue.shift();
      if (!next) {
        break;
      }

      try {
        const envelope = buildNotificationEnvelope(next);
        const xml = xmlBuilder.buildObject(envelope);
        utils.log.debug('Sending push notification to %s for subscription %s', sub.consumerUrl, id);
        await sendHttpPost(sub.consumerUrl, xml);
      } catch (err) {
        utils.log.warn('Failed to send push notification to %s: %s', sub.consumerUrl, err?.message || err);
      }
    }
  } finally {
    sub.dispatching = false;
  }
}
