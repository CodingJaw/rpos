///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import {
  SUBSCRIPTION_DEFAULT_TTL_MS,
  createSubscription,
  getSubscription,
  purgeExpiredSubscriptions,
} from './eventing';

var utils = Utils.utils;

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
      const { id, expiresAt } = createSubscription(SUBSCRIPTION_DEFAULT_TTL_MS);

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
      utils.log.info('Subscribe requested but not supported; returning fault');
      throw {
        Fault: {
          Code: {
            Value: 'soap:Sender',
            Subcode: { value: 'wsnt:ResourceUnknown' },
          },
          Reason: {
            Text: 'Subscribe is not supported; use CreatePullPointSubscription',
          },
        },
      };
    };
  }
}

export = EventService;
