///<reference path="../rpos.d.ts" />

import { Utils } from '../lib/utils';
import SoapService = require('../lib/SoapService');
import { Server } from 'http';
import crypto = require('crypto');
import fs = require('fs');
import EventDriver = require('../lib/event_driver');
type AlarmInputChannel = EventDriver.AlarmInputChannel;

const utils = Utils.utils;

type NotificationMessage = {
  Topic: any;
  ProducerReference?: any;
  Message: any;
};

type PullPointSubscription = {
  id: string;
  terminationTime: Date;
  queue: NotificationMessage[];
  consumerUrl?: string;
};

class EventsService extends SoapService {
  private subscriptions: Map<string, PullPointSubscription> = new Map();
  private defaultTerminationSeconds = 15 * 60; // 15 minutes
  private motionState: boolean | null = null;
  private alarmInputs: AlarmInputChannel[] = [];
  private eventDriver?: EventDriver;

  constructor(config: rposConfig, server: Server, eventDriver?: EventDriver) {
    super(config, server);

    this.serviceOptions = {
      path: '/onvif/events_service',
      services: this.buildServiceDefinition(),
      xml: fs.readFileSync('./wsdl/event_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/event_service.wsdl',
      onReady: () => utils.log.info('events_service started')
    };

    this.eventDriver = eventDriver;
    if (this.eventDriver) {
      this.alarmInputs = this.eventDriver.getAlarmInputs();
      this.eventDriver.onAlarmStateChanged((channelId, isActive) => this.publishAlarmState(channelId, isActive));
      this.eventDriver.start();
    }
  }

  public publishMotionState(isActive: boolean) {
    if (this.motionState === isActive) return;
    this.motionState = isActive;
    this.broadcastNotification(this.createSimpleNotification(
      'tns1:RuleEngine/CellMotionDetector/Motion',
      'IsMotion',
      isActive
    ));
  }

  public publishAlarmState(channelId: string, isActive: boolean) {
    const channel = this.alarmInputs.find((input) => input.id === channelId);
    if (!channel) return;
    channel.state = isActive;
    this.broadcastNotification(this.createSimpleNotification(
      'tns1:Device/Trigger/DigitalInput',
      'IsActive',
      isActive,
      channelId
    ));
  }

  public getMotionCallback(): (state: boolean) => void {
    return (state: boolean) => this.publishMotionState(state);
  }

  private buildServiceDefinition() {
    const service: any = { EventsService: { EventsPort: {} } };
    const port = service.EventsService.EventsPort;

    port.GetServiceCapabilities = () => {
      return {
        Capabilities: {
          attributes: { xmlns: 'http://www.onvif.org/ver10/events/wsdl' },
          WSSubscriptionPolicySupport: false,
          WSPullPointSupport: true,
          WSPausableSubscriptionManagerInterfaceSupport: false
        }
      };
    };

    port.GetEventProperties = () => {
      return {
        TopicNamespaceLocation: 'http://www.onvif.org/onvif/ver10/topics',
        TopicSet: {
          attributes: {
            'xmlns:tns1': 'http://www.onvif.org/ver10/topics'
          },
          'tns1:RuleEngine': {
            'tns1:CellMotionDetector': {
              'tns1:Motion': {
                attributes: { PropertyOperation: 'Changed' },
                $value: ''
              }
            }
          },
          'tns1:Device': {
            'tns1:Trigger': {
              'tns1:DigitalInput': {
                attributes: { PropertyOperation: 'Changed' },
                $value: ''
              }
            }
          }
        },
        FixedTopicSet: true,
        TopicExpressionDialect: 'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete',
        MessageContentFilterDialect: 'http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter'
      };
    };

    port.CreatePullPointSubscription = (args: any) => {
      const { terminationTime, id } = this.createSubscription(args?.InitialTerminationTime);
      const response: any = {
        SubscriptionReference: {
          Address: `http://${utils.getIpAddress()}:${this.config.ServicePort}/onvif/events_service/subscription/${id}`,
          ReferenceParameters: { SubscriptionId: id }
        },
        CurrentTime: new Date().toISOString(),
        TerminationTime: terminationTime.toISOString()
      };
      this.enqueueCurrentStates(id);

      return response;
    };

    port.Subscribe = (args: any) => {
      const consumerUrl = args?.ConsumerReference?.Address;
      const { terminationTime, id } = this.createSubscription(args?.InitialTerminationTime, consumerUrl);
      this.enqueueCurrentStates(id);
      return {
        SubscriptionReference: {
          Address: `http://${utils.getIpAddress()}:${this.config.ServicePort}/onvif/events_service/subscription/${id}`,
          ReferenceParameters: { SubscriptionId: id }
        },
        CurrentTime: new Date().toISOString(),
        TerminationTime: terminationTime.toISOString()
      };
    };

    port.PullMessages = (args: any) => {
      const messageLimit = args?.MessageLimit ? parseInt(args.MessageLimit, 10) : 10;
      const subscription = this.getSubscription(args?.SubscriptionId);
      if (!subscription) {
        return {
          CurrentTime: new Date().toISOString(),
          TerminationTime: new Date(0).toISOString(),
          NotificationMessage: []
        };
      }

      this.cleanupExpiredSubscriptions();

      const messages = subscription.queue.splice(0, Math.max(1, messageLimit));
      return {
        CurrentTime: new Date().toISOString(),
        TerminationTime: subscription.terminationTime.toISOString(),
        NotificationMessage: messages
      };
    };

    port.Renew = (args: any) => {
      const subscription = this.getSubscription(args?.SubscriptionId);
      if (!subscription) return { TerminationTime: new Date(0).toISOString() };

      subscription.terminationTime = this.calculateTermination(args?.TerminationTime);
      return { TerminationTime: subscription.terminationTime.toISOString() };
    };

    port.Unsubscribe = (args: any) => {
      const id = args?.SubscriptionId;
      if (id) this.subscriptions.delete(id);
      return {};
    };

    port.SetSynchronizationPoint = () => {
      return {};
    };

    return service;
  }

  private createSubscription(initialTermination?: string, consumerUrl?: string) {
    const id = crypto.randomBytes(8).toString('hex');
    const terminationTime = this.calculateTermination(initialTermination);
    this.subscriptions.set(id, { id, terminationTime, queue: [], consumerUrl });
    return { id, terminationTime };
  }

  private enqueueCurrentStates(subscriptionId: string) {
    if (this.motionState !== null) {
      this.enqueueInitialState(
        subscriptionId,
        this.createSimpleNotification('tns1:RuleEngine/CellMotionDetector/Motion', 'IsMotion', this.motionState)
      );
    }
    this.alarmInputs
      .filter((input) => input.state !== null)
      .forEach((input) =>
        this.enqueueInitialState(
          subscriptionId,
          this.createSimpleNotification('tns1:Device/Trigger/DigitalInput', 'IsActive', !!input.state, input.id)
        )
      );
  }

  private calculateTermination(requested?: string): Date {
    if (requested) {
      const duration = this.parseDuration(requested);
      if (duration > 0) {
        return new Date(Date.now() + duration * 1000);
      }
      const asDate = new Date(requested);
      if (!isNaN(asDate.getTime())) return asDate;
    }
    return new Date(Date.now() + this.defaultTerminationSeconds * 1000);
  }

  private parseDuration(value: string): number {
    try {
      if (!value) return 0;
      if (value.startsWith('PT') && value.endsWith('S')) {
        return parseInt(value.replace('PT', '').replace('S', ''), 10);
      }
      if (value.startsWith('PT') && value.endsWith('M')) {
        const minutes = parseInt(value.replace('PT', '').replace('M', ''), 10);
        return minutes * 60;
      }
      if (value.startsWith('PT') && value.endsWith('H')) {
        const hours = parseInt(value.replace('PT', '').replace('H', ''), 10);
        return hours * 60 * 60;
      }
    } catch (err) {
      utils.log.debug('Failed to parse duration %s', value);
    }
    return 0;
  }

  private getSubscription(requestedId?: string): PullPointSubscription | undefined {
    this.cleanupExpiredSubscriptions();
    if (requestedId && this.subscriptions.has(requestedId)) {
      return this.subscriptions.get(requestedId);
    }
    if (this.subscriptions.size === 1) {
      return Array.from(this.subscriptions.values())[0];
    }
    return undefined;
  }

  private cleanupExpiredSubscriptions() {
    const now = Date.now();
    this.subscriptions.forEach((subscription, id) => {
      if (subscription.terminationTime.getTime() < now) {
        this.subscriptions.delete(id);
      }
    });
  }

  private enqueueInitialState(id: string, message: NotificationMessage) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    subscription.queue.push(message);
    if (subscription.consumerUrl) {
      this.notifyConsumer(subscription, [message]);
    }
  }

