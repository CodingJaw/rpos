///<reference path="../rpos.d.ts" />

import fs = require("fs");
import url = require('url');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';

var utils = Utils.utils;

interface SubscriptionState {
  id: string;
  createdAt: Date;
  terminationTime: Date;
  messageQueue: any[];
  syncPointTime?: Date;
  syncPointPending?: boolean;
}

interface SimpleItemEntry {
  Name: string;
  Value: string | number | boolean;
}

class EventService extends SoapService {
  event_service: any;
  subscriptions: Map<string, SubscriptionState>;
  nextSubscriptionId: number;

  constructor(config: rposConfig, server: Server) {
    super(config, server);

    this.event_service = require('./stubs/event_service.js').EventService;
    this.subscriptions = new Map<string, SubscriptionState>();
    this.nextSubscriptionId = 1;

    this.serviceOptions = {
      path: '/onvif/event_service',
      services: this.event_service,
      xml: fs.readFileSync('./wsdl/onvif/services/event_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/onvif/services/event_service.wsdl',
      onReady: () => utils.log.info('event_service started')
    };

    this.extendService();
  }

  extendService() {
    var eventPort = this.event_service.EventService.EventPort;
    var pullPoint = this.event_service.EventService.PullPointSubscription;
    var subscriptionManager = this.event_service.EventService.SubscriptionManager;
    var notificationProducer = this.event_service.EventService.NotificationProducer;

    eventPort.GetServiceCapabilities = (args /*, cb, headers, req*/) => {
      return {
        Capabilities: {
          attributes: {
            WSSubscriptionPolicySupport: true,
            WSPullPointSupport: true,
            WSPausableSubscriptionManagerInterfaceSupport: false,
            MaxNotificationProducers: 1,
            MaxPullPoints: 32,
            PersistentNotificationStorage: false
          }
        }
      };
    };

    eventPort.CreatePullPointSubscription = (args /*, cb, headers, req*/) => {
      var terminationTime = this.validatePullPointSubscriptionRequest(args);
      var subscription = this.createSubscription(args, terminationTime);
      return this.buildSubscriptionResponse(subscription);
    };

    eventPort.GetEventProperties = (args /*, cb, headers, req*/) => {
      return this.buildEventPropertiesResponse();
    };

    eventPort.AddEventBroker = (args /*, cb, headers, req*/) => {
      return {};
    };

    eventPort.DeleteEventBroker = (args /*, cb, headers, req*/) => {
      return {};
    };

    eventPort.GetEventBrokers = (args /*, cb, headers, req*/) => {
      return { EventBroker: [] };
    };

    pullPoint.PullMessages = (args, cb, headers, req) => {
      var subscription = this.resolveSubscription(headers, req);
      return this.buildPullMessagesResponse(subscription, args);
    };

    pullPoint.Seek = (args, cb, headers, req) => {
      return {};
    };

    pullPoint.SetSynchronizationPoint = (args, cb, headers, req) => {
      var subscription = this.resolveSubscription(headers, req);
      this.markSynchronizationPoint(subscription);
      return {};
    };

    pullPoint.Unsubscribe = (args, cb, headers, req) => {
      var subscription = this.resolveSubscription(headers, req);
      this.subscriptions.delete(subscription.id);
      return {};
    };

    notificationProducer.Subscribe = (args /*, cb, headers, req*/) => {
      var subscription = this.createSubscription(args);
      return this.buildSubscriptionResponse(subscription);
    };

    notificationProducer.GetCurrentMessage = (args /*, cb, headers, req*/) => {
      return {};
    };

    subscriptionManager.Renew = (args, cb, headers, req) => {
      var subscription = this.resolveSubscription(headers, req);
      var terminationTime = this.resolveTerminationTime(args, new Date());
      subscription.terminationTime = terminationTime;
      return {
        TerminationTime: terminationTime.toISOString(),
        CurrentTime: new Date().toISOString()
      };
    };

    subscriptionManager.Unsubscribe = (args, cb, headers, req) => {
      var subscription = this.resolveSubscription(headers, req);
      this.subscriptions.delete(subscription.id);
      return {};
    };
  }

  createSubscription(args: any, terminationTimeOverride?: Date): SubscriptionState {
    var id = 'sub-' + this.nextSubscriptionId++;
    var now = new Date();
    var terminationTime = terminationTimeOverride || this.resolveTerminationTime(args, now);
    var subscription: SubscriptionState = {
      id: id,
      createdAt: now,
      terminationTime: terminationTime,
      messageQueue: []
    };
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  resolveSubscription(headers: any, req: any): SubscriptionState {
    var subscriptionId = this.extractSubscriptionId(headers, req);
    if (subscriptionId && this.subscriptions.has(subscriptionId)) {
      return this.subscriptions.get(subscriptionId);
    }

    if (!subscriptionId && this.subscriptions.size === 1) {
      return Array.from(this.subscriptions.values())[0];
    }

    if (subscriptionId) {
      var now = new Date();
      var fallback: SubscriptionState = {
        id: subscriptionId,
        createdAt: now,
        terminationTime: this.defaultTerminationTime(now),
        messageQueue: []
      };
      this.subscriptions.set(subscriptionId, fallback);
      return fallback;
    }

    return this.createSubscription({});
  }

  extractSubscriptionId(headers: any, req: any): string {
    if (req && req.url) {
      var parsed = url.parse(req.url, true);
      if (parsed.query && typeof parsed.query.subscription === 'string') {
        return parsed.query.subscription;
      }
    }

    if (headers && headers.SubscriptionReference && headers.SubscriptionReference.ReferenceParameters) {
      var refId = headers.SubscriptionReference.ReferenceParameters.SubscriptionId;
      if (typeof refId === 'string') {
        return refId;
      }
    }

    if (headers && headers.ReferenceParameters && typeof headers.ReferenceParameters.SubscriptionId === 'string') {
      return headers.ReferenceParameters.SubscriptionId;
    }

    if (headers && typeof headers.SubscriptionId === 'string') {
      return headers.SubscriptionId;
    }

    return null;
  }

  buildSubscriptionResponse(subscription: SubscriptionState) {
    return {
      SubscriptionReference: this.buildSubscriptionReference(subscription.id),
      CurrentTime: new Date().toISOString(),
      TerminationTime: subscription.terminationTime.toISOString()
    };
  }

  buildSubscriptionReference(subscriptionId: string) {
    return {
      Address: this.buildSubscriptionAddress(subscriptionId),
      ReferenceParameters: {
        SubscriptionId: subscriptionId
      }
    };
  }

  buildSubscriptionAddress(subscriptionId: string): string {
    return 'http://' + utils.getIpAddress() + ':' + this.config.ServicePort + '/onvif/event_service?subscription=' + subscriptionId;
  }

  buildPullMessagesResponse(subscription: SubscriptionState, args: any) {
    if (subscription.syncPointPending) {
      subscription.syncPointPending = false;
      subscription.messageQueue.push(this.buildSynchronizationPointMessage(subscription));
    }

    var limit = 0;
    if (args && args.MessageLimit !== undefined) {
      limit = Number(args.MessageLimit);
    }
    if (!limit || isNaN(limit) || limit < 0) {
      limit = subscription.messageQueue.length;
    }

    var messages = subscription.messageQueue.splice(0, limit);
    return {
      CurrentTime: new Date().toISOString(),
      TerminationTime: subscription.terminationTime.toISOString(),
      NotificationMessage: messages
    };
  }

  markSynchronizationPoint(subscription: SubscriptionState) {
    subscription.syncPointTime = new Date();
    subscription.syncPointPending = true;
  }

  buildSynchronizationPointMessage(subscription: SubscriptionState) {
    var now = new Date();
    return {
      SubscriptionReference: this.buildSubscriptionReference(subscription.id),
      Topic: {
        attributes: {
          Dialect: 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet'
        },
        $value: 'tns1:SynchronizationPoint'
      },
      Message: {
        attributes: {
          UtcTime: now.toISOString()
        },
        Data: {
          SimpleItem: [
            {
              attributes: {
                Name: 'SynchronizationPoint',
                Value: 'true'
              }
            }
          ]
        }
      }
    };
  }

  buildEventPropertiesResponse() {
    return {
      TopicNamespaceLocation: [
        'http://www.onvif.org/ver10/topics'
      ],
      FixedTopicSet: true,
      TopicSet: this.buildTopicSet(),
      TopicExpressionDialect: this.getSupportedTopicExpressionDialects(),
      MessageContentSchemaLocation: [
        'http://www.onvif.org/ver10/schema/onvif.xsd'
      ]
    };
  }

  buildTopicSet() {
    return {
      attributes: {
        'xmlns:tns1': 'http://www.onvif.org/ver10/topics'
      },
      'tns1:Device': {
        'tns1:Trigger': {},
        'tns1:Output': {}
      },
      'tns1:RuleEngine': {
        'tns1:Motion': {},
        'tns1:CellMotionDetector': {
          'tns1:Motion': {}
        }
      },
      'tns1:SynchronizationPoint': {}
    };
  }

  publishSimpleEvent(topic: string, dataItems: SimpleItemEntry[], sourceItems?: SimpleItemEntry[]) {
    var subscriptions = Array.from(this.subscriptions.values());
    for (var i = 0; i < subscriptions.length; i++) {
      subscriptions[i].messageQueue.push(
        this.buildNotificationMessage(subscriptions[i], topic, dataItems, sourceItems)
      );
    }
  }

  buildNotificationMessage(subscription: SubscriptionState, topic: string, dataItems: SimpleItemEntry[], sourceItems?: SimpleItemEntry[]) {
    var now = new Date();
    var message: any = {
      SubscriptionReference: this.buildSubscriptionReference(subscription.id),
      Topic: {
        attributes: {
          Dialect: 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet'
        },
        $value: topic
      },
      Message: {
        attributes: {
          UtcTime: now.toISOString()
        },
        Data: {
          SimpleItem: dataItems.map(item => {
            return {
              attributes: {
                Name: item.Name,
                Value: String(item.Value)
              }
            };
          })
        }
      }
    };

    if (sourceItems && sourceItems.length > 0) {
      message.Message.Source = {
        SimpleItem: sourceItems.map(item => {
          return {
            attributes: {
              Name: item.Name,
              Value: String(item.Value)
            }
          };
        })
      };
    }

    return message;
  }

  resolveTerminationTime(args: any, fallbackBase: Date): Date {
    var requested = null;
    if (args) {
      requested = args.InitialTerminationTime || args.TerminationTime || args.Expires || args.ExpiresAt;
    }
    if (requested) {
      var resolved = this.parseAbsoluteOrRelativeTime(requested, fallbackBase);
      if (resolved) {
        return resolved;
      }
    }
    return this.defaultTerminationTime(fallbackBase);
  }

  defaultTerminationTime(base: Date): Date {
    return new Date(base.getTime() + 60 * 60 * 1000);
  }

  parseAbsoluteOrRelativeTime(value: any, base: Date): Date {
    if (value instanceof Date) {
      return new Date(value.getTime());
    }

    var raw = value;
    if (value && typeof value === 'object' && typeof value.$value === 'string') {
      raw = value.$value;
    }

    if (typeof raw === 'string') {
      var trimmed = raw.trim();
      if (trimmed.startsWith('P')) {
        var durationMs = this.parseDurationToMs(trimmed);
        if (durationMs !== null) {
          return new Date(base.getTime() + durationMs);
        }
      }
      var parsedDate = new Date(trimmed);
      if (!isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    return null;
  }

  parseDurationToMs(value: string): number {
    var match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value);
    if (!match) {
      return null;
    }
    var days = match[1] ? parseInt(match[1], 10) : 0;
    var hours = match[2] ? parseInt(match[2], 10) : 0;
    var minutes = match[3] ? parseInt(match[3], 10) : 0;
    var seconds = match[4] ? parseInt(match[4], 10) : 0;
    return ((days * 24 + hours) * 60 + minutes) * 60 * 1000 + seconds * 1000;
  }

  validatePullPointSubscriptionRequest(args: any): Date {
    this.validateFilter(args && args.Filter);
    this.validateTopicExpressionDialects(args);

    var now = new Date();
    if (args && Object.prototype.hasOwnProperty.call(args, 'InitialTerminationTime')) {
      var requested = args.InitialTerminationTime;
      if (requested && typeof requested === 'object') {
        if (requested.$value === null || requested.$value === undefined) {
          return this.defaultTerminationTime(now);
        }
        if (requested.attributes && requested.attributes['xsi:nil'] === 'true') {
          return this.defaultTerminationTime(now);
        }
      }

      if (requested !== null && requested !== undefined) {
        var resolved = this.parseAbsoluteOrRelativeTime(requested, now);
        if (!resolved) {
          throw this.buildWsntFault('UnacceptableInitialTerminationTimeFault');
        }
        return resolved;
      }
    }

    return this.defaultTerminationTime(now);
  }

  validateFilter(filter: any) {
    if (filter === null || filter === undefined) {
      return;
    }

    if (typeof filter !== 'object') {
      throw this.buildWsntFault('InvalidFilterFault', {
        'wsnt:InvalidFilterFault': {
          UnknownFilter: ['Filter']
        }
      });
    }

    var topicExpressions = this.extractTopicExpressions(filter);
    var unknownFilters = this.extractUnknownFilterKeys(filter);
    if (unknownFilters.length > 0) {
      throw this.buildWsntFault('InvalidFilterFault', {
        'wsnt:InvalidFilterFault': {
          UnknownFilter: unknownFilters
        }
      });
    }

    for (var i = 0; i < topicExpressions.length; i++) {
      this.validateTopicExpression(topicExpressions[i]);
    }
  }

  extractTopicExpressions(filter: any): any[] {
    var expressions: any[] = [];
    var topicExpression = filter.TopicExpression || filter['wsnt:TopicExpression'];
    if (topicExpression !== undefined) {
      if (Array.isArray(topicExpression)) {
        expressions = expressions.concat(topicExpression);
      } else {
        expressions.push(topicExpression);
      }
    }
    return expressions;
  }

  extractUnknownFilterKeys(filter: any): string[] {
    var unknown: string[] = [];
    var keys = Object.keys(filter);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === 'TopicExpression' || key === 'wsnt:TopicExpression' || key === 'attributes' || key === '$value') {
        continue;
      }
      unknown.push(key);
    }
    return unknown;
  }

  validateTopicExpression(expression: any) {
    var parsed = this.parseTopicExpression(expression);
    if (!parsed.dialect) {
      throw this.buildWsntFault('InvalidTopicExpressionFault');
    }

    if (!this.getSupportedTopicExpressionDialects().includes(parsed.dialect)) {
      throw this.buildWsntFault('TopicExpressionDialectUnknownFault');
    }

    if (!parsed.value) {
      throw this.buildWsntFault('InvalidTopicExpressionFault');
    }
  }

  parseTopicExpression(expression: any) {
    if (expression === null || expression === undefined) {
      return { dialect: null, value: null };
    }

    var dialect = null;
    var value: any = expression;
    if (typeof expression === 'object') {
      if (expression.attributes && expression.attributes.Dialect) {
        dialect = expression.attributes.Dialect;
      } else if (expression.Dialect) {
        dialect = expression.Dialect;
      }

      if (expression.$value !== undefined) {
        value = expression.$value;
      } else if (expression.Value !== undefined) {
        value = expression.Value;
      }
    }

    if (typeof value === 'object') {
      value = null;
    }

    if (typeof value === 'string') {
      value = value.trim();
    }

    return {
      dialect: dialect,
      value: value
    };
  }

  validateTopicExpressionDialects(args: any) {
    if (!args || args.TopicExpressionDialect === undefined || args.TopicExpressionDialect === null) {
      return;
    }

    var dialects = Array.isArray(args.TopicExpressionDialect)
      ? args.TopicExpressionDialect
      : [args.TopicExpressionDialect];
    for (var i = 0; i < dialects.length; i++) {
      if (!this.getSupportedTopicExpressionDialects().includes(dialects[i])) {
        throw this.buildWsntFault('TopicExpressionDialectUnknownFault');
      }
    }
  }

  getSupportedTopicExpressionDialects(): string[] {
    return [
      'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete',
      'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet'
    ];
  }

  buildWsntFault(faultName: string, detail?: any) {
    return {
      Fault: {
        attributes: {
          'xmlns:wsnt': 'http://docs.oasis-open.org/wsn/b-2'
        },
        Code: {
          Value: 'soap:Sender',
          Subcode: {
            Value: 'wsnt:' + faultName
          }
        },
        Reason: {
          Text: {
            attributes: {
              'xml:lang': 'en'
            },
            $value: faultName
          }
        },
        Detail: detail || {
          ['wsnt:' + faultName]: {}
        }
      }
    };
  }
}

export = EventService;
