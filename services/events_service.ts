///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';

const NAMESPACE = 'http://www.onvif.org/ver10/events/wsdl';
const PATH = '/onvif/events_service';

const utils = Utils.utils;

class EventsService extends SoapService {
  events_service: any;

  constructor(config: rposConfig, server: Server) {
    super(config, server);

    this.events_service = require('./stubs/events_service.js').EventsService;

    this.serviceOptions = {
      path: EventsService.path,
      services: this.events_service,
      xml: fs.readFileSync('./wsdl/onvif/wsdl/event.wsdl', 'utf8'),
      uri: 'wsdl/onvif/wsdl/event.wsdl',
      callback: () => console.log('events_service started')
    };

    this.extendService();
  }

  static get namespace() {
    return NAMESPACE;
  }

  static get path() {
    return PATH;
  }

  extendService() {
    const service = this.events_service.EventsService;
    const eventPort = service.EventPort;
    const pullPoint = service.PullPointSubscription;
    const subscriptionManager = service.SubscriptionManager;
    const notificationProducer = service.NotificationProducer;

    eventPort.GetServiceCapabilities = () => {
      return {
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
      };
    };

    eventPort.CreatePullPointSubscription = () => {
      const termination = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return {
        SubscriptionReference: {
          'wsa:Address': `http://${utils.getIpAddress()}:${this.config.ServicePort}${EventsService.path}`,
          'wsa:ReferenceParameters': {}
        },
        'wsnt:CurrentTime': new Date().toISOString(),
        'wsnt:TerminationTime': termination
      };
    };

    eventPort.GetEventProperties = () => {
      return {
        TopicNamespaceLocation: [],
        FixedTopicSet: true,
        TopicSet: {},
        TopicExpressionDialect: [
          'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete'
        ],
        MessageContentFilterDialect: [],
        ProducerPropertiesFilterDialect: [],
        MessageContentSchemaLocation: []
      };
    };

    eventPort.AddEventBroker = () => ({ });
    eventPort.DeleteEventBroker = () => ({ });
    eventPort.GetEventBrokers = () => ({ EventBroker: [] });

    pullPoint.PullMessages = (args: any) => {
      return {
        CurrentTime: new Date().toISOString(),
        TerminationTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        'wsnt:NotificationMessage': []
      };
    };

    pullPoint.Seek = () => ({});
    pullPoint.SetSynchronizationPoint = () => ({});
    pullPoint.Unsubscribe = () => ({});

    subscriptionManager.Renew = () => ({
      'wsnt:TerminationTime': new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    subscriptionManager.Unsubscribe = () => ({ });

    notificationProducer.Subscribe = () => {
      const termination = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return {
        SubscriptionReference: {
          'wsa:Address': `http://${utils.getIpAddress()}:${this.config.ServicePort}${EventsService.path}`,
          'wsa:ReferenceParameters': {}
        },
        'wsnt:CurrentTime': new Date().toISOString(),
        'wsnt:TerminationTime': termination
      };
    };
  }
}

export = EventsService;