  private broadcastNotification(message: NotificationMessage) {
    this.cleanupExpiredSubscriptions();
    this.subscriptions.forEach((subscription) => {
      subscription.queue.push(message);
      if (subscription.consumerUrl) {
        this.notifyConsumer(subscription, [message]);
      }
    });
  }

  private notifyConsumer(subscription: PullPointSubscription, messages: NotificationMessage[]) {
    const url = subscription.consumerUrl;
    if (!url) return;
    try {
      const target = new URL(url);
      const body = this.buildNotifyEnvelope(subscription.id, url, messages);
      const isHttps = target.protocol === 'https:';
      const requestImpl = isHttps ? require('https') : require('http');
      const options = {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = requestImpl.request(options, (res: any) => {
        res.on('data', () => {});
      });
      req.on('error', (err: any) => {
        utils.log.debug('Failed to notify consumer %s: %s', url, err.message);
      });
      req.write(body);
      req.end();
    } catch (err) {
      utils.log.debug('Failed to notify consumer %s: %s', url, (<any>err)?.message || err);
    }
  }

  private buildNotifyEnvelope(subscriptionId: string, consumerUrl: string, messages: NotificationMessage[]): string {
    const messageXml = messages.map((msg) => this.notificationMessageToXml(msg)).join('');
    const messageId = `uuid:${crypto.randomBytes(16).toString('hex')}`;
    const serviceUrl = this.config.ServiceUrl || `http://${utils.getIpAddress()}:${this.config.ServicePort}`;

    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:wsa="http://www.w3.org/2005/08/addressing">',
      '<soap:Header>',
      '<wsa:Action soap:mustUnderstand="1">http://docs.oasis-open.org/wsn/bw-2/NotificationConsumer/Notify</wsa:Action>',
      `<wsa:MessageID>${messageId}</wsa:MessageID>`,
      `<wsa:To soap:mustUnderstand="1">${utils.xmlEncode(consumerUrl)}</wsa:To>`,
      '<wsnt:SubscriptionReference>',
      `<wsa:Address>${utils.xmlEncode(serviceUrl)}/onvif/events_service/subscription/${subscriptionId}</wsa:Address>`,
      `<wsa:ReferenceParameters><wsnt:SubscriptionId>${subscriptionId}</wsnt:SubscriptionId></wsa:ReferenceParameters>`,
      '</wsnt:SubscriptionReference>',
      '</soap:Header>',
      '<soap:Body>',
      '<wsnt:Notify>',
      messageXml,
      '</wsnt:Notify>',
      '</soap:Body>',
      '</soap:Envelope>'
    ].join('');
  }

  private notificationMessageToXml(msg: NotificationMessage): string {
    const topicDialect = msg.Topic?.attributes?.Dialect || '';
    const topicValue = msg.Topic?.$value || '';
    const message = (msg as any).Message?.Message || {};
    const attributes = message.attributes || {};
    const utcTime = attributes.UtcTime || new Date().toISOString();
    const propertyOperation = attributes.PropertyOperation || 'Changed';
    const sourceItem = message.Source?.SimpleItem;
    const dataItem = message.Data?.SimpleItem;

    const sourceXml = sourceItem
      ? `<tt:SimpleItem Name="${sourceItem.attributes?.Name}" Value="${sourceItem.attributes?.Value}" />`
      : '';
    const dataXml = dataItem
      ? `<tt:SimpleItem Name="${dataItem.attributes?.Name}" Value="${dataItem.attributes?.Value}" />`
      : '';

    return [
      '<wsnt:NotificationMessage>',
      `<wsnt:Topic Dialect="${topicDialect}">${topicValue}</wsnt:Topic>`,
      '<wsnt:Message>',
      `<tt:Message UtcTime="${utcTime}" PropertyOperation="${propertyOperation}">`,
      sourceXml ? `<tt:Source>${sourceXml}</tt:Source>` : '',
      `<tt:Data>${dataXml}</tt:Data>`,
      '</tt:Message>',
      '</wsnt:Message>',
      '</wsnt:NotificationMessage>'
    ].join('');
  }

  private createSimpleNotification(topic: string, stateName: string, isActive: boolean, sourceId?: string): NotificationMessage {
    const now = new Date().toISOString();
    const source = sourceId
      ? {
          SimpleItem: {
            attributes: {
              Name: 'InputToken',
              Value: sourceId
            }
          }
        }
      : {};
    return {
      Topic: {
        attributes: {
          Dialect: 'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete'
        },
        $value: topic
      },
      Message: {
        Message: {
          attributes: {
            UtcTime: now,
            PropertyOperation: 'Changed'
          },
          Source: source,
          Data: {
            SimpleItem: {
              attributes: {
                Name: stateName,
                Value: isActive ? 'true' : 'false'
              }
            }
          }
        }
      }
    };
  }
}

export = EventsService;
